-- Re-issued from the parked attachments branch, whose own migrations
-- (0044_jittery_mister_sinister, 0045_cool_zarda, 0046_icy_slyde) collided with
-- main's numbering. Its `recipient` column already landed on main as 0050.
--
-- IF NOT EXISTS throughout for the same reason as 0050: a database that ran
-- the parked branch's migrations already has these objects.
CREATE TABLE IF NOT EXISTS "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text,
	"part_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"gmail_attachment_id" text NOT NULL,
	"is_inline" boolean DEFAULT false NOT NULL,
	"content_id" text,
	"cache_storage_key" text,
	"cached_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN IF NOT EXISTS "has_attachment" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_message_attachments_msg_part" ON "message_attachments" USING btree ("gmail_message_id","part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_attachments_user_message" ON "message_attachments" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_attachments_user_thread" ON "message_attachments" USING btree ("user_id","thread_id");--> statement-breakpoint
-- HAND-EDITED, and it must stay that way.
--
-- drizzle-kit emitted a plain btree on ("cache_storage_key","last_accessed_at").
-- The eviction sweep orders by COALESCE(last_accessed_at, cached_at) and only
-- ever looks at cached rows, so the generated form could not serve it: the
-- leading column is the one that is NULL for every row the sweep skips, and the
-- COALESCE is unindexable as written.
--
-- The partial predicate is what keeps this small — in a table where almost
-- nothing is cached at any moment, the index holds only the cached rows.
--
-- If a future `pnpm db:generate` tries to drop and recreate this as a plain
-- index, keep this version.
CREATE INDEX IF NOT EXISTS "idx_message_attachments_evictable" ON "message_attachments"
  USING btree (COALESCE("last_accessed_at", "cached_at"))
  WHERE "cache_storage_key" IS NOT NULL;
