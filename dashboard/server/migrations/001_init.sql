-- Migration 001: initial schema.
--
-- Money is stored as integer micro-US dollars (1e-6 USD). SQLite has no DECIMAL
-- type, and sums of doubles drift, so every cost column is an exact integer.
--
-- UP

-- One row per Pi session: rollups for the session table and totals.
CREATE TABLE sessions (
  session_id          TEXT    PRIMARY KEY,
  session_file        TEXT    NOT NULL UNIQUE,
  parent_session_id   TEXT,
  cwd                 TEXT    NOT NULL,
  name                TEXT,
  started_at          TEXT    NOT NULL,
  last_activity_at    TEXT    NOT NULL,
  entry_count         INTEGER NOT NULL,
  cost_micros          INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  input_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  total_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  user_messages       INTEGER NOT NULL DEFAULT 0 CHECK (user_messages >= 0),
  assistant_messages  INTEGER NOT NULL DEFAULT 0 CHECK (assistant_messages >= 0),
  tool_calls          INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  tool_results        INTEGER NOT NULL DEFAULT 0 CHECK (tool_results >= 0),
  total_messages      INTEGER NOT NULL DEFAULT 0 CHECK (total_messages >= 0),
  last_source         TEXT    NOT NULL CHECK (last_source IN ('scan', 'push')),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- One row per usage-bearing entry. This is what makes daily attribution correct:
-- a session that runs across three days bills those days, not its start day.
CREATE TABLE usage_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT    NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  entry_id            TEXT    NOT NULL,
  kind                TEXT    NOT NULL CHECK (kind IN ('assistant','tool_result','usage','compaction','branch_summary')),
  occurred_at         TEXT    NOT NULL,
  provider            TEXT,
  model_id            TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  total_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cost_micros          INTEGER NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  UNIQUE (session_id, entry_id)
);

-- Incremental scan cache: an unchanged (mtime, size) pair means the file is skipped.
CREATE TABLE scan_state (
  session_file   TEXT    PRIMARY KEY,
  session_id     TEXT    NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL,
  scanned_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Chart: range scan by day, then join for the project filter.
CREATE INDEX idx_usage_events_occurred_at ON usage_events(occurred_at);

-- Replace all facts for one session during ingest; also the foreign-key index
-- that keeps ON DELETE CASCADE cheap.
CREATE INDEX idx_usage_events_session_id  ON usage_events(session_id);

-- Per-model breakdown.
CREATE INDEX idx_usage_events_model       ON usage_events(provider, model_id);

-- Recent-sessions list, newest first.
CREATE INDEX idx_sessions_last_activity   ON sessions(last_activity_at DESC);

-- Project filter, used by the chart and the session list.
CREATE INDEX idx_sessions_cwd            ON sessions(cwd);

-- Rollups are views over the facts, so they cannot drift out of sync with them.
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
