// Checks normalizeText() on hand-picked inputs. No database or API calls.
// Run: npx tsx scripts/test-normalize.ts
import { normalizeText } from "../src/lib/normalizeText";

interface Case {
  name: string;
  pages: string[]; // one entry per page, numbered from 1
  expected: string; // remaining pages' text joined by a blank line; "" means every page was dropped
}

const SIX_PAGES = [1, 2, 3, 4, 5, 6];

const cases: Case[] = [
  { name: "math, one token per line", pages: ["d\nk\n=\nd\nmodel\n/h"], expected: "d k = d model /h" },
  { name: "page with only a page number", pages: ["3"], expected: "" },
  { name: "soft hyphen", pages: ["trans­former"], expected: "transformer" },
  { name: "ligature fi", pages: ["ﬁnd"], expected: "find" },
  { name: "superscript exponent unchanged", pages: ["10⁻⁹"], expected: "10⁻⁹" },
  { name: "hyphen split across lines", pages: ["trans-\nformer"], expected: "transformer" },
  {
    name: "6 pages, '=' and 'model' mid-page on every page survive",
    pages: SIX_PAGES.map((n) =>
      [
        `Page ${n} opens here.`,
        `It defines a width d for page ${n}`,
        `on layer ${n}, written`,
        "=",
        "model",
        `divided by h on page ${n}.`,
        `More on page ${n}.`,
        `Page ${n} ends here.`,
      ].join("\n"),
    ),
    expected: SIX_PAGES.map(
      (n) =>
        `Page ${n} opens here.\nIt defines a width d for page ${n} on layer ${n}, written = model divided by h on page ${n}.\nMore on page ${n}.\nPage ${n} ends here.`,
    ).join("\n\n"),
  },
  {
    name: "6 pages, repeated footer and last-line page number removed",
    pages: SIX_PAGES.map((n) =>
      [`Body sentence one on page ${n}.`, `Body sentence two on page ${n}.`, "Attention Is All You Need", `${n}`].join("\n"),
    ),
    expected: SIX_PAGES.map((n) => `Body sentence one on page ${n}.\nBody sentence two on page ${n}.`).join("\n\n"),
  },
  { name: "lone '3' mid-page survives", pages: ["The heads number\n3\nin this layer."], expected: "The heads number 3 in this layer." },
];

let failures = 0;
for (const [i, c] of cases.entries()) {
  const output = normalizeText(c.pages.map((text, p) => ({ page: p + 1, text })))
    .map((p) => p.text)
    .join("\n\n");
  const pass = output === c.expected;
  if (!pass) failures++;

  // JSON.stringify makes line breaks and invisible characters visible.
  const input = c.pages.length === 1 ? JSON.stringify(c.pages[0]) : JSON.stringify(c.pages);
  console.log(`Case ${i + 1}: ${c.name}`);
  console.log(`  input:    ${input}`);
  console.log(`  output:   ${JSON.stringify(output)}`);
  console.log(`  expected: ${JSON.stringify(c.expected)}`);
  console.log(`  ${pass ? "PASS" : "FAIL"}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exitCode = failures > 0 ? 1 : 0;
