-- Stage 4: convert the falsely-MEDIUM rows the old schema default created.
-- Before this migration, `priority` defaulted to 'MEDIUM' with a NULL
-- `priority_score` on every freshly synced row — self-contradictory, since a
-- NULL score means the LLM never classified it. 0020 already dropped the
-- default; this backfills existing rows to match the new, honest meaning of
-- the column: priority IS NULL means genuinely unclassified.
UPDATE "message_metadata"
SET "priority" = NULL
WHERE "priority_score" IS NULL;
--> statement-breakpoint

-- Rows that already carry a real score were already classified — mark them
-- DONE so the Stage 5 batch query (`WHERE classification_status = 'PENDING'`)
-- doesn't re-select and re-spend LLM calls on mail that's already classified.
UPDATE "message_metadata"
SET "classification_status" = 'DONE'
WHERE "priority_score" IS NOT NULL;
