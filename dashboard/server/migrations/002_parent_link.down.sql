-- Migration 002 down: drop the parent file column.
--
-- The ids moved out of parent_session_id cannot be moved back to paths exactly, so this
-- restores the pre-migration shape: the path is put back into parent_session_id.

UPDATE sessions
SET parent_session_id = parent_session_file
WHERE parent_session_file IS NOT NULL;

DROP INDEX IF EXISTS idx_sessions_parent;

ALTER TABLE sessions DROP COLUMN parent_session_file;
