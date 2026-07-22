ALTER TABLE "message_metadata" ADD COLUMN "summary_digest" text;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "summary_meta" jsonb;