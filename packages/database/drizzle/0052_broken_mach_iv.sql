CREATE TYPE "public"."org_audit_action" AS ENUM('ORG_CREATED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'MANAGER_CHANGED', 'ROLE_CHANGED');--> statement-breakpoint
CREATE TYPE "public"."org_edge_type" AS ENUM('REPORTS_TO');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('OWNER', 'MEMBER');--> statement-breakpoint
CREATE TABLE "org_audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" text,
	"action" "org_audit_action" NOT NULL,
	"subject_email" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" DEFAULT 'MEMBER' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_reporting_edge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"subordinate_email" text NOT NULL,
	"manager_email" text NOT NULL,
	"type" "org_edge_type" DEFAULT 'REPORTS_TO' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_audit_event" ADD CONSTRAINT "org_audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_audit_event" ADD CONSTRAINT "org_audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_reporting_edge" ADD CONSTRAINT "org_reporting_edge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_audit_org" ON "org_audit_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_membership_current" ON "org_membership" USING btree ("organization_id","email") WHERE "org_membership"."effective_until" is null;--> statement-breakpoint
CREATE INDEX "idx_org_membership_org" ON "org_membership" USING btree ("organization_id","effective_until");--> statement-breakpoint
CREATE INDEX "idx_org_membership_email" ON "org_membership" USING btree ("email","effective_until");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_edge_current_subordinate" ON "org_reporting_edge" USING btree ("organization_id","subordinate_email") WHERE "org_reporting_edge"."effective_until" is null;--> statement-breakpoint
CREATE INDEX "idx_org_edge_manager" ON "org_reporting_edge" USING btree ("organization_id","manager_email","effective_until");