CREATE TYPE "public"."scheduling_outcome" AS ENUM('ACCEPTED_AS_IS', 'EDITED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."scheduling_rule_kind" AS ENUM('MEETING_TYPE', 'PARTICIPANT', 'FOCUS_BLOCK', 'DAY_TEMPLATE');--> statement-breakpoint
CREATE TYPE "public"."scheduling_rule_source" AS ENUM('EXPLICIT', 'LEARNED');--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"time_zone" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_contact_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"handles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_contacts" (
	"user_id" text NOT NULL,
	"handle" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_contacts_user_id_handle_pk" PRIMARY KEY("user_id","handle")
);
--> statement-breakpoint
CREATE TABLE "scheduling_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"approval_id" text,
	"rule_id" uuid,
	"proposed_start" timestamp with time zone NOT NULL,
	"proposed_end" timestamp with time zone NOT NULL,
	"approved_start" timestamp with time zone,
	"approved_end" timestamp with time zone,
	"outcome" "scheduling_outcome" NOT NULL,
	"intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" "scheduling_rule_kind" DEFAULT 'MEETING_TYPE' NOT NULL,
	"label" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"source" "scheduling_rule_source" DEFAULT 'EXPLICIT' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD COLUMN "refine_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_contact_groups" ADD CONSTRAINT "scheduling_contact_groups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_contacts" ADD CONSTRAINT "scheduling_contacts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_outcomes" ADD CONSTRAINT "scheduling_outcomes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_rules" ADD CONSTRAINT "scheduling_rules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sched_groups_user_name" ON "scheduling_contact_groups" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "idx_sched_groups_user" ON "scheduling_contact_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sched_contacts_user_email" ON "scheduling_contacts" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX "idx_sched_outcomes_user_intent" ON "scheduling_outcomes" USING btree ("user_id","intent","created_at");--> statement-breakpoint
CREATE INDEX "idx_sched_rules_user_active" ON "scheduling_rules" USING btree ("user_id","active");