import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { embed } from "../embed";

export interface SearchOptions {
  k: number;
  documentId?: string;
  strategy?: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  page: number;
  score: number; // cosine similarity, 1 = identical direction
}

export async function vectorSearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  if (!Number.isInteger(opts.k) || opts.k < 1) throw new Error(`k must be a positive integer, got ${opts.k}`);

  // Same model and dimensions as ingestion; RETRIEVAL_QUERY is Gemini's task type for the question side.
  const [queryVector] = await embed([query], "RETRIEVAL_QUERY");
  const vector = `[${queryVector.join(",")}]`; // pgvector text format

  // Only add filters that were given, so Postgres plans a plain index scan otherwise.
  const conditions = [Prisma.sql`"embedding" IS NOT NULL`];
  if (opts.documentId) conditions.push(Prisma.sql`"documentId" = ${opts.documentId}`);
  if (opts.strategy) conditions.push(Prisma.sql`"strategy" = ${opts.strategy}`);

  const [, rows] = await prisma.$transaction([
    // HNSW filters *after* fetching ~40 candidates, so a filtered search could return fewer than k.
    // Iterative scan (pgvector 0.8+) keeps searching until k rows pass the filter. SET LOCAL lasts
    // only for this transaction, which keeps it safe behind Supabase's connection pooler.
    prisma.$executeRaw`SET LOCAL hnsw.iterative_scan = strict_order`,
    prisma.$queryRaw<SearchResult[]>`
      SELECT "id" AS "chunkId",
             "documentId",
             "content",
             "page",
             1 - ("embedding" <=> ${vector}::vector) AS "score"
      FROM "Chunk"
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY "embedding" <=> ${vector}::vector
      LIMIT ${opts.k}
    `,
  ]);

  return rows; // already best-first: smallest distance = highest similarity
}
