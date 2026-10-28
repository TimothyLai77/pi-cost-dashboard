-- Migration 002: parent session link, and the file it came from.
--
-- Pi writes a forked session's parent into the header as a file path,
-- `<started>_<uuid>.jsonl`. The scanner stored that path straight into
-- parent_session_id, which made a path look like a session id to everything reading it.
-- This moves the path to its own column and replaces the id with the UUID inside it.
--
-- UP

ALTER TABLE sessions ADD COLUMN parent_session_file TEXT;

-- Rows written before this migration hold the path in parent_session_id.
UPDATE sessions
SET parent_session_file = parent_session_id
WHERE parent_session_id LIKE '%.jsonl';

-- `<started>_<uuid>.jsonl`: the UUID starts after the only underscore in the file name
-- and is 36 characters. Session ids are UUIDs, so this recovers the parent's real id.
UPDATE sessions
SET parent_session_id = substr(parent_session_file, instr(parent_session_file, '_') + 1, 36)
WHERE parent_session_file IS NOT NULL;

-- "Which sessions are subagents" is a filter on every aggregate query.
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
