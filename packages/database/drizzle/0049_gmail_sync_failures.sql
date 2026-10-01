CREATE TABLE "gmail_sync_failures" (
	"tenant_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_sync_failures_tenant_id_thread_id_pk" PRIMARY KEY("tenant_id","thread_id")
);
--> statement-breakpoint
CREATE INDEX "idx_gsf_due" ON "gmail_sync_failures" USING btree ("status","next_attempt_at");