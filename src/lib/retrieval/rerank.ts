import { CohereClientV2, CohereError } from "cohere-ai";
import { withRetry } from "../embed";
import type { SearchResult } from "./search";

const MAX_ATTEMPTS = 4;

export type RerankedResult<T extends SearchResult = SearchResult> = T & {
  rerankScore: number; // Cohere relevance in [0, 1]; only meaningful for ordering, not as a ratio
};

let client: CohereClientV2 | undefined;

function getClient(): CohereClientV2 {
  // Created lazily so importing this file doesn't fail when the key is missing.
  if (!client) {
    const token = process.env.CO_API_KEY;
    if (!token) throw new Error("CO_API_KEY is not set");
    // The SDK retries twice by default; withRetry below is the only retry layer, so attempts don't multiply.
    client = new CohereClientV2({ token, maxRetries: 0 });
  }
  return client;
}

function readModel(): string {
  const model = process.env.RERANK_MODEL?.trim();
  if (!model) throw new Error("RERANK_MODEL is not set (e.g. RERANK_MODEL=rerank-v3.5)");
  return model;
}

// Reorders `results` by Cohere relevance to `query` and returns the best `topN`, each with its
// original fields (including the search score) plus rerankScore.
export async function rerank<T extends SearchResult>(
  query: string,
  results: T[],
  topN: number,
): Promise<RerankedResult<T>[]> {
  if (results.length === 0) return [];
  if (!Number.isInteger(topN) || topN < 1) throw new Error(`topN must be a positive integer, got ${topN}`);
  const model = readModel();

  const response = await withRetry(
    () =>
      getClient().rerank({
        model,
        query,
        documents: results.map((r) => r.content),
        topN: Math.min(topN, results.length),
      }),
    { maxAttempts: MAX_ATTEMPTS, isRetryable: isRetryableRerank },
  );

  // Results come back best-first; `index` points into the documents array we sent.
  return response.results.map((r) => ({ ...results[r.index], rerankScore: r.relevanceScore }));
}

// Rate limits and server errors are worth retrying; any other 4xx will fail the same way again.
function isRetryableRerank(err: unknown): boolean {
  const status = err instanceof CohereError ? err.statusCode : undefined;
  return status !== undefined && (status === 429 || status >= 500);
}
