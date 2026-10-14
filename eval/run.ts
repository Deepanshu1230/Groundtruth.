// Retrieval eval: hit@k, MRR and latency for each config in eval/configs.json over eval/questions.json.
// Calls search() directly (no HTTP) and never calls the LLM.
// Run from the project root: npx tsx eval/run.ts [questions.json] [configs.json]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../src/lib/db";
import { embed } from "../src/lib/embed";
import { ChunkStrategySchema } from "../src/lib/retrieval/chunk";
import { KEYWORD_MODES, search, SEARCH_MODES, type SearchResult } from "../src/lib/retrieval/search";

const EVAL_DIR = path.resolve("eval");
const CACHE_DIR = path.join(EVAL_DIR, ".cache", "embeddings");
const RESULTS_DIR = path.join(EVAL_DIR, "results");

// tsx doesn't load .env; search needs DATABASE_URL and GEMINI_API_KEY. Variables already set in the shell win.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file: rely on the shell environment
}

const QuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().trim().min(1),
    expectedAnswer: z.string().nullable(), // null = unanswerable from the documents
    documentId: z.string().nullable(),
    sourcePages: z.array(z.number().int().positive()),
    type: z.string().min(1),
  })
  .refine((q) => q.expectedAnswer === null || (q.documentId !== null && q.sourcePages.length > 0), {
    message: "answerable questions need a documentId and at least one sourcePage",
  });
type Question = z.infer<typeof QuestionSchema>;

const ConfigSchema = z.object({
  name: z.string().min(1),
  strategy: ChunkStrategySchema,
  mode: z.enum(SEARCH_MODES),
  keywordMode: z.enum(KEYWORD_MODES),
  rerank: z.boolean(),
  k: z.number().int().min(1).max(50),
});
type Config = z.infer<typeof ConfigSchema>;

interface AnswerableResult {
  id: string;
  type: string;
  question: string;
  answerable: true;
  hit: boolean;
  firstHitRank: number | null; // 1-based
  reciprocalRank: number;
  retrievalMs: number;
  results: Omit<SearchResult, "content">[];
}

interface UnanswerableResult {
  id: string;
  type: string;
  question: string;
  answerable: false;
  topScore: number | null; // the search score of the best result (cosine, ts_rank_cd or as fused)
  topRerankScore: number | null; // only when the config reranks
  retrievalMs: number;
}

type QuestionResult = AnswerableResult | UnanswerableResult;

interface Summary {
  answerable: number;
  unanswerable: number;
  hitAtK: number;
  mrr: number;
  avgRetrievalMs: number;
  hitAtKByType: Record<string, { n: number; hitAtK: number }>;
}

// --- Embedding cache ------------------------------------------------------------------------
// search() embeds the query inside vectorSearch(), so the cache sits at the HTTP layer: Gemini
// embedding responses are stored on disk keyed by URL + request body (model, text, task type,
// dimensions). The API key travels in a header, so it is never part of the key or the file.
const EMBED_URL = /^https:\/\/generativelanguage\.googleapis\.com\/.*:(batchEmbedContents|embedContent)$/;
const cacheStats = { hits: 0, misses: 0 };

function installEmbeddingCache() {
  const realFetch = globalThis.fetch;
  let warnedUncacheable = false;

  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = rawUrl.split("?")[0];
    if (!EMBED_URL.test(url)) return realFetch(input, init);

    const body = init?.body;
    if (typeof body !== "string") {
      if (!warnedUncacheable) console.warn("Embedding request body isn't a string; not caching it.");
      warnedUncacheable = true;
      return realFetch(input, init);
    }

    const file = path.join(CACHE_DIR, `${createHash("sha256").update(`${url}\n${body}`).digest("hex")}.json`);
    if (existsSync(file)) {
      cacheStats.hits++;
      return new Response(readFileSync(file, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    }

    const response = await realFetch(input, init);
    if (response.ok) {
      cacheStats.misses++;
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(file, await response.clone().text());
    }
    return response;
  };
}

// --- Loading -----------------------------------------------------------------------------------
function loadJson<T>(file: string, schema: z.ZodType<T>, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${label} from ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  [${i.path.join(".")}] ${i.message}`).join("\n");
    throw new Error(`Invalid ${label} in ${file}:\n${issues}`);
  }
  return parsed.data;
}

function assertUnique(values: string[], label: string) {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw new Error(`Duplicate ${label}: ${v}`);
    seen.add(v);
  }
}

// --- Evaluation --------------------------------------------------------------------------------
function isHit(result: SearchResult, question: Question): boolean {
  return result.documentId === question.documentId && question.sourcePages.includes(result.page);
}

async function evaluateQuestion(question: Question, config: Config): Promise<QuestionResult> {
  const start = performance.now();
  const { results } = await search(question.question, {
    k: config.k,
    mode: config.mode,
    keywordMode: config.keywordMode,
    rerank: config.rerank,
    strategy: config.strategy,
  });
  const retrievalMs = Math.round(performance.now() - start);
  const base = { id: question.id, type: question.type, question: question.question, retrievalMs };

  if (question.expectedAnswer === null) {
    const top = results[0] as (SearchResult & { rerankScore?: number }) | undefined;
    return { ...base, answerable: false, topScore: top?.score ?? null, topRerankScore: top?.rerankScore ?? null };
  }

  const firstHit = results.findIndex((r) => isHit(r, question));
  return {
    ...base,
    answerable: true,
    hit: firstHit >= 0,
    firstHitRank: firstHit >= 0 ? firstHit + 1 : null,
    reciprocalRank: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    results: results.map(withoutContent), // content omitted to keep files small
  };
}

// Keeps the extra fields hybrid search and rerank add (rrfScore, source, rerankScore).
function withoutContent(result: SearchResult): Omit<SearchResult, "content"> {
  const copy: Partial<SearchResult> = { ...result };
  delete copy.content;
  return copy as Omit<SearchResult, "content">;
}

function summarize(results: QuestionResult[]): Summary {
  const answerable = results.filter((r): r is AnswerableResult => r.answerable);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const hitAtKByType: Summary["hitAtKByType"] = {};
  for (const type of [...new Set(answerable.map((r) => r.type))].sort()) {
    const ofType = answerable.filter((r) => r.type === type);
    hitAtKByType[type] = { n: ofType.length, hitAtK: mean(ofType.map((r) => (r.hit ? 1 : 0))) };
  }

  return {
    answerable: answerable.length,
    unanswerable: results.length - answerable.length,
    hitAtK: mean(answerable.map((r) => (r.hit ? 1 : 0))),
    mrr: mean(answerable.map((r) => r.reciprocalRank)),
    avgRetrievalMs: Math.round(mean(results.map((r) => r.retrievalMs))),
    hitAtKByType,
  };
}

function markdownTable(rows: { config: Config; summary: Summary }[], questions: Question[]): string {
  const types = [...new Set(questions.filter((q) => q.expectedAnswer !== null).map((q) => q.type))].sort();
  const typeCounts = Object.fromEntries(types.map((t) => [t, questions.filter((q) => q.expectedAnswer !== null && q.type === t).length]));

  const header = ["Config", "k", "hit@k", "MRR", "avg retrieval ms", ...types.map((t) => `hit@k ${t} (n=${typeCounts[t]})`)];
  const lines = [header, header.map(() => "---")];
  for (const { config, summary } of rows) {
    lines.push([
      config.name,
      String(config.k),
      summary.hitAtK.toFixed(3),
      summary.mrr.toFixed(3),
      String(summary.avgRetrievalMs),
      ...types.map((t) => summary.hitAtKByType[t]?.hitAtK.toFixed(3) ?? "-"),
    ]);
  }
  return lines.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

async function main() {
  const [questionsFile = path.join(EVAL_DIR, "questions.json"), configsFile = path.join(EVAL_DIR, "configs.json")] =
    process.argv.slice(2);
  const questions = loadJson(questionsFile, z.array(QuestionSchema).min(1), "questions");
  const configs = loadJson(configsFile, z.array(ConfigSchema).min(1), "configs");
  assertUnique(questions.map((q) => q.id), "question id");
  assertUnique(configs.map((c) => c.name), "config name");

  // A typo'd or placeholder documentId would silently score 0 everywhere, so check them up front.
  const documentIds = [...new Set(questions.flatMap((q) => (q.documentId ? [q.documentId] : [])))];
  const found = await prisma.document.findMany({ where: { id: { in: documentIds } }, select: { id: true } });
  const missing = documentIds.filter((id) => !found.some((d) => d.id === id));
  if (missing.length) throw new Error(`documentId not found in the database: ${missing.join(", ")}`);

  installEmbeddingCache();

  // Embed every question once before timing anything, so retrieval ms measures search (and rerank),
  // not whether a config happened to be the first to pay for a query's embedding.
  if (configs.some((c) => c.mode !== "keyword")) {
    for (const q of questions) await embed([q.question], "RETRIEVAL_QUERY");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(RESULTS_DIR, { recursive: true });

  const rows: { config: Config; summary: Summary }[] = [];
  for (const config of configs) {
    console.error(`Running ${config.name} (${questions.length} questions)...`);
    const results: QuestionResult[] = [];
    for (const question of questions) results.push(await evaluateQuestion(question, config));

    const summary = summarize(results);
    rows.push({ config, summary });
    const file = path.join(RESULTS_DIR, `${timestamp}-${config.name.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
    writeFileSync(file, `${JSON.stringify({ timestamp, config, summary, questions: results }, null, 2)}\n`);
    console.error(`  saved ${path.relative(process.cwd(), file)}`);
  }

  console.error(`Embedding cache: ${cacheStats.hits} hits, ${cacheStats.misses} new\n`);
  console.log(markdownTable(rows, questions));
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
