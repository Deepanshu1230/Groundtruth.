// Re-chunks and re-embeds an existing document with one strategy, leaving other strategies' chunks alone.
// Run: npx tsx scripts/reingest.ts <documentId> <strategy>
import { prisma } from "../src/lib/db";
import { ingest } from "../src/lib/ingest";
import { ChunkStrategySchema } from "../src/lib/retrieval/chunk";

const USAGE = `Usage: npx tsx scripts/reingest.ts <documentId> <strategy>  (strategy: ${ChunkStrategySchema.options.join(" | ")})`;

// tsx doesn't load .env; ingestion needs GEMINI_API_KEY. Variables already set in the shell win.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the shell environment
}

async function main(): Promise<number> {
  const [documentId, strategyArg] = process.argv.slice(2);
  const strategy = ChunkStrategySchema.safeParse(strategyArg);
  if (!documentId || !strategy.success) {
    console.error(USAGE);
    return 1;
  }

  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    console.error(`Document not found: ${documentId}`);
    return 1;
  }
  if (!isHttpUrl(document.source)) {
    console.error(
      `Document ${documentId} can't be re-ingested: its source is not an http(s) URL (source: ${JSON.stringify(document.source)}).`,
    );
    return 1;
  }

  console.log(`Re-ingesting "${document.title}" (${documentId}) with strategy "${strategy.data}" from ${document.source}`);
  let exitCode = 0;
  const start = performance.now();
  try {
    await ingest(documentId, document.source, strategy.data);
    console.log(`Done in ${((performance.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    // ingest() has already marked the document FAILED with this message.
    console.error(`Ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  }

  // Printed even after a failure: a failed run leaves the previous chunks in place.
  const counts = await prisma.chunk.groupBy({
    by: ["strategy"],
    where: { documentId },
    _count: { _all: true },
    orderBy: { strategy: "asc" },
  });
  console.log("\nChunks per strategy:");
  if (counts.length === 0) console.log("  (none)");
  for (const row of counts) console.log(`  ${row.strategy.padEnd(10)} ${row._count._all}`);
  return exitCode;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
