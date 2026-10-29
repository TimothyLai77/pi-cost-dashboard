-- Migration 003 down: drop the per-component cost columns.
--
-- The components cannot be reconstructed from cost_micros, so rolling back loses the split
-- and keeps only the totals. The two views go back to their migration-001 shape.
--
-- DOWN

DROP VIEW IF EXISTS model_cost;
DROP VIEW IF EXISTS daily_cost;

CREATE VIEW daily_cost AS
SELECT date(u.occurred_at)          AS day,
       s.cwd                        AS cwd,
       u.provider                   AS provider,
       u.model_id                   AS model_id,
       SUM(u.cost_micros)          AS cost_micros,
       SUM(u.total_tokens)         AS total_tokens,
       COUNT(DISTINCT u.session_id) AS sessions
FROM usage_events u
JOIN sessions s ON s.session_id = u.session_id
GROUP BY date(u.occurred_at), s.cwd, u.provider, u.model_id;

CREATE VIEW model_cost AS
SELECT provider,
       model_id,
       SUM(cost_micros)  AS cost_micros,
       SUM(total_tokens) AS total_tokens,
       COUNT(*)          AS events
FROM usage_events
GROUP BY provider, model_id;

ALTER TABLE sessions DROP COLUMN cost_input_micros;
ALTER TABLE sessions DROP COLUMN cost_output_micros;
ALTER TABLE sessions DROP COLUMN cost_cache_read_micros;
ALTER TABLE sessions DROP COLUMN cost_cache_write_micros;

ALTER TABLE usage_events DROP COLUMN cost_input_micros;
ALTER TABLE usage_events DROP COLUMN cost_output_micros;
ALTER TABLE usage_events DROP COLUMN cost_cache_read_micros;
ALTER TABLE usage_events DROP COLUMN cost_cache_write_micros;
