CREATE TYPE "public"."deletion_actor_type" AS ENUM('USER', 'DEVELOPER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_kind" AS ENUM('DEPARTURE', 'PRIVACY_ERASURE');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_status" AS ENUM('SUBMITTED', 'WITHDRAWN', 'REJECTED', 'FENCED', 'CANCELLED', 'PURGING', 'VERIFYING', 'AWAITING_SEAL', 'PURGE_FAILED', 'COMPLETED', 'INTEGRITY_INCIDENT');--> statement-breakpoint
CREATE TYPE "public"."tenant_fence_state" AS ENUM('ACTIVE', 'FENCED');--> statement-breakpoint
CREATE TABLE "account_deletion_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" "deletion_actor_type" NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_deletion_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email" text,
	"email_hash" text NOT NULL,
	"kind" "deletion_request_kind" NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" "deletion_request_status" DEFAULT 'SUBMITTED' NOT NULL,
	"org_context" jsonb NOT NULL,
	"org_confirmed_at" timestamp with time zone,
	"org_confirmed_by" text,
	"org_outcome" jsonb,
	"fenced_at" timestamp with time zone,
	"fenced_epoch" integer,
	"fenced_confirmed_at" timestamp with time zone,
	"delete_eligible_at" timestamp with time zone,
	"t_last" timestamp with time zone,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_unresolved" jsonb,
	"storage_block_mode" text,
	"verified_through" timestamp with time zone,
	"delete_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"minimised_at" timestamp with time zone,
	"report" jsonb,
	"last_error" text,
	"decided_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_epoch" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"state" "tenant_fence_state" DEFAULT 'ACTIVE' NOT NULL,
	"ever_fenced" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_deletion_event" ADD CONSTRAINT "account_deletion_event_request_id_account_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."account_deletion_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletion_event" ADD CONSTRAINT "account_deletion_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deletion_event_request" ON "account_deletion_event" USING btree ("request_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deletion_request_open" ON "account_deletion_request" USING btree ("user_id") WHERE "account_deletion_request"."status" not in ('WITHDRAWN','REJECTED','CANCELLED','COMPLETED');--> statement-breakpoint
CREATE INDEX "idx_deletion_request_status" ON "account_deletion_request" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "idx_corsair_accounts_tenant" ON "corsair_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_corsair_entities_account" ON "corsair_entities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_corsair_events_account" ON "corsair_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_tenant_mappings_tenant" ON "calendar_tenant_mappings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_daily_briefs_user" ON "daily_briefs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_classification_jobs_user" ON "classification_jobs" USING btree ("user_id");