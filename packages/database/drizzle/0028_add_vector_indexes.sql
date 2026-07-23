-- HNSW ANN indexes for cosine-distance (<=>) similarity search.
-- Hand-written: drizzle-kit's schema diffing has no vector-index construct,
-- so these can't be generated from the Drizzle schema like the btree ones.
--
-- emails.embedding: searchEmails (the assistant's search tool) now reads
-- this via searchLocalEmails/searchByEmbedding (packages/services/gmail/index.ts)
-- instead of the live Gmail API — without an index this is a full sequential
-- scan on every search.
--
-- email_chunks.embedding: getEmailDetail's per-email passage retrieval
-- (apps/web/lib/executors/email-detail.ts).
--
-- pgvector >= 0.5.0 required for HNSW (confirmed 0.8.5 on this image).
CREATE INDEX IF NOT EXISTS "idx_emails_embedding_hnsw"
  ON "emails" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_email_chunks_embedding_hnsw"
  ON "email_chunks" USING hnsw ("embedding" vector_cosine_ops);
