// Checks chunkFixed() on edge cases. No database or API calls.
// Run: npx tsx scripts/test-chunk.ts
import { chunkFixed, type TextChunk } from "../src/lib/retrieval/chunk";

const SIZE = 512;

interface Case {
  name: string;
  pages: { page: number; text: string }[];
  expected: TextChunk[];
}

// Words separated by single spaces, exactly `length` characters. The last character is replaced
// with a letter so the text never ends in a space, which chunking would trim.
function words(length: number): string {
  return "abcd ".repeat(Math.ceil(length / 5)).slice(0, length - 1) + "z";
}

const short = words(150);
const exact = words(SIZE);

const cases: Case[] = [
  { name: "empty page", pages: [{ page: 1, text: "" }], expected: [] },
  { name: "text shorter than size", pages: [{ page: 3, text: short }], expected: [{ page: 3, text: short }] },
  { name: "text exactly size characters", pages: [{ page: 7, text: exact }], expected: [{ page: 7, text: exact }] },
];

let failures = 0;
for (const [i, c] of cases.entries()) {
  const output = chunkFixed(c.pages, SIZE);
  const pass = JSON.stringify(output) === JSON.stringify(c.expected);
  if (!pass) failures++;

  const describe = (chunks: TextChunk[]) =>
    chunks.length === 0 ? "[] (no chunks)" : chunks.map((ch) => `{ page: ${ch.page}, length: ${ch.text.length} }`).join(", ");
  console.log(`Case ${i + 1}: ${c.name}`);
  console.log(`  input:    ${c.pages.map((p) => `{ page: ${p.page}, length: ${p.text.length} }`).join(", ")}`);
  console.log(`  output:   ${describe(output)}`);
  console.log(`  expected: ${describe(c.expected)}`);
  console.log(`  ${pass ? "PASS" : "FAIL"}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures > 0 ? 1 : 0;
