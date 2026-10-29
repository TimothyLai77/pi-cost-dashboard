-- Migration 003: per-component cost.
--
-- `cost_micros` is the total bill for a call. Pi's usage block reports that bill as four
-- parts — input, output, cache read, cache write — and the dashboard kept only the total.
-- These columns keep the split in the same integer micro-US dollars, so a page can say
-- "this run cost $12, and $9 of it was cache reads".
--
-- The components come from Pi's own pricing pass (pi-ai calculateCost), which writes the
-- four parts and the total in the same place, so the split is recorded, not estimated.
-- Backfilling re-derives them for every session already on disk.
--
-- No new index: every query that sums these reaches usage_events through the existing
-- occurred_at and session_id indexes, and the columns are read alongside cost_micros,
-- never on their own.
--
-- UP

ALTER TABLE usage_events ADD COLUMN cost_input_micros       INTEGER NOT NULL DEFAULT 0 CHECK (cost_input_micros >= 0);
ALTER TABLE usage_events ADD COLUMN cost_output_micros      INTEGER NOT NULL DEFAULT 0 CHECK (cost_output_micros >= 0);
ALTER TABLE usage_events ADD COLUMN cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0 CHECK (cost_cache_read_micros >= 0);
ALTER TABLE usage_events ADD COLUMN cost_cache_write_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_cache_write_micros >= 0);

ALTER TABLE sessions ADD COLUMN cost_input_micros       INTEGER NOT NULL DEFAULT 0 CHECK (cost_input_micros >= 0);
ALTER TABLE sessions ADD COLUMN cost_output_micros      INTEGER NOT NULL DEFAULT 0 CHECK (cost_output_micros >= 0);
ALTER TABLE sessions ADD COLUMN cost_cache_read_micros  INTEGER NOT NULL DEFAULT 0 CHECK (cost_cache_read_micros >= 0);
ALTER TABLE sessions ADD COLUMN cost_cache_write_micros INTEGER NOT NULL DEFAULT 0 CHECK (cost_cache_write_micros >= 0);

-- Rollups are views over the facts, so the two views are rebuilt to carry the new columns.
DROP VIEW IF EXISTS model_cost;
DROP VIEW IF EXISTS daily_cost;

CREATE VIEW daily_cost AS
SELECT date(u.occurred_at)          AS day,
       s.cwd                        AS cwd,
       u.provider                   AS provider,
       u.model_id                   AS model_id,
       SUM(u.cost_micros)           AS cost_micros,
       SUM(u.cost_input_micros)     AS cost_input_micros,
       SUM(u.cost_output_micros)    AS cost_output_micros,
       SUM(u.cost_cache_read_micros)  AS cost_cache_read_micros,
       SUM(u.cost_cache_write_micros) AS cost_cache_write_micros,
       SUM(u.total_tokens)         AS total_tokens,
       COUNT(DISTINCT u.session_id) AS sessions
FROM usage_events u
JOIN sessions s ON s.session_id = u.session_id
GROUP BY date(u.occurred_at), s.cwd, u.provider, u.model_id;

CREATE VIEW model_cost AS
SELECT provider,
       model_id,
       SUM(cost_micros)           AS cost_micros,
       SUM(cost_input_micros)     AS cost_input_micros,
       SUM(cost_output_micros)    AS cost_output_micros,
       SUM(cost_cache_read_micros)  AS cost_cache_read_micros,
       SUM(cost_cache_write_micros) AS cost_cache_write_micros,
       SUM(total_tokens) AS total_tokens,
       COUNT(*)          AS events
FROM usage_events
GROUP BY provider, model_id;
