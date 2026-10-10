import { NextResponse } from "next/server";
import { z } from "zod";
import { answer, DocumentNotFoundError } from "@/lib/answer";
import { ChunkStrategySchema } from "@/lib/retrieval/chunk";

export const runtime = "nodejs";

const ChatSchema = z.object({
  question: z.string().trim().min(1, "question is required").max(2000),
  documentId: z.string().trim().min(1).optional(),
  rerank: z.boolean().default(false),
  strategy: ChunkStrategySchema.default("recursive"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const parsed = ChatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  try {
    const { question, documentId, rerank, strategy } = parsed.data;
    return NextResponse.json(await answer(question, { documentId, rerank, strategy }));
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    console.error("Chat failed:", err); // answer() has already logged the query line with the error
    return NextResponse.json({ error: "Could not generate an answer" }, { status: 500 });
  }
}
