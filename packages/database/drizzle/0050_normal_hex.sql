-- Idempotent on purpose. The column was found to already exist on at least one
-- database that had never run this migration, i.e. it was added out-of-band and
-- the schema had drifted ahead of the migration history. A bare ADD COLUMN
-- aborts the whole run there, and that run is the same one a deploy uses.
-- IF NOT EXISTS converges both cases on the intended schema.
ALTER TABLE "message_metadata" ADD COLUMN IF NOT EXISTS "recipient" text;
