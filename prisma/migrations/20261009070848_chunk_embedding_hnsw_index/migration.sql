-- HNSW index for cosine-distance search (the <=> operator) on Chunk.embedding.
-- Prisma can't express HNSW indexes in schema.prisma, so this lives only in SQL.
CREATE INDEX "Chunk_embedding_hnsw_idx" ON "Chunk" USING hnsw ("embedding" vector_cosine_ops);
