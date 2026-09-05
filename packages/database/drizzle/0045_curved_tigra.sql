ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "watch_topic" text;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "watch_owner_env" text;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "resync_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "resync_required_at" timestamp with time zone;