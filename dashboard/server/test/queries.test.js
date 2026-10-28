/**
 * Unit tests for the read queries and the HTTP layer.
 *
 * Routes are exercised over a real socket on an ephemeral port (port 0) so the tests
 * need no HTTP test helper dependency.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { currentVersion, openDatabase, migrateUp } from "../db.js";
import { upsertSession } from "../upsert.js";
import { aggregateSession } from "../scanner/aggregate.js";
import {
  getDailyCost,
  getFilters,
  getHealth,
  getModelCost,
  getSessionById,
  getSessions,
  getSummary,
  MAX_PAGE_SIZE,
} from "../queries.js";
import { createApp } from "../index.js";

/**
 * A migrated in-memory database holding the fixture sessions.
 *
 * full-usage bills 19150 micros on 2026-01-01 and 100 on 2026-01-02.
 * usage-only bills 100000 micros on 2026-01-03.
 *
 * @returns {import("better-sqlite3").Database}
 */
const seededDb = () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  for (const fixture of ["full-usage.jsonl", "usage-only.jsonl"]) {
    const { session, events } = aggregateSession(
      join(import.meta.dirname, "fixtures", fixture),
    );
    upsertSession(db, session, events, "scan");
  }
  return db;
};

test("getSummary totals cost, tokens, and sessions over all time", () => {
  const db = seededDb();
  const summary = getSummary(db);

  assert.equal(summary.allTime.costMicros, 19250 + 100000);
  assert.equal(summary.allTime.costUsd, "$0.12");
  assert.equal(summary.allTime.sessions, 2);
  assert.equal(summary.allTime.events, 10);

  // Historical fixtures are outside every recent window.
  assert.equal(summary.today.costMicros, 0);
  assert.equal(summary.last7Days.costMicros, 0);
  db.close();
});

test("getDailyCost returns zero points for days with no spend", () => {
  const db = seededDb();
  const { points } = getDailyCost(db, {
    from: "2026-01-01",
    to: "2026-01-05",
  });

  assert.deepEqual(
    points.map((point) => [point.day, point.costMicros]),
    [
      ["2026-01-01", 19150],
      ["2026-01-02", 100],
      ["2026-01-03", 100000],
      ["2026-01-04", 0],
      ["2026-01-05", 0],
    ],
    "gaps are filled so the chart cannot draw a straight line across them",
  );
  db.close();
});

test("getDailyCost filters by project and by provider", () => {
  const db = seededDb();

  const projectOnly = getDailyCost(db, {
    from: "2026-01-01",
    to: "2026-01-05",
    cwd: "/home/user/project-b",
  });
  assert.equal(projectOnly.totalCostMicros, 100000);

  const providerOnly = getDailyCost(db, {
    from: "2026-01-01",
    to: "2026-01-05",
    provider: "custom",
  });
  assert.equal(providerOnly.totalCostMicros, 0, "the only custom-provider session billed nothing");

  const missing = getDailyCost(db, { cwd: "/no/such/project" });
  assert.deepEqual(missing.points, []);
  db.close();
});

test("getDailyCost shifts day buckets with a timezone offset", () => {
  const db = seededDb();

  const utc = getDailyCost(db, { from: "2026-01-01", to: "2026-01-05" });
  const west = getDailyCost(db, {
    from: "2026-01-01",
    to: "2026-01-05",
    tzOffsetMinutes: -12 * 60,
  });

  // 10:00 UTC on 2026-01-01 is 2026-01-02 when shifted 12 hours east.
  const east = getDailyCost(db, {
    from: "2026-01-01",
    to: "2026-01-05",
    tzOffsetMinutes: 12 * 60,
  });

  assert.equal(utc.points[0].day, "2026-01-01");
  assert.equal(west.range.tzOffsetMinutes, -720);
  assert.equal(east.range.tzOffsetMinutes, 720);
  assert.equal(
    east.points.reduce((sum, point) => sum + point.costMicros, 0),
    utc.points.reduce((sum, point) => sum + point.costMicros, 0),
    "shifting moves cost between days, it never changes the total",
  );
  db.close();
});

test("getSessions paginates, sorts, and clamps the page size", () => {
  const db = seededDb();

  const firstPage = getSessions(db, { limit: 1 });
  assert.equal(firstPage.sessions.length, 1);
  assert.equal(firstPage.total, 2);

  const secondPage = getSessions(db, { limit: 1, offset: 1 });
  assert.equal(secondPage.sessions.length, 1);
  assert.notEqual(firstPage.sessions[0].sessionId, secondPage.sessions[0].sessionId);

  assert.equal(getSessions(db, { limit: 10_000 }).limit, MAX_PAGE_SIZE, "page size is capped");
  assert.equal(getSessions(db, { limit: "not-a-number" }).limit, 25, "bad input falls back");

  const byCost = getSessions(db, { sort: "cost" });
  assert.ok(byCost.sessions[0].costMicros >= byCost.sessions[1].costMicros);

  const byProject = getSessions(db, { cwd: "/home/user/project-a" });
  assert.equal(byProject.total, 1);
  db.close();
});

test("getSessionById returns the session with its facts, null when absent", () => {
  const db = seededDb();
  const id = db.prepare("SELECT session_id FROM sessions WHERE cwd = '/home/user/project-a'").get().session_id;

  const session = getSessionById(db, id);
  assert.equal(session.cwd, "/home/user/project-a");
  assert.equal(session.name, "Fixture session");
  assert.equal(session.costMicros, 19250);
  assert.equal(session.events.length, 8);
  assert.equal(session.provisional, false);
  assert.equal(session.messages.assistant, 4);
  assert.equal(session.tokens.cacheRead, 50412);

  assert.equal(getSessionById(db, "00000000-0000-4000-8000-000000000000"), null);
  db.close();
});

test("getModelCost orders by spend", () => {
  const db = seededDb();
  const models = getModelCost(db);

  // full-usage bills only anthropic/claude-sonnet-4-5, and the cache warm in usage-only
  // is attributed to the same model, so that group is the sum of both fixtures.
  assert.deepEqual(
    models.map((model) => `${model.provider}/${model.modelId}`),
    ["anthropic/claude-sonnet-4-5", "custom/cheap-model"],
  );
  assert.ok(models[0].costMicros >= models[1].costMicros);
  assert.equal(models[0].costMicros, 19250 + 100000);
  assert.equal(models[1].costMicros, 0, "an unpriced model reports tokens at zero cost");
  db.close();
});

test("getFilters lists projects and providers for the controls", () => {
  const db = seededDb();
  const filters = getFilters(db);

  assert.deepEqual(filters.projects, ["/home/user/project-a", "/home/user/project-b"]);
  assert.deepEqual(filters.providers, ["anthropic", "custom"]);
  db.close();
});

test("getHealth reports counts, schema version, and last scan", () => {
  const db = seededDb();
  const health = getHealth(db, "/tmp/sessions", 2);

  assert.equal(health.status, "ok");
  assert.equal(health.sessionCount, 2);
  assert.equal(health.usageEventCount, 10);
  assert.equal(health.schemaVersion, 1);
  assert.equal(health.sessionFilesOnDisk, 2);
  assert.equal(health.lastScanAt, null, "no scan_state rows in a seeded database");
  db.close();
});

/**
 * Start the app on an ephemeral port and run a block of requests against it.
 * @param {import("better-sqlite3").Database} db
 * @param {(baseUrl: string) => Promise<void>} block
 * @returns {Promise<void>}
 */
const withServer = async (db, block) => {
  const app = createApp(db, { sessionsDir: "/tmp/sessions", rescan: () => ({ scanned: 0 }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    await block(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test("GET /api/health responds with the database state", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sessionCount, 2);
    assert.equal(body.sessionsDir, "/tmp/sessions");
  });
  db.close();
});

test("GET /api/daily rejects a malformed date and offset", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const badDate = await fetch(`${base}/api/daily?from=not-a-date`);
    assert.equal(badDate.status, 400);
    assert.equal((await badDate.json()).parameter, "from");

    const badOffset = await fetch(`${base}/api/daily?tzOffsetMinutes=abc`);
    assert.equal(badOffset.status, 400);
    assert.equal((await badOffset.json()).parameter, "tzOffsetMinutes");

    const ok = await fetch(`${base}/api/daily?from=2026-01-01&to=2026-01-03`);
    assert.equal(ok.status, 200);
  });
  db.close();
});

test("GET /api/sessions rejects a non-numeric page and 404s an unknown session", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const badLimit = await fetch(`${base}/api/sessions?limit=abc`);
    assert.equal(badLimit.status, 400);

    const missing = await fetch(`${base}/api/sessions/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "not_found");
  });
  db.close();
});

test("writes require a token only when one is configured", async () => {
  const db = seededDb();
  const saved = process.env.PI_COST_TOKEN;
  try {
    process.env.PI_COST_TOKEN = "secret-value";
    await withServer(db, async (base) => {
      const withoutToken = await fetch(`${base}/api/rescan`, { method: "POST" });
      assert.equal(withoutToken.status, 401);

      const withToken = await fetch(`${base}/api/rescan`, {
        method: "POST",
        headers: { "x-pi-cost-token": "secret-value" },
      });
      assert.equal(withToken.status, 200);

      const readNeedsNoToken = await fetch(`${base}/api/models`);
      assert.equal(readNeedsNoToken.status, 200);
    });
  } finally {
    if (saved === undefined) delete process.env.PI_COST_TOKEN;
    else process.env.PI_COST_TOKEN = saved;
    db.close();
  }
});

test("POST /api/ingest with an empty object reports the contract version it needs", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "unsupported_schema_version");
    assert.equal(body.supported, 1);
  });
  db.close();
});

test("an unknown API path 404s as JSON", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/nothing`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
  });
  db.close();
});

test("openDatabase creates the parent directory and the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-db-"));
  const target = join(dir, "nested", "cost.db");
  try {
    const db = openDatabase(target);
    migrateUp(db);
    db.close();

    assert.equal(existsSync(target), true, "the file is created, parent directory included");

    const reopened = openDatabase(target);
    assert.equal(currentVersion(reopened), 1, "the migration is recorded on disk");
    assert.equal(migrateUp(reopened).applied.length, 0, "reopening applies nothing");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
