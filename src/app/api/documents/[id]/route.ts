import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const { id } = await ctx.params; // params is a Promise in Next 15+

  try {
    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, status: true, error: true, _count: { select: { chunks: true } } },
    });
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: document.id,
      status: document.status,
      error: document.error,
      chunkCount: document._count.chunks,
    });
  } catch (err) {
    console.error(`Failed to load document ${id}:`, err);
    return NextResponse.json({ error: "Could not load document" }, { status: 500 });
  }
}
