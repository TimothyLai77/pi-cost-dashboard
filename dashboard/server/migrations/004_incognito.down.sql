-- Migration 004 down: drop the tombstone table.
--
-- The sessions a tombstone protected are gone from the facts tables, and their session
-- files are untouched on disk, so rolling back leaves the database consistent — the
-- next backfill simply re-ingests whatever the tombstones had blocked.
--
-- DOWN

DROP TABLE IF EXISTS excluded_session;
