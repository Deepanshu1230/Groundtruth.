import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { embed } from "./embed";
import { fetchPdf } from "./fetchPdf";
import { normalizeText } from "./normalizeText";
import { parsePdf } from "./parsePdf";
import { chunk, type ChunkStrategy } from "./retrieval/chunk";

const STRATEGY: ChunkStrategy = "recursive";
const INSERT_BATCH_SIZE = 100; // rows per INSERT; keeps statements well under Postgres's parameter limit
const MAX_ERROR_LENGTH = 1000;

export async function ingest(documentId: string, source: string): Promise<void> {
  // Outside the try: if the document doesn't exist there is no row to mark FAILED.
  await prisma.document.update({
    where: { id: documentId },
    data: { status: "PROCESSING", error: null },
  });

  try {
    // Do all slow network work before opening the transaction.
    const pdf = await fetchPdf(source);
    const pages = normalizeText(await parsePdf(pdf));
    // parsePdf rejects text-free PDFs, but cleanup can still strip everything (e.g. only page numbers).
    if (pages.length === 0) throw new Error("PDF has no text left after cleanup");
    const chunks = await chunk(pages, STRATEGY);
    const vectors = await embed(chunks.map((c) => c.text));

    // Delete + insert + READY commit together, so a failure never leaves half the chunks behind.
    await prisma.$transaction(
      async (tx) => {
        await tx.chunk.deleteMany({ where: { documentId } }); // makes re-running ingest idempotent

        for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
          const rows = chunks.slice(i, i + INSERT_BATCH_SIZE).map(
            (c, j) =>
              // Raw SQL skips Prisma's @default(cuid()), so the id is generated here.
              Prisma.sql`(${randomUUID()}, ${documentId}, ${c.text}, ${c.page}, ${STRATEGY}, ${toVectorLiteral(vectors[i + j])}::vector)`,
          );
          await tx.$executeRaw`
            INSERT INTO "Chunk" ("id", "documentId", "content", "page", "strategy", "embedding")
            VALUES ${Prisma.join(rows)}
          `;
        }

        await tx.document.update({
          where: { id: documentId },
          data: { status: "READY", error: null },
        });
      },
      { timeout: 60_000 }, // default is 5s, too short for large documents over a remote pooler
    );
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    await prisma.document
      .update({ where: { id: documentId }, data: { status: "FAILED", error: message } })
      .catch((updateErr) => console.error(`Could not mark document ${documentId} FAILED:`, updateErr));
    throw err;
  }
}

// pgvector's text input format: "[0.1,0.2,...]"
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
