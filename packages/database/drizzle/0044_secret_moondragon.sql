ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "gmail_auth_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gmail_tenant_mappings" ADD COLUMN "gmail_auth_failure_reason" text;