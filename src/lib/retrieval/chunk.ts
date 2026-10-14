import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { z } from "zod";
import { embed } from "../embed";
import type { PdfPage } from "../parsePdf";

export const ChunkStrategySchema = z.enum(["recursive", "fixed", "semantic"]);
export type ChunkStrategy = z.infer<typeof ChunkStrategySchema>;

export interface TextChunk {
  page: number;
  text: string;
}

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
// ~35 words. Shorter pieces (usually a page's leftover tail) carry too little context to embed well.
export const MIN_CHUNK_CHARS = 200;

export async function chunk(pages: PdfPage[], strategy: ChunkStrategy): Promise<TextChunk[]> {
  switch (strategy) {
    case "recursive":
      return recursiveChunk(pages);
    case "semantic":
      return semanticChunk(pages);
    case "fixed":
      return chunkFixed(pages);
  }
}

async function recursiveChunk(pages: PdfPage[]): Promise<TextChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  // Split page by page so every chunk maps to exactly one page number.
  const chunks: TextChunk[] = [];
  const dropped: TextChunk[] = [];
  for (const { page, text } of pages) {
    const pieces: string[] = [];
    for (const piece of await splitter.splitText(text)) {
      if (piece.length < MIN_CHUNK_CHARS && pieces.length > 0) {
        pieces[pieces.length - 1] = mergeOverlapping(pieces[pieces.length - 1], piece); // fold into previous
      } else {
        pieces.push(piece);
      }
    }
    // A short first piece had nothing before it to join, so fold it into the next one.
    if (pieces.length > 1 && pieces[0].length < MIN_CHUNK_CHARS) {
      pieces.splice(0, 2, mergeOverlapping(pieces[0], pieces[1]));
    }
    // A page whose entire text is shorter than the minimum has nothing to merge into, so drop it.
    if (pieces.length === 1 && pieces[0].length < MIN_CHUNK_CHARS) {
      dropped.push({ page, text: pieces[0] });
      continue;
    }
    for (const piece of pieces) chunks.push({ page, text: piece });
  }
  // ...unless that would leave the document with nothing at all.
  return chunks.length > 0 ? chunks : dropped;
}

// A cut at a space may move back at most this far into the window; past that a word is split instead,
// so a long unbroken string (URL, formula) can't shrink windows to almost nothing.
const FIXED_MIN_CUT_RATIO = 0.6;

// Fixed-size character windows with `overlap` characters shared between neighbours, page by page.
export function chunkFixed(pages: PdfPage[], size = 512, overlap = 64): TextChunk[] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`size must be a positive integer, got ${size}`);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error(`overlap must be an integer in [0, size), got ${overlap}`);
  }

  const chunks: TextChunk[] = [];
  for (const { page, text } of pages) {
    // Windows are kept as offsets into the page so merging is exact. Matching text to find the
    // overlap (as mergeOverlapping does) can over-match on repetitive text and drop content.
    const windows: { start: number; end: number }[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + size, text.length);
      if (end < text.length) end = lastWhitespaceCut(text, start + Math.ceil(size * FIXED_MIN_CUT_RATIO), end);

      const length = text.slice(start, end).trim().length;
      const previous = windows.at(-1);
      if (length > 0) {
        // Fold a short window into the previous one by extending it; they overlap, so nothing repeats.
        if (length < MIN_CHUNK_CHARS && previous) previous.end = end;
        else windows.push({ start, end });
      }
      if (end >= text.length) break;
      // Always move forward, even if a small window minus the overlap would not.
      start = Math.max(end - overlap, start + 1);
    }
    // A page whose entire text is shorter than the minimum has nothing to merge into, so it stays as is.
    for (const w of windows) chunks.push({ page, text: text.slice(w.start, w.end).trim() });
  }
  return chunks;
}

// Index of the last whitespace character in [min, end], or `end` if there is none (hard cut).
function lastWhitespaceCut(text: string, min: number, end: number): number {
  for (let i = end; i >= min; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return end;
}

const SEMANTIC_MAX_CHARS = 1500;
// Neighbour similarities below this percentile of the document's own similarities start a new chunk.
// Relative rather than a fixed cutoff, because typical similarity levels vary a lot between documents.
const SEMANTIC_BREAK_PERCENTILE = 25;
// A sentence ends at . ! or ? followed by whitespace and then a capital letter or digit.
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9])/;

async function semanticChunk(pages: PdfPage[]): Promise<TextChunk[]> {
  const pageSentences = pages.map(({ page, text }) => ({ page, sentences: splitSentences(text) }));
  // One call for the whole document; embed() batches internally.
  const vectors = await embed(pageSentences.flatMap((p) => p.sentences));

  // similarities[p][i]: sentence i vs sentence i-1 on the same page. Chunks never span pages,
  // so pairs across a page break aren't compared; index 0 is a placeholder.
  let offset = 0;
  const similarities = pageSentences.map(({ sentences }) => {
    const sims = sentences.map((_, i) => (i === 0 ? NaN : cosineSimilarity(vectors[offset + i - 1], vectors[offset + i])));
    offset += sentences.length;
    return sims;
  });
  // NaN when the document has no neighbouring pairs; every `< NaN` is false, so nothing breaks on topic.
  const threshold = percentile(similarities.flatMap((sims) => sims.slice(1)), SEMANTIC_BREAK_PERCENTILE);

  const chunks: TextChunk[] = [];
  pageSentences.forEach(({ page, sentences }, p) => {
    const pieces: string[] = [];
    let current = "";
    sentences.forEach((sentence, i) => {
      const topicShift = i > 0 && similarities[p][i] < threshold;
      const tooLong = current.length + 1 + sentence.length > SEMANTIC_MAX_CHARS;
      if (current && (topicShift || tooLong)) {
        pieces.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    });
    if (current) pieces.push(current);
    for (const piece of mergeShortPieces(pieces)) chunks.push({ page, text: piece });
  });
  return chunks;
}

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_BOUNDARY)
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap(wrapLongSentence);
}

// Tables, formulas and text without punctuation can form one "sentence" longer than a whole chunk;
// cut those at word boundaries so no chunk (or embedding input) grows unbounded.
function wrapLongSentence(sentence: string): string[] {
  if (sentence.length <= SEMANTIC_MAX_CHARS) return [sentence];
  const parts: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    if (current && current.length + 1 + word.length > SEMANTIC_MAX_CHARS) {
      parts.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Pieces under MIN_CHUNK_CHARS join the previous piece on the page. A short first piece has
// no previous one, so it joins the next instead, as in recursiveChunk.
function mergeShortPieces(pieces: string[]): string[] {
  const merged: string[] = [];
  for (const piece of pieces) {
    if (piece.length < MIN_CHUNK_CHARS && merged.length > 0) merged[merged.length - 1] += ` ${piece}`;
    else merged.push(piece);
  }
  if (merged.length > 1 && merged[0].length < MIN_CHUNK_CHARS) merged.splice(0, 2, `${merged[0]} ${merged[1]}`);
  return merged;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA * normB) || 1);
}

// Linear interpolation between the closest ranks; NaN for no values.
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = ((sorted.length - 1) * p) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// Consecutive chunks share up to CHUNK_OVERLAP characters; append `next` without repeating them.
// Matches shorter than 20 chars are likely coincidence ("...the" / "the..."), so they don't count.
function mergeOverlapping(previous: string, next: string): string {
  for (let k = Math.min(previous.length, next.length, CHUNK_OVERLAP); k >= 20; k--) {
    if (previous.endsWith(next.slice(0, k))) return previous + next.slice(k);
  }
  return `${previous} ${next}`;
}
