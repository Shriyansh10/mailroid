-- Step 1: Add columns as nullable first
ALTER TABLE "message_metadata" ADD COLUMN "user_id" text;
--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "received_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "thread_id" text;
--> statement-breakpoint
-- Step 2: Backfill existing rows with a placeholder (will be updated on next inbox load)
UPDATE "message_metadata" SET "user_id" = '' WHERE "user_id" IS NULL;
--> statement-breakpoint
-- Step 3: Now set NOT NULL
ALTER TABLE "message_metadata" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
-- Step 4: Create indexes
CREATE INDEX "idx_mm_user_category" ON "message_metadata" USING btree ("user_id", "category");
--> statement-breakpoint
CREATE INDEX "idx_mm_user_received" ON "message_metadata" USING btree ("user_id", "received_at");
