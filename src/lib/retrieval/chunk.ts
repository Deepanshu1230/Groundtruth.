import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { z } from "zod";
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
    case "fixed":
    case "semantic":
      throw new Error(`Chunking strategy "${strategy}" is not implemented`);
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

// Consecutive chunks share up to CHUNK_OVERLAP characters; append `next` without repeating them.
// Matches shorter than 20 chars are likely coincidence ("...the" / "the..."), so they don't count.
function mergeOverlapping(previous: string, next: string): string {
  for (let k = Math.min(previous.length, next.length, CHUNK_OVERLAP); k >= 20; k--) {
    if (previous.endsWith(next.slice(0, k))) return previous + next.slice(k);
  }
  return `${previous} ${next}`;
}
