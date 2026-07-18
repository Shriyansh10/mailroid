CREATE TABLE "gmail_sync_status" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cursor" jsonb,
	"processed" integer DEFAULT 0 NOT NULL,
	"estimated_total" integer,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classification_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_metadata" ALTER COLUMN "priority" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "classification_status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "classification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "classification_jobs_one_active" ON "classification_jobs" USING btree ("user_id") WHERE "classification_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_mm_user_class_status_received" ON "message_metadata" USING btree ("user_id","classification_status","received_at");