import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";

const MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768; // must match vector(768) on Chunk.embedding
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;

const EmbedResponseSchema = z.object({
  embeddings: z.array(
    z.object({ values: z.array(z.number()).length(EMBEDDING_DIMENSIONS) }),
  ),
});

// Documents and search queries are embedded slightly differently for better retrieval.
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

let client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  // Created lazily so importing this file doesn't fail when the key is missing.
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export async function embed(
  texts: string[],
  taskType: EmbedTaskType = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    vectors.push(...(await withRetry(() => embedBatch(batch, taskType))));
  }
  return vectors;
}

async function embedBatch(batch: string[], taskType: EmbedTaskType): Promise<number[][]> {
  const response = await getClient().models.embedContent({
    model: MODEL,
    contents: batch,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType },
  });

  const { embeddings } = EmbedResponseSchema.parse(response);
  if (embeddings.length !== batch.length) {
    throw new Error(`Expected ${batch.length} embeddings, got ${embeddings.length}`);
  }
  // Below 3072 dimensions gemini-embedding-001 returns unnormalized vectors; Google recommends normalizing.
  return embeddings.map((e) => normalize(e.values));
}

export interface RetryOptions {
  maxAttempts?: number;
  isRetryable?: (err: unknown) => boolean;
}

// Defaults are embed()'s policy; other callers (answer.ts) pass their own.
export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = MAX_ATTEMPTS, isRetryable: shouldRetry = isRetryable }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      // 1s, 2s, 4s, 8s plus jitter so parallel jobs don't retry in lockstep.
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError; // fetch() throws TypeError on network failures
}

function normalize(vector: number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}
