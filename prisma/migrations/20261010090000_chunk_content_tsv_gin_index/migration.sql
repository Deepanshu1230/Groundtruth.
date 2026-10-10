-- Full-text search on Chunk.content for keyword and hybrid search.
-- A generated column stays in sync with "content" automatically, so ingestion needs no changes.
-- Prisma can't express generated tsvector columns or GIN indexes on them, so this lives only in SQL.
ALTER TABLE "Chunk"
  ADD COLUMN "contentTsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

CREATE INDEX "Chunk_contentTsv_gin_idx" ON "Chunk" USING gin ("contentTsv");
