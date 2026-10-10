import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { vectorSearch } from "@/lib/retrieval/search";

export const runtime = "nodejs";

const SearchParamsSchema = z.object({
  q: z.string().trim().min(1, "q is required").max(1000),
  k: z.coerce.number().int().min(1).max(50).default(5), // query params arrive as strings
  documentId: z.string().trim().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const parsed = SearchParamsSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { q, k, documentId } = parsed.data;

  try {
    const results = await vectorSearch(q, { k, documentId });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("Search failed:", err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
