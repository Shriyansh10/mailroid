ALTER TABLE "message_metadata" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "summary_flags" jsonb;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "summary_generated_at" timestamp with time zone;