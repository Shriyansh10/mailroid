CREATE TABLE "email_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_email_chunks_user_entity" ON "email_chunks" USING btree ("user_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_mm_user_thread" ON "message_metadata" USING btree ("user_id","thread_id");