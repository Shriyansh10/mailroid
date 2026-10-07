CREATE TYPE "public"."developer_job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "developer_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"target_user_id" text,
	"target_email" text,
	"all_users" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" "developer_job_status" DEFAULT 'QUEUED' NOT NULL,
	"estimated_units" integer,
	"estimated_rows" integer,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"details" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "developer_job_runs" ADD CONSTRAINT "developer_job_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_djr_created_at" ON "developer_job_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_djr_batch" ON "developer_job_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "idx_djr_target" ON "developer_job_runs" USING btree ("target_user_id","created_at");