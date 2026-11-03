/**
 * Unit tests for incognito tombstones: the write-path guard, purge, and lift.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateUp, openDatabase } from "../db.js";
import { upsertSession } from "../upsert.js";
import { isExcluded, liftTombstone, purgeSession, tombstoneSession } from "../incognito.js";
import { aggregateSession } from "../scanner/aggregate.js";

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
