-- Account deletion: retention, suppression and re-registration review.
--
--   * account_deletion_request: reason and email_hash become nullable (reason is
--     nulled at completion; email_hash when the audit expires). closed_at starts
--     the audit retention clock; audit_expired_at marks a request cut down to a
--     skeleton; legal_hold_* stops every expiry tied to the request.
--   * deletion_suppression: hashes only, one per completed purge, used for a
--     single purpose — flag a re-registration for developer review.
--   * deletion_reregistration_review: the flags, owned by the NEW account.
--
-- Retention is enforced only by the manual `account:retention` command; nothing
-- here schedules anything.

CREATE TYPE "public"."deletion_suppression_purpose" AS ENUM('REREGISTRATION_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."reregistration_match" AS ENUM('GOOGLE_ACCOUNT', 'EMAIL', 'GOOGLE_ACCOUNT_AND_EMAIL');--> statement-breakpoint
CREATE TYPE "public"."reregistration_review_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TABLE "deletion_reregistration_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suppression_id" uuid NOT NULL,
	"new_user_id" text NOT NULL,
	"matched_on" "reregistration_match" NOT NULL,
	"status" "reregistration_review_status" DEFAULT 'OPEN' NOT NULL,
	"resolution_note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deletion_suppression" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"google_sub_hash" text,
	"purpose" "deletion_suppression_purpose" DEFAULT 'REREGISTRATION_REVIEW' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_deletion_request" ALTER COLUMN "email_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD COLUMN "audit_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD COLUMN "legal_hold_reason" text;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD COLUMN "legal_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletion_request" ADD COLUMN "legal_hold_by" text;--> statement-breakpoint
ALTER TABLE "deletion_reregistration_review" ADD CONSTRAINT "deletion_reregistration_review_suppression_id_deletion_suppression_id_fk" FOREIGN KEY ("suppression_id") REFERENCES "public"."deletion_suppression"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_reregistration_review" ADD CONSTRAINT "deletion_reregistration_review_new_user_id_user_id_fk" FOREIGN KEY ("new_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_suppression" ADD CONSTRAINT "deletion_suppression_request_id_account_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."account_deletion_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reregistration_review" ON "deletion_reregistration_review" USING btree ("suppression_id","new_user_id");--> statement-breakpoint
CREATE INDEX "idx_reregistration_review_status" ON "deletion_reregistration_review" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deletion_suppression_request" ON "deletion_suppression" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_deletion_suppression_email" ON "deletion_suppression" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "idx_deletion_suppression_google" ON "deletion_suppression" USING btree ("google_sub_hash");--> statement-breakpoint
-- Requests already in a terminal status start their retention clock from the
-- last time they changed.
UPDATE "account_deletion_request"
   SET "closed_at" = coalesce("completed_at", "updated_at")
 WHERE "status" IN ('WITHDRAWN', 'REJECTED', 'CANCELLED', 'COMPLETED') AND "closed_at" IS NULL;
