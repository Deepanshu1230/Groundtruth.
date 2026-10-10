"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

type DocumentStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

interface DocumentRow {
  id: string;
  title: string;
  source: string;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  chunkCount: number;
}

interface SourceChunk {
  chunkId: string;
  documentId: string;
  content: string;
  page: number;
  score: number;
}

interface ChatResult {
  answer: string;
  chunks: SourceChunk[];
  latencyMs: number;
  retrievalMs: number;
  tokensIn: number;
  tokensOut: number;
}

interface Exchange {
  id: number;
  question: string;
  scope: string; // document title or "All documents", as it was when asked
  result?: ChatResult;
  error?: string;
}

const POLL_INTERVAL_MS = 3000;
// POST /api/documents only responds once ingestion finishes, so the list is refreshed shortly
// after sending it to pick up the new row; polling then tracks its status.
const NEW_ROW_REFRESH_MS = 1000;
const ALL_DOCUMENTS = "";

const STATUS_STYLES: Record<DocumentStatus, string> = {
  PENDING: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PROCESSING: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 animate-pulse",
  READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

function isSettled(status: DocumentStatus): boolean {
  return status === "READY" || status === "FAILED";
}

// API routes return { error, issues? }; prefer the field-level message when there is one.
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const issue = body?.issues && Object.values(body.issues).flat()[0];
    return typeof issue === "string" ? issue : (body?.error ?? fallback);
  } catch {
    return fallback;
  }
}

async function fetchDocuments(): Promise<DocumentRow[]> {
  const res = await fetch("/api/documents", { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, "Could not load documents"));
  return res.json();
}

export default function Home() {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null); // null = not loaded yet
  const [listError, setListError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState(ALL_DOCUMENTS);
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextExchangeId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  function refreshDocuments() {
    fetchDocuments()
      .then((docs) => {
        setDocuments(docs);
        setListError(null);
      })
      .catch((err: Error) => setListError(err.message));
  }

  useEffect(refreshDocuments, []);

  // Poll each document that is still being ingested. Keyed on the ids so the timer
  // isn't reset by unrelated list updates.
  const pendingIds = (documents ?? []).filter((d) => !isSettled(d.status)).map((d) => d.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      const updates = await Promise.all(
        pendingIds.split(",").map(async (id) => {
          try {
            const res = await fetch(`/api/documents/${id}`, { cache: "no-store" });
            return res.ok ? ((await res.json()) as Pick<DocumentRow, "id" | "status" | "error" | "chunkCount">) : null;
          } catch {
            return null; // transient network error: try again next tick
          }
        }),
      );
      if (cancelled) return;
      setDocuments((docs) =>
        docs?.map((d) => {
          const update = updates.find((u) => u?.id === d.id);
          return update ? { ...d, status: update.status, error: update.error, chunkCount: update.chunkCount } : d;
        }) ?? docs,
      );
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingIds]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges]);

  function addDocument(e: FormEvent) {
    e.preventDefault();
    const value = url.trim();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      setAddError("Enter a valid http(s) URL to a PDF.");
      return;
    }

    setAddError(null);
    setUrl("");
    // Not awaited: the request stays open for the whole ingestion, which can take minutes.
    fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: value }),
    })
      .then(async (res) => {
        // A 500 still created a row marked FAILED with its error; the list shows it.
        if (res.status === 400) setAddError(await readError(res, "Invalid URL"));
      })
      .catch(() => setAddError("Network error while adding the document."))
      .finally(refreshDocuments);
    setTimeout(refreshDocuments, NEW_ROW_REFRESH_MS);
  }

  const readyDocuments = (documents ?? []).filter((d) => d.status === "READY");
  const asking = exchanges.some((x) => !x.result && !x.error);
  const canAsk = readyDocuments.length > 0 && question.trim().length > 0 && !asking;

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    if (!canAsk) return;
    const id = nextExchangeId.current++;
    const text = question.trim();
    const scope = documents?.find((d) => d.id === selectedId)?.title ?? "All documents";
    setExchanges((xs) => [...xs, { id, question: text, scope }]);
    setQuestion("");

    const settle = (patch: Partial<Exchange>) =>
      setExchanges((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, documentId: selectedId || undefined }),
      });
      if (!res.ok) return settle({ error: await readError(res, "Could not generate an answer") });
      settle({ result: await res.json() });
    } catch {
      settle({ error: "Network error. Check your connection and try again." });
    }
  }

  function onQuestionKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900 md:flex-row dark:bg-zinc-950 dark:text-zinc-100">
      {/* Sidebar: add documents and see their ingestion status */}
      <aside className="flex max-h-[45vh] w-full shrink-0 flex-col border-b border-zinc-200 bg-white md:max-h-none md:w-80 md:border-r md:border-b-0 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
          <h1 className="text-lg font-semibold">PDF Chat</h1>
          <form onSubmit={addDocument} className="mt-3 flex flex-col gap-2">
            <label htmlFor="pdf-url" className="text-xs font-medium text-zinc-500">
              PDF URL
            </label>
            <input
              id="pdf-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/paper.pdf"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-800"
            />
            <button
              type="submit"
              disabled={!url.trim()}
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Upload PDF
            </button>
            {addError && <p className="text-xs text-red-600 dark:text-red-400">{addError}</p>}
          </form>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {listError ? (
            <div className="m-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              <p>{listError}</p>
              <button onClick={refreshDocuments} className="mt-2 text-xs font-medium underline">
                Retry
              </button>
            </div>
          ) : documents === null ? (
            <ul className="space-y-2 p-2" aria-label="Loading documents">
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-12 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
              ))}
            </ul>
          ) : documents.length === 0 ? (
            <p className="p-4 text-center text-sm text-zinc-500">No documents yet. Add a PDF URL above.</p>
          ) : (
            <ul className="space-y-1">
              {documents.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => d.status === "READY" && setSelectedId(d.id)}
                    disabled={d.status !== "READY"}
                    title={d.source}
                    className={`w-full rounded-md px-3 py-2 text-left disabled:cursor-default ${
                      selectedId === d.id ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{d.title}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[d.status]}`}>
                        {d.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {new Date(d.createdAt).toLocaleString()}
                      {d.status === "READY" && ` · ${d.chunkCount} chunks`}
                    </p>
                    {d.status === "FAILED" && d.error && (
                      <p className="mt-1 line-clamp-3 text-xs text-red-600 dark:text-red-400">{d.error}</p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Chat */}
      <main className="flex min-h-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <label htmlFor="scope" className="text-sm text-zinc-500">
            Ask about
          </label>
          <select
            id="scope"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="min-w-0 max-w-xs truncate rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value={ALL_DOCUMENTS}>All documents</option>
            {readyDocuments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-3xl space-y-6">
            {exchanges.length === 0 && (
              <div className="mt-16 text-center text-sm text-zinc-500">
                {documents !== null && readyDocuments.length === 0
                  ? "Add a PDF and wait until it is READY to start asking questions."
                  : "Ask a question about your documents. Answers cite the pages they come from."}
              </div>
            )}

            {exchanges.map((x) => (
              <section key={x.id} className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-lg bg-zinc-900 px-4 py-2 text-sm whitespace-pre-wrap text-white dark:bg-zinc-100 dark:text-zinc-900">
                  {x.question}
                </div>

                <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                  <p className="mb-2 text-xs text-zinc-500">{x.scope}</p>

                  {x.error ? (
                    <p className="text-sm text-red-600 dark:text-red-400">{x.error}</p>
                  ) : !x.result ? (
                    <p className="animate-pulse text-sm text-zinc-500">Searching the documents and writing an answer…</p>
                  ) : (
                    <>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{x.result.answer}</p>

                      <div className="mt-4">
                        <h3 className="mb-1 text-xs font-medium text-zinc-500">Sources</h3>
                        {x.result.chunks.length === 0 ? (
                          <p className="text-xs text-zinc-500">No matching passages were found.</p>
                        ) : (
                          <ul className="space-y-1">
                            {x.result.chunks.map((c) => (
                              <li key={c.chunkId}>
                                <details className="group rounded-md border border-zinc-200 dark:border-zinc-800">
                                  <summary className="cursor-pointer px-3 py-1.5 text-xs text-zinc-600 select-none dark:text-zinc-400">
                                    Page {c.page} · score {c.score.toFixed(3)}
                                  </summary>
                                  <p className="border-t border-zinc-200 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                                    {c.content}
                                  </p>
                                </details>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <p className="mt-3 text-xs text-zinc-400">
                        {x.result.latencyMs} ms (retrieval {x.result.retrievalMs} ms) · {x.result.tokensIn} tokens in ·{" "}
                        {x.result.tokensOut} tokens out
                      </p>
                    </>
                  )}
                </div>
              </section>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <form
          onSubmit={ask}
          className="border-t border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="mx-auto flex max-w-3xl gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onQuestionKeyDown}
              rows={2}
              maxLength={2000}
              disabled={readyDocuments.length === 0}
              placeholder={
                readyDocuments.length === 0 ? "No READY documents yet" : "Ask a question (Enter to send, Shift+Enter for a new line)"
              }
              className="flex-1 resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-800"
            />
            <button
              type="submit"
              disabled={!canAsk}
              className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {asking ? "Asking…" : "Ask"}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
