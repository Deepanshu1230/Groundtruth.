import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { embed } from "../embed";

export const SEARCH_MODES = ["vector", "keyword", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export const KEYWORD_MODES = ["and", "or"] as const;
export type KeywordMode = (typeof KEYWORD_MODES)[number];

export interface SearchOptions {
  k: number;
  documentId?: string;
  strategy?: string;
  // Keyword search only. "and": every term must match. "or" (default): any term may match.
  keywordMode?: KeywordMode;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  page: number;
  // vector: cosine similarity, 1 = identical direction. keyword: ts_rank_cd, unbounded, higher = better.
  score: number;
}

export interface HybridSearchResult extends SearchResult {
  rrfScore: number;
  source: "vector" | "keyword" | "both";
}

// Hybrid fetches this many times k from each list, so a chunk ranked lower in one list
// can still be found and boosted by the other.
const HYBRID_CANDIDATE_FACTOR = 4;
// The standard RRF constant from Cormack et al. (2009); damps the lead of the very top ranks.
const RRF_K = 60;

export async function search(query: string, opts: SearchOptions & { mode: SearchMode }): Promise<SearchResult[]> {
  switch (opts.mode) {
    case "vector":
      return vectorSearch(query, opts);
    case "keyword":
      return keywordSearch(query, opts);
    case "hybrid":
      return hybridSearch(query, opts);
  }
}

function assertValidK(k: number) {
  if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
}

function filterConditions(opts: SearchOptions): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (opts.documentId) conditions.push(Prisma.sql`"documentId" = ${opts.documentId}`);
  if (opts.strategy) conditions.push(Prisma.sql`"strategy" = ${opts.strategy}`);
  return conditions;
}

export async function vectorSearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  assertValidK(opts.k);

  // Same model and dimensions as ingestion; RETRIEVAL_QUERY is Gemini's task type for the question side.
  const [queryVector] = await embed([query], "RETRIEVAL_QUERY");
  const vector = `[${queryVector.join(",")}]`; // pgvector text format

  // Only add filters that were given, so Postgres plans a plain index scan otherwise.
  const conditions = [Prisma.sql`"embedding" IS NOT NULL`, ...filterConditions(opts)];

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

export async function keywordSearch(query: string, opts: SearchOptions): Promise<SearchResult[]> {
  assertValidK(opts.k);

  const tsQuery = (opts.keywordMode ?? "or") === "or" ? toOrQuery(query) : query;
  if (!tsQuery.trim()) return [];

  // websearch_to_tsquery accepts free text ("quoted phrases", -exclusions, or) and never throws on
  // syntax. A query made only of stop words becomes an empty tsquery; numnode(q) = 0 catches it so
  // it returns no rows rather than relying on @@ against an empty query.
  const conditions = [Prisma.sql`numnode(q) > 0`, Prisma.sql`"contentTsv" @@ q`, ...filterConditions(opts)];

  return prisma.$queryRaw<SearchResult[]>`
    SELECT "id" AS "chunkId",
           "documentId",
           "content",
           "page",
           ts_rank_cd("contentTsv", q)::float8 AS "score"
    FROM "Chunk", websearch_to_tsquery('english', ${tsQuery}) AS q
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY "score" DESC, "id"
    LIMIT ${opts.k}
  `;
}

// Questions are prose, so requiring every word (AND) misses most relevant chunks. OR matches any
// term, and ts_rank_cd still ranks chunks that contain more of the terms higher.
// "how does or work" -> "how or does or work": a literal "or" would be read as the operator.
function toOrQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((term) => term && term.toLowerCase() !== "or")
    .join(" or ");
}

export async function hybridSearch(query: string, opts: SearchOptions): Promise<HybridSearchResult[]> {
  assertValidK(opts.k);

  const candidates = { ...opts, k: opts.k * HYBRID_CANDIDATE_FACTOR };
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(query, candidates),
    keywordSearch(query, candidates),
  ]);

  // Reciprocal Rank Fusion uses each result's rank, not its raw score, because the two scores
  // aren't comparable: cosine similarity sits in a narrow band near 0.5-0.9, while ts_rank_cd is
  // unbounded and depends on term counts and chunk length. Adding or normalising them would let
  // whichever scale happens to be larger dominate. Ranks put both lists on the same footing, and
  // a chunk found by both lists collects two contributions and rises to the top.
  const fused = new Map<string, HybridSearchResult>();
  const lists = [
    [vectorResults, "vector"],
    [keywordResults, "keyword"],
  ] as const;
  for (const [results, source] of lists) {
    results.forEach((result, index) => {
      const contribution = 1 / (RRF_K + index + 1); // ranks are 1-based
      const existing = fused.get(result.chunkId);
      if (existing) {
        existing.rrfScore += contribution;
        existing.source = "both"; // keeps the vector list's score, since that list goes first
      } else {
        fused.set(result.chunkId, { ...result, rrfScore: contribution, source });
      }
    });
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore).slice(0, opts.k);
}
