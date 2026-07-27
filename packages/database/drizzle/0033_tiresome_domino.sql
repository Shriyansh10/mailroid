ALTER TABLE "classification_jobs" ADD COLUMN "max_to_process" integer;--> statement-breakpoint
ALTER TABLE "classification_jobs" ADD COLUMN "attempted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "classification_jobs" ADD COLUMN "credits_charged" integer DEFAULT 0 NOT NULL;