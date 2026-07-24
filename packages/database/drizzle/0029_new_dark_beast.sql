ALTER TYPE "public"."mail_category" ADD VALUE 'DRAFT' BEFORE 'OTHER';--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "draft_id" text;--> statement-breakpoint
CREATE INDEX "idx_mm_user_category_archived" ON "message_metadata" USING btree ("user_id","category","is_archived");--> statement-breakpoint
CREATE INDEX "idx_mm_user_starred" ON "message_metadata" USING btree ("user_id","is_starred");