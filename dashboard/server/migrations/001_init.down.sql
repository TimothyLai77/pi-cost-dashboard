-- Migration 001: initial schema, DOWN.
--
-- Reversible from the first migration, as required by DESIGN.md §14.
-- Drop views before the tables they read from.

DROP VIEW IF EXISTS model_cost;
DROP VIEW IF EXISTS daily_cost;

DROP INDEX IF EXISTS idx_sessions_cwd;
DROP INDEX IF EXISTS idx_sessions_last_activity;
DROP INDEX IF EXISTS idx_usage_events_model;
DROP INDEX IF EXISTS idx_usage_events_session_id;
DROP INDEX IF EXISTS idx_usage_events_occurred_at;

DROP TABLE IF EXISTS scan_state;
DROP TABLE IF EXISTS usage_events;
DROP TABLE IF EXISTS sessions;
