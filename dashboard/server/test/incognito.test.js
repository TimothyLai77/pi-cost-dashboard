/**
 * Unit tests for incognito tombstones: the write-path guard, purge, and lift.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateUp, openDatabase } from "../db.js";
import { upsertSession } from "../upsert.js";
import { isExcluded, liftTombstone, purgeSession, tombstoneSession } from "../incognito.js";
import { CONTRACT_KEYS, SCHEMA_VERSION, TOMBSTONE_SCHEMA_VERSION, ingestSession, validateTombstonePayload } from "../ingest.js";
import { aggregateSession } from "../scanner/aggregate.js";
import { scanSessions } from "../scanner/scan.js";

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

/**
 * A valid v2 ingest payload built from a fixture.
 * @param {string} [fixture] Fixture file name
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
      costInputMicros: session.costInputMicros,
      costOutputMicros: session.costOutputMicros,
      costCacheReadMicros: session.costCacheReadMicros,
      costCacheWriteMicros: session.costCacheWriteMicros,
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

test("a tombstoned session refuses scans and pushes alike", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");

  tombstoneSession(db, session.sessionId);

  assert.equal(isExcluded(db, session.sessionId), true);
  assert.equal(upsertSession(db, session, events, "scan"), false, "scan is refused");
  assert.equal(upsertSession(db, session, events, "push"), false, "push is refused");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0);

  db.close();
});

test("tombstoning mid-session purges rows an earlier push stored", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  upsertSession(db, session, events, "push");

  const { purged } = tombstoneSession(db, session.sessionId);

  assert.equal(purged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0, "facts went by cascade");

  db.close();
});

test("tombstoning is idempotent and blocks writes after each call", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");

  assert.deepEqual(tombstoneSession(db, session.sessionId), { purged: 0 });
  upsertSession(db, session, events, "push");
  const second = tombstoneSession(db, session.sessionId);

  assert.deepEqual(second, { purged: 0 }, "nothing was ever stored to purge");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM excluded_session").get().n, 1);

  db.close();
});

test("lifting a tombstone lets the session be written again", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");

  tombstoneSession(db, session.sessionId);
  assert.equal(liftTombstone(db, session.sessionId), 1);
  assert.equal(isExcluded(db, session.sessionId), false);

  assert.equal(upsertSession(db, session, events, "scan"), true);
  assert.equal(db.prepare("SELECT cost_micros FROM sessions").get().cost_micros, 19250);

  db.close();
});

test("lifting a tombstone that does not exist changes nothing", () => {
  const db = migratedDb();

  assert.equal(liftTombstone(db, "no-such-session"), 0);
  assert.equal(purgeSession(db, "no-such-session"), 0);

  db.close();
});

test("tombstones are invisible to the rollups the dashboard reads", () => {
  const db = migratedDb();
  const { session, events } = loadFixture("full-usage.jsonl");
  const { session: other, events: otherEvents } = loadFixture("usage-only.jsonl");

  tombstoneSession(db, session.sessionId);
  upsertSession(db, other, otherEvents, "scan");

  const totals = db.prepare("SELECT COUNT(*) AS n, SUM(cost_micros) AS cost FROM sessions").get();
  assert.equal(totals.n, 1, "only the non-incognito session is in the ledger");
  assert.equal(totals.cost, 100000);

  db.close();
});

test("a v3 tombstone payload records, purges, and lifts through ingest", () => {
  const db = migratedDb();
  const sessionId = aggregateSession(join(fixturesDir, "full-usage.jsonl")).session.sessionId;

  // Tombstone first, so the snapshot that follows must refuse to land.
  const tombstone = { schemaVersion: TOMBSTONE_SCHEMA_VERSION, sessionId, incognito: true };
  const first = ingestSession(db, tombstone);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, sessionId, incognito: true, purged: 0 });

  const blocked = ingestSession(db, pushPayload("full-usage.jsonl"));
  assert.equal(blocked.status, 409, "a push to a tombstoned id answers incognito, not stale");
  assert.equal(blocked.body.error, "incognito");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);

  // Lift, and the same snapshot lands normally.
  const lifted = ingestSession(db, { schemaVersion: TOMBSTONE_SCHEMA_VERSION, sessionId, incognito: false });
  assert.equal(lifted.status, 200);
  assert.equal(lifted.body.incognito, false);

  const landed = ingestSession(db, pushPayload("full-usage.jsonl"));
  assert.equal(landed.body.applied, true);

  db.close();
});

test("an ingest tombstone after partial pushes purges the stored rows", () => {
  const db = migratedDb();
  const payload = pushPayload("full-usage.jsonl");
  ingestSession(db, payload);

  const { status, body } = ingestSession(db, {
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    sessionId: payload.sessionId,
    incognito: true,
  });

  assert.equal(status, 200);
  assert.equal(body.purged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0, "facts went by cascade");

  db.close();
});

test("a scan skips tombstoned files and remembers them for warm scans", () => {
  const db = migratedDb();
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-incognito-scan-"));
  try {
    const incognitoFile = join(dir, "session-a.jsonl");
    copyFileSync(join(fixturesDir, "full-usage.jsonl"), incognitoFile);
    copyFileSync(join(fixturesDir, "usage-only.jsonl"), join(dir, "session-b.jsonl"));

    const sessionId = aggregateSession(incognitoFile).session.sessionId;
    tombstoneSession(db, sessionId);

    const cold = scanSessions(dir, db);
    assert.equal(cold.tombstoned, 1);
    assert.equal(cold.updated, 1, "only the ordinary session is stored");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);

    const warm = scanSessions(dir, db);
    assert.equal(warm.scanned, 0, "both files are cache-skipped, the tombstone is not re-parsed");
    assert.equal(warm.skipped, 2);
    assert.equal(warm.tombstoned, 0, "the tombstone never reaches the parse step again");

    // Lifting the tombstone makes the next scan of a changed file store it normally.
    liftTombstone(db, sessionId);
    writeFileSync(incognitoFile, readFileSync(incognitoFile, "utf8") + "\n");
    const lifted = scanSessions(dir, db, { force: true });
    assert.equal(lifted.updated, 2, "after lifting, both sessions land");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  }
});

test("tombstone validation rejects junk the same way snapshots do", () => {
  const sessionId = aggregateSession(join(fixturesDir, "full-usage.jsonl")).session.sessionId;
  const base = { schemaVersion: TOMBSTONE_SCHEMA_VERSION, sessionId, incognito: true };

  assert.equal(validateTombstonePayload(base).ok, true);
  assert.equal(validateTombstonePayload({ ...base, extra: 1 }).error, "unknown_field");
  assert.equal(validateTombstonePayload({ ...base, schemaVersion: 2 }).error, "unsupported_schema_version");
  assert.equal(validateTombstonePayload({ ...base, sessionId: "not-a-uuid" }).reason, "must be a UUID");
  assert.equal(validateTombstonePayload({ ...base, incognito: "yes" }).reason, "must be a boolean");
  assert.equal(validateTombstonePayload(null).status, 400);
  assert.equal(validateTombstonePayload([1, 2]).status, 400);
});

test("tombstone.schema.json and the hand-written validator agree on fields", () => {
  const contract = JSON.parse(
    readFileSync(join(here, "..", "..", "..", "pi-extension", "tombstone.schema.json"), "utf8"),
  );
  const sorted = (list) => [...list].sort();

  assert.deepEqual(
    sorted(Object.keys(contract.properties)),
    sorted(CONTRACT_KEYS.tombstone),
    "tombstone fields",
  );
  assert.deepEqual(
    sorted(contract.required),
    sorted(CONTRACT_KEYS.tombstoneRequired),
    "tombstone required fields",
  );
  assert.equal(contract.properties.schemaVersion.const, TOMBSTONE_SCHEMA_VERSION);
});
