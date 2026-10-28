/**
 * Unit tests for the schema, migration runner, guarded upsert, and directory scanner.
 *
 * Uses an in-memory database. Session fixtures come from the fixture files, and the
 * scanner tests build a temporary sessions directory under the OS temp dir.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { currentVersion, listMigrations, migrateDown, migrateUp, openDatabase } from "../db.js";
import { upsertSession } from "../upsert.js";
import { ingestSession, SCHEMA_VERSION } from "../ingest.js";
import { aggregateSession } from "../scanner/aggregate.js";
import { listSessionFiles, resolveSessionsDir, scanSessions } from "../scanner/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

/**
 * A migrated in-memory database.
 * @returns {import("better-sqlite3").Database}
 */
const migratedDb = () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  return db;
};

/**
 * Load a fixture into { session, events }.
 * @param {string} name Fixture file name
 * @returns {{ session: object, events: object[] }}
 */
const loadFixture = (name) => aggregateSession(join(fixturesDir, name));

test("migrations apply once and report the current version", () => {
  const db = migratedDb();
  const migrations = listMigrations();
  const latest = migrations[migrations.length - 1].version;

  assert.equal(currentVersion(db), latest);
  assert.equal(migrateUp(db).applied.length, 0, "a second run applies nothing");
  assert.deepEqual(
    migrations.map((m) => m.version),
    [...migrations.map((m) => m.version)].sort((a, b) => a - b),
    "migrations are numbered in ascending order",
  );

  db.close();
});

test("migration down rolls back the newest migration only", () => {
  const db = migratedDb();
  const migrations = listMigrations();
  const newest = migrations[migrations.length - 1];
  const { rolledBack, version } = migrateDown(db);

  assert.equal(rolledBack, newest.name);
  assert.equal(version, newest.version - 1);

  // The base schema is still there; only the newest migration's objects went away.
  const remaining = db
    .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(remaining.includes("sessions"), "sessions survives the newest rollback");
  assert.equal(remaining.includes("idx_sessions_parent"), false, "002's index is gone");

  db.close();
});

test("a scanned session is stored with rollup and matching facts", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");

  assert.equal(upsertSession(db, session, events, "scan"), true);

  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(session.sessionId);
  assert.equal(row.cost_micros, 19250);
  assert.equal(row.total_tokens, 51425);
  assert.equal(row.last_source, "scan");
  assert.equal(row.entry_count, 16);

  const facts = db
    .prepare("SELECT kind, COUNT(*) AS n FROM usage_events WHERE session_id = ? GROUP BY kind")
    .all(session.sessionId);
  assert.deepEqual(
    Object.fromEntries(facts.map((fact) => [fact.kind, fact.n])),
    { assistant: 4, tool_result: 1, usage: 1, compaction: 1, branch_summary: 1 },
  );

  db.close();
});

test("re-ingesting the same session does not duplicate facts", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");

  upsertSession(db, session, events, "scan");
  upsertSession(db, session, events, "scan");

  const factCount = db
    .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
    .get(session.sessionId).n;
  assert.equal(factCount, events.length, "facts are replaced, not appended");

  db.close();
});

test("a stale push cannot lower a scanned total", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  // Simulate an older snapshot from the same session arriving late.
  const stale = { ...session, entryCount: session.entryCount - 5, costMicros: 1 };
  assert.equal(upsertSession(db, stale, events, "push"), false, "stale push is rejected");

  const row = db.prepare("SELECT cost_micros, entry_count, last_source FROM sessions WHERE session_id = ?").get(session.sessionId);
  assert.equal(row.cost_micros, 19250, "total survived the stale push");
  assert.equal(row.last_source, "scan");

  db.close();
});

test("a fresher push is accepted and marks the row provisional", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  const fresher = { ...session, entryCount: session.entryCount + 3, costMicros: 30000 };
  assert.equal(upsertSession(db, fresher, events, "push"), true);

  const row = db.prepare("SELECT cost_micros, last_source FROM sessions WHERE session_id = ?").get(session.sessionId);
  assert.equal(row.cost_micros, 30000);
  assert.equal(row.last_source, "push");

  db.close();
});

test("an equal entry count push is accepted, so resumed sessions keep updating", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  const sameCount = { ...session, costMicros: 20000 };
  assert.equal(upsertSession(db, sameCount, events, "push"), true, "the guard is >=, not >");

  db.close();
});

test("a scan always writes, overriding a provisional push", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, { ...session, costMicros: 999 }, events, "push");
  upsertSession(db, session, events, "scan");

  const row = db.prepare("SELECT cost_micros, last_source FROM sessions WHERE session_id = ?").get(session.sessionId);
  assert.equal(row.cost_micros, 19250, "file truth wins");
  assert.equal(row.last_source, "scan");

  db.close();
});

test("deleting a session cascades to its facts", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(session.sessionId);

  const factCount = db
    .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?")
    .get(session.sessionId).n;
  assert.equal(factCount, 0, "ON DELETE CASCADE removed the facts");

  db.close();
});

test("negative money and tokens are rejected by CHECK constraints", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  assert.throws(() =>
    db.prepare("UPDATE sessions SET cost_micros = -1 WHERE session_id = ?").run(session.sessionId),
  );
  assert.throws(() =>
    db.prepare("UPDATE sessions SET total_tokens = -5 WHERE session_id = ?").run(session.sessionId),
  );
  assert.throws(() =>
    db.prepare("UPDATE usage_events SET cost_micros = -1 WHERE session_id = ?").run(session.sessionId),
  );

  db.close();
});

test("an unknown usage kind is rejected", () => {
  const db = migratedDb();

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO usage_events (session_id, entry_id, kind, occurred_at, cost_micros)
         VALUES ('s', 'e', 'not_a_kind', '2026-01-01T00:00:00.000Z', 0)`,
      )
      .run(),
  );

  db.close();
});

test("daily_cost attributes a multi-day session to the days it ran", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  const days = db
    .prepare("SELECT day, SUM(cost_micros) AS cost_micros FROM daily_cost GROUP BY day ORDER BY day")
    .all();

  // The fixture bills 19150 micros on 2026-01-01 and 100 micros on 2026-01-02.
  assert.deepEqual(days, [
    { day: "2026-01-01", cost_micros: 19150 },
    { day: "2026-01-02", cost_micros: 100 },
  ]);

  db.close();
});

test("model_cost groups spend by provider and model", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  const models = db.prepare("SELECT provider, model_id, cost_micros FROM model_cost").all();
  assert.deepEqual(models, [{ provider: "anthropic", model_id: "claude-sonnet-4-5", cost_micros: 19250 }]);

  db.close();
});

test("usage entries that name no model are attributed to the model in effect", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "scan");

  // The fixture declares anthropic/claude-sonnet-4-5 in its model_change, and its
  // tool_result, compaction, and branch_summary entries name no model.
  const unattributed = events.filter((event) => ["tool_result", "compaction", "branch_summary"].includes(event.kind));
  assert.equal(unattributed.length, 3);
  for (const event of unattributed) {
    assert.equal(event.provider, "anthropic", `${event.kind} fact keeps a provider`);
    assert.equal(event.modelId, "claude-sonnet-4-5", `${event.kind} fact keeps a model`);
  }

  const unattributedRows = db
    .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider IS NULL")
    .get().n;
  assert.equal(unattributedRows, 0, "no spend is left unattributed in the by-model view");

  db.close();
});

test("a cold scan ingests a directory, a warm scan skips unchanged files", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-scan-"));
  try {
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), join(dir, "session-a.jsonl"));
    copyFileSync(join(fixturesDir, "usage-only.jsonl"), join(dir, "session-b.jsonl"));

    const cold = scanSessions(dir, db);
    assert.equal(cold.files, 2);
    assert.equal(cold.scanned, 2);
    assert.equal(cold.updated, 2);
    assert.equal(cold.skipped, 0);

    const warm = scanSessions(dir, db);
    assert.equal(warm.scanned, 0, "unchanged (mtime, size) pairs are skipped");
    assert.equal(warm.skipped, 2);
    assert.equal(warm.updated, 0);

    const totals = db.prepare("SELECT COUNT(*) AS n, SUM(cost_micros) AS cost FROM sessions").get();
    assert.equal(totals.n, 2);
    assert.equal(totals.cost, 19250 + 100000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("a changed file is rescanned and its totals are replaced", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-scan-"));
  try {
    const target = join(dir, "session-a.jsonl");
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), target);
    scanSessions(dir, db);

    // Same session id, extra usage, and a newer mtime.
    const extra =
      '{"type":"message","id":"a9","parentId":"u1","timestamp":"2026-01-03T10:00:00.000Z","message":{"role":"assistant","content":[],"provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0.000500}}}}\n';
    writeFileSync(target, extra, { flag: "a" });
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);

    const result = scanSessions(dir, db);
    assert.equal(result.scanned, 1);
    assert.equal(result.updated, 1);

    const row = db.prepare("SELECT cost_micros, entry_count FROM sessions").get();
    assert.equal(row.cost_micros, 19250 + 500);
    assert.equal(row.entry_count, 17);

    const factCount = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
    assert.equal(factCount, 9, "facts were replaced, so the count did not double");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("a deleted session file removes its row and cascades to facts", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-scan-"));
  try {
    const target = join(dir, "session-a.jsonl");
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), target);
    scanSessions(dir, db);

    rmSync(target);
    const result = scanSessions(dir, db);

    assert.equal(result.deleted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scan_state").get().n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("subagent artifact directories are not treated as sessions", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-scan-"));
  try {
    const projectDir = join(dir, "--home-user-project-x--");
    mkdirSync(join(projectDir, "subagent-artifacts"), { recursive: true });
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), join(projectDir, "session-a.jsonl"));
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), join(projectDir, "subagent-artifacts", "worker.jsonl"));

    const files = listSessionFiles(dir);
    assert.equal(files.length, 1, "the artifact file is not listed");

    const result = scanSessions(dir, db);
    assert.equal(result.files, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("a file with no session header is rejected, not stored", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-scan-"));
  try {
    writeFileSync(join(dir, "not-a-session.jsonl"), '{"type":"message","id":"m","message":{"role":"user","content":"x"}}\n');

    const result = scanSessions(dir, db);
    assert.equal(result.rejected, 1);
    assert.equal(result.updated, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("sessions directory resolution prefers explicit, then env, then default", () => {
  const saved = process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    assert.equal(resolveSessionsDir("/explicit/path"), "/explicit/path");
    process.env.PI_CODING_AGENT_SESSION_DIR = "/from/env";
    assert.equal(resolveSessionsDir("/explicit/path"), "/explicit/path", "explicit wins");
    assert.equal(resolveSessionsDir(undefined), "/from/env", "env wins over settings and default");
    assert.equal(resolveSessionsDir(undefined, "/from/settings"), "/from/env");
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    assert.equal(resolveSessionsDir(undefined, "relative/dir"), join(process.cwd(), "relative/dir"));
    assert.match(resolveSessionsDir(undefined), /\.pi\/agent\/sessions$/);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = saved;
  }
});

/**
 * A valid ingest payload built from a fixture, for the push-fed scan cases below.
 * @param {string} [fixture]
 * @returns {object}
 */
const pushPayload = (fixture = "full-usage.jsonl") => {
  const { session, events } = loadFixture(fixture);
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
    name: session.name,
    parentSessionId: session.parentSessionId,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    entryCount: session.entryCount,
    totals: {
      costMicros: session.costMicros,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      totalTokens: session.totalTokens,
      userMessages: session.userMessages,
      assistantMessages: session.assistantMessages,
      toolCalls: session.toolCalls,
      toolResults: session.toolResults,
      totalMessages: session.totalMessages,
    },
    events,
    reportedBy: "agent_settled",
    reportedAt: session.lastActivityAt,
  };
};

test("a missing sessions directory scans as nothing instead of throwing", () => {
  const db = migratedDb();
  const missing = join(mkdtempSync(join(tmpdir(), "pi-cost-nodir-")), "absent");

  assert.deepEqual(listSessionFiles(missing), []);

  const result = scanSessions(missing, db);
  assert.equal(result.files, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 0);

  db.close();
});

test("a scan with no directory leaves pushed sessions intact", () => {
  const db = migratedDb();
  const payload = pushPayload();
  ingestSession(db, payload);

  const missing = join(mkdtempSync(join(tmpdir(), "pi-cost-nodir-")), "absent");
  const result = scanSessions(missing, db);

  const row = db.prepare("SELECT last_source, cost_micros, entry_count FROM sessions").get();
  assert.equal(result.deleted, 0, "a sweep over an empty directory deletes nothing");
  assert.equal(row.last_source, "push");
  assert.equal(row.cost_micros, 19250);

  db.close();
});

test("repeated pushes update a session row, so a running session updates itself", () => {
  const db = migratedDb();
  const payload = pushPayload("full-usage.jsonl");
  ingestSession(db, payload);

  // The same session reporting again with one more entry: an equal-or-higher entry count
  // is the push-over-push case, and it must be written.
  const nextReport = { ...payload, entryCount: payload.entryCount + 1, reportedAt: payload.reportedAt };
  const applied = ingestSession(db, nextReport);
  assert.equal(applied.body.applied, true, "a push may replace a push");
  assert.equal(
    db.prepare("SELECT entry_count FROM sessions").get().entry_count,
    payload.entryCount + 1,
  );

  // An older snapshot, reported later, must not roll the row back.
  const stale = { ...payload, entryCount: payload.entryCount - 4 };
  const response = ingestSession(db, stale);
  assert.equal(response.body.applied, false, "an older snapshot is refused");
  assert.equal(db.prepare("SELECT entry_count FROM sessions").get().entry_count, payload.entryCount + 1);

  const facts = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
  assert.ok(facts > 0, "the pushed facts are stored");

  db.close();
});
