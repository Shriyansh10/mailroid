ALTER TABLE "message_metadata" ADD COLUMN "attachment_manifest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "attachment_manifest_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "attachment_manifest_skip" text;--> statement-breakpoint
CREATE INDEX "idx_mm_attachment_manifest_pending" ON "message_metadata" USING btree ("user_id","received_at") WHERE "message_metadata"."has_attachment" = true AND "message_metadata"."attachment_manifest_at" IS NULL AND "message_metadata"."attachment_manifest_attempts" < 3;--> statement-breakpoint
-- One-time: messages that already have a manifest (written by hydration, ingest
-- or thread open before this column existed) are stamped now, so the
-- attachment-manifest backfill does not re-fetch work that is already done.
UPDATE "message_metadata" AS mm SET "attachment_manifest_at" = now() WHERE mm."attachment_manifest_at" IS NULL AND EXISTS (SELECT 1 FROM "message_attachments" ma WHERE ma."gmail_message_id" = mm."entity_id" AND ma."user_id" = mm."user_id");
