CREATE TABLE "sync_pauses" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"scope" text NOT NULL,
	"tenant_id" text,
	"mode" text NOT NULL,
	"reason" text,
	"created_by" text,
	"block_watch_renewal" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_pauses_one_global" ON "sync_pauses" USING btree ("scope") WHERE "sync_pauses"."scope" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "sync_pauses_one_per_tenant" ON "sync_pauses" USING btree ("tenant_id") WHERE "sync_pauses"."tenant_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_sync_pauses_tenant" ON "sync_pauses" USING btree ("tenant_id");