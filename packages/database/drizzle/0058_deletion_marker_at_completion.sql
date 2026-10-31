-- Account deletion: the suppression marker is written in the completion
-- transaction, not during the purge, so a failed or unfinished deletion never
-- leaves one. The Google id hash is captured on the request during the purge
-- (while the account row still exists) for that transaction to use.
-- One re-registration review per new account.

ALTER TABLE "account_deletion_request" ADD COLUMN "google_sub_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reregistration_review_user" ON "deletion_reregistration_review" USING btree ("new_user_id");