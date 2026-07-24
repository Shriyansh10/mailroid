CREATE TABLE "ai_setup_status" (
	"user_id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "hydration_status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "hydration_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_mm_user_hydration_status_received" ON "message_metadata" USING btree ("user_id","hydration_status","received_at");--> statement-breakpoint
ALTER TABLE "emails" DROP COLUMN "raw_payload";--> statement-breakpoint
-- Backfill: rows that already have a hydrated body (the pre-existing Sync
-- button / webhook path) are marked DONE so the new hydration batch never
-- re-fetches them.
UPDATE "message_metadata" SET "hydration_status" = 'DONE'
WHERE "entity_id" IN (SELECT "gmail_message_id" FROM "emails" WHERE "body_text" IS NOT NULL);