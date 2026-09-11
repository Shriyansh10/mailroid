CREATE TYPE "public"."platform_role" AS ENUM('USER', 'DEVELOPER');--> statement-breakpoint
CREATE TYPE "public"."billing_event_kind" AS ENUM('GRANT', 'PAYMENT', 'RENEWAL', 'CANCELLATION');--> statement-breakpoint
CREATE TYPE "public"."billing_event_source" AS ENUM('MANUAL', 'PROVIDER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('PRO', 'ULTIMATE', 'LICENSED');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."subscription_subject" AS ENUM('USER', 'ORGANIZATION');--> statement-breakpoint
CREATE TABLE "billing_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "subscription_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"kind" "billing_event_kind" NOT NULL,
	"source" "billing_event_source" NOT NULL,
	"plan" "subscription_plan",
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"actor_user_id" text,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "subscription_subject" NOT NULL,
	"subject_id" text NOT NULL,
	"plan" "subscription_plan" NOT NULL,
	"status" "subscription_status" DEFAULT 'ACTIVE' NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "platform_role" "platform_role" DEFAULT 'USER' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_event" ADD CONSTRAINT "billing_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_billing_event_subject" ON "billing_event" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_subject" ON "subscription" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_subscription_subject_status" ON "subscription" USING btree ("subject_type","subject_id","status");--> statement-breakpoint
-- Carry existing admins onto the new column before 0048 drops is_admin.
-- Hand-added: drizzle-kit generates the column, never the data move, and
-- without this every current admin silently becomes a plain USER.
UPDATE "user" SET "platform_role" = 'DEVELOPER' WHERE "is_admin" = true;