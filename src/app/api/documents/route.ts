import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ingest } from "@/lib/ingest";
import { ChunkStrategySchema } from "@/lib/retrieval/chunk";

export const runtime = "nodejs"; // ingestion needs node:dns, node:http and Prisma
export const maxDuration = 60; // seconds; POST runs the whole ingestion before responding

const CreateDocumentSchema = z.object({
  url: z.string().trim().url(),
  strategy: ChunkStrategySchema.optional(), // ingest() defaults to "recursive"
});

export async function GET() {
  try {
    const documents = await prisma.document.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        source: true,
        status: true,
        error: true,
        createdAt: true,
        _count: { select: { chunks: true } },
      },
    });
    return NextResponse.json(
      documents.map(({ _count, ...document }) => ({ ...document, chunkCount: _count.chunks })),
    );
  } catch (err) {
    console.error("Failed to list documents:", err);
    return NextResponse.json({ error: "Could not load documents" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = CreateDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { url, strategy } = parsed.data;

  let documentId: string;
  try {
    const document = await prisma.document.create({
      data: { title: titleFromUrl(url), source: url }, // status defaults to PENDING
    });
    documentId = document.id;
  } catch (err) {
    console.error("Failed to create document:", err);
    return NextResponse.json({ error: "Could not create document" }, { status: 500 });
  }

  try {
    await ingest(documentId, url, strategy); // synchronous: the response waits for the whole pipeline
  } catch {
    // ingest() already stored status FAILED and the error message on the row.
    const failed = await prisma.document
      .findUnique({ where: { id: documentId }, select: { status: true, error: true } })
      .catch(() => null);
    return NextResponse.json(
      { id: documentId, status: failed?.status ?? "FAILED", error: failed?.error ?? "Ingestion failed" },
      { status: 500 },
    );
  }

  // Read back rather than assume READY, so the response reflects what's actually stored.
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, status: true },
  });
  return NextResponse.json(
    { id: documentId, status: document?.status ?? "READY" },
    { status: 201 },
  );
}

// "https://x.com/papers/My%20Paper.pdf" -> "My Paper.pdf"; falls back to the hostname.
function titleFromUrl(url: string): string {
  const { pathname, hostname } = new URL(url);
  const lastSegment = pathname.split("/").filter(Boolean).pop();
  if (!lastSegment) return hostname;
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment; // malformed percent-encoding
  }
}
