import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { z } from "zod";
import type { PdfPage } from "../parsePdf";

export const ChunkStrategySchema = z.enum(["recursive", "fixed", "semantic"]);
export type ChunkStrategy = z.infer<typeof ChunkStrategySchema>;

export interface TextChunk {
  page: number;
  text: string;
}

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export async function chunk(pages: PdfPage[], strategy: ChunkStrategy): Promise<TextChunk[]> {
  switch (strategy) {
    case "recursive":
      return recursiveChunk(pages);
    case "fixed":
    case "semantic":
      throw new Error(`Chunking strategy "${strategy}" is not implemented`);
  }
}

async function recursiveChunk(pages: PdfPage[]): Promise<TextChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });

  // Split page by page so every chunk maps to exactly one page number.
  const chunks: TextChunk[] = [];
  for (const { page, text } of pages) {
    for (const piece of await splitter.splitText(text)) {
      chunks.push({ page, text: piece });
    }
  }
  return chunks;
}
