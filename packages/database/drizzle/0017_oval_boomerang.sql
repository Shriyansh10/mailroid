ALTER TABLE "assistant_messages" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "metadata" jsonb;