ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "quota_cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "quota_cooldown_reason" text;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "last_webhook_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "last_webhook_failure_reason" text;--> statement-breakpoint
CREATE INDEX "idx_gmail_tenant_mappings_tenant" ON "gmail_tenant_mappings" USING btree ("tenant_id");