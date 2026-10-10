import type { PdfPage } from "./parsePdf";

// Spelled out because NFKC, which would fold these too, also rewrites superscripts (10⁻⁹ -> 10-9).
const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
};

const PAGE_NUMBER_LINE = /^\d{1,4}$/;
// Repeated headers/footers are only detectable with enough pages to tell them from coincidence.
const HEADER_FOOTER_MIN_PAGES = 5;
const HEADER_FOOTER_PAGE_SHARE = 0.4; // a line on more than this share of pages is a header/footer
// Headers/footers sit in the first or last few lines of a page; mid-page repeats are body text.
const HEADER_FOOTER_EDGE_LINES = 3;
// Short or letter-poor lines ("=", "model", "(1)") repeat in math-heavy text without being headers.
const HEADER_FOOTER_MIN_CHARS = 8;
const HEADER_FOOTER_MIN_LETTERS = 4;

// Cleans text extracted from a PDF before chunking and embedding. Works on all pages at once
// because headers and footers are only recognisable across pages. Pages left empty are dropped.
export function normalizeText(pages: PdfPage[]): PdfPage[] {
  const pageLines = pages.map((p) =>
    cleanCharacters(p.text)
      .split("\n")
      .map((line) => line.trim()),
  );
  const repeated = findRepeatedLines(pageLines);

  return pages
    .map((p, i) => ({ page: p.page, text: joinLines(stripEdgeLines(pageLines[i], repeated)) }))
    .filter((p) => p.text.length > 0);
}

function cleanCharacters(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[ﬀ-ﬄ]/g, (ligature) => LIGATURES[ligature])
    .replace(/\r\n?/g, "\n")
    .replace(/[­​-‍⁠﻿]/g, "") // soft hyphens and zero-width characters
    .replace(/[\t\f\v  -   　]/g, " ") // tabs and unusual spaces
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, ""); // other control characters
}

function findRepeatedLines(pageLines: string[][]): Set<string> {
  const repeated = new Set<string>();
  if (pageLines.length < HEADER_FOOTER_MIN_PAGES) return repeated;

  const pageCounts = new Map<string, number>();
  for (const lines of pageLines) {
    const candidates = edgeIndexes(lines, HEADER_FOOTER_EDGE_LINES)
      .map((i) => lines[i])
      .filter(isHeaderFooterCandidate);
    for (const line of new Set(candidates)) pageCounts.set(line, (pageCounts.get(line) ?? 0) + 1);
  }
  for (const [line, count] of pageCounts) {
    if (count > pageLines.length * HEADER_FOOTER_PAGE_SHARE) repeated.add(line);
  }
  return repeated;
}

function isHeaderFooterCandidate(line: string): boolean {
  const letters = line.match(/\p{L}/gu)?.length ?? 0;
  return line.length >= HEADER_FOOTER_MIN_CHARS && letters >= HEADER_FOOTER_MIN_LETTERS;
}

// Removes repeated headers/footers and page numbers, but only where they sit: at the page's edges.
// Edges are measured on the page as extracted, so a footer just above the page number still counts.
function stripEdgeLines(lines: string[], repeated: Set<string>): string[] {
  const remove = new Set<number>();
  for (const i of edgeIndexes(lines, HEADER_FOOTER_EDGE_LINES)) {
    if (repeated.has(lines[i])) remove.add(i);
  }
  // A lone number mid-page ("heads\n3\nin") is content; only the first or last line is a page number.
  for (const i of edgeIndexes(lines, 1)) {
    if (PAGE_NUMBER_LINE.test(lines[i])) remove.add(i);
  }
  return lines.filter((_, i) => !remove.has(i));
}

// Indexes of the first and last `count` non-empty lines.
function edgeIndexes(lines: string[], count: number): number[] {
  const nonEmpty = lines.flatMap((line, i) => (line ? [i] : []));
  return [...new Set([...nonEmpty.slice(0, count), ...nonEmpty.slice(-count)])];
}

function joinLines(lines: string[]): string {
  return (
    lines
      .join("\n")
      // A hyphen before a lowercase continuation is a word split by wrapping ("trans-\nformer").
      .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
      // Before anything else the hyphen is probably real ("Anglo-\nSaxon"), so keep it.
      .replace(/(\p{L})-\n(\p{L})/gu, "$1-$2")
      // Keep a line break only after sentence-ending punctuation or at a blank line;
      // every other break is just the PDF's line wrapping, so it becomes a space.
      .replace(/([^.!?:\n])\n(?!\n)/g, "$1 ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}
