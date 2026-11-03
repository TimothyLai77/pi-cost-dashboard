-- Migration 004: incognito mode.
--
-- An incognito Pi session reports nothing and must never be ingested. The extension
-- stops pushing, and the server records a tombstone: the session UUID and nothing else,
-- no cost, no cwd, no timing beyond the tombstone's own creation. Every write path
-- (ingest, backfill, scanner) refuses rows for a tombstoned session id, and creating
-- the tombstone purges rows an earlier partial push already stored.
--
-- No index: the primary key is the only lookup, always by session_id.
--
-- UP

CREATE TABLE excluded_session (
  session_id  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
