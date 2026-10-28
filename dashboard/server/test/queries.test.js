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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { currentVersion, listMigrations, openDatabase, migrateUp } from "../db.js";

/** Newest migration version a fresh database should report. @type {number} */
const LATEST_VERSION = listMigrations().at(-1).version;
import { upsertSession } from "../upsert.js";
import { aggregateSession } from "../scanner/aggregate.js";
import {
  getDailyCost,
  getHourlyCost,
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

/**
 * A migrated in-memory database holding the fixture sessions plus the nested subagent.
 * The subagent bills 7,000 micros on 2026-01-01 and names full-usage as its parent.
 * @returns {import("better-sqlite3").Database}
 */
const seededDbWithSubagent = () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  for (const fixture of ["full-usage.jsonl", "usage-only.jsonl", "subagent.jsonl"]) {
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
  assert.equal(health.schemaVersion, currentVersion(db), "the applied migration version");
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

test("getHourlyCost bills a day's spend to the hour it happened in", () => {
  const db = seededDb();
  const hourly = getHourlyCost(db, { day: "2026-01-01" });

  // The whole day is returned, so an empty hour is a visible zero and not a gap.
  assert.equal(hourly.points.length, 24);
  assert.equal(hourly.points[0].hour, "2026-01-01 00:00");
  assert.equal(hourly.points[23].hour, "2026-01-01 23:00");

  const billed = hourly.points.filter((point) => point.costMicros > 0);
  assert.equal(billed.length, 1);
  // full-usage bills at 10:00:05Z.
  assert.equal(billed[0].label, "10:00");
  assert.equal(billed[0].costMicros, 19150);
  assert.equal(billed[0].sessions, 1);

  // The hours must add up to the same figure the daily chart shows for that day.
  const daily = getDailyCost(db, { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(
    hourly.totalCostMicros,
    daily.points.reduce((sum, point) => sum + point.costMicros, 0),
  );
  db.close();
});

test("getHourlyCost moves buckets with the timezone offset, matching the day labels", () => {
  const db = seededDb();
  const utc = getHourlyCost(db, { day: "2026-01-01" }).points.find((p) => p.costMicros > 0);
  const shifted = getHourlyCost(db, { day: "2026-01-01", tzOffsetMinutes: 120 }).points.find(
    (p) => p.costMicros > 0,
  );

  assert.equal(utc.label, "10:00");
  assert.equal(shifted.label, "12:00");
  assert.equal(shifted.costMicros, utc.costMicros);
  db.close();
});

test("getHourlyCost honours the project and provider filters", () => {
  const db = seededDb();
  const day = "2026-01-01";
  const project = getHourlyCost(db, { day, cwd: "/no/such/project" });
  assert.equal(project.totalCostMicros, 0);
  assert.equal(project.points.length, 24);

  const provider = getHourlyCost(db, { day, provider: "anthropic" });
  assert.equal(provider.totalCostMicros, 19150);

  const missing = getHourlyCost(db, { day, provider: "not-a-provider" });
  assert.equal(missing.totalCostMicros, 0);
  db.close();
});

test("aggregateSession reads the parent session UUID out of the header's path", () => {
  const { session } = aggregateSession(join(import.meta.dirname, "fixtures", "subagent.jsonl"));

  // Pi writes a file path there; the dashboard wants the id inside it.
  assert.equal(session.parentSessionId, "11111111-1111-4111-8111-111111111111");
  assert.ok(session.parentSessionFile.endsWith("_11111111-1111-4111-8111-111111111111.jsonl"));
});

test("migration 002 turns stored parent paths into parent ids", () => {
  const db = openDatabase(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "migrations", "001_init.sql"), "utf8"));

  // What the scanner wrote before the fix: the whole path, in the id column.
  db.prepare(
    `INSERT INTO sessions (session_id, session_file, parent_session_id, cwd, started_at, last_activity_at, entry_count, last_source)
     VALUES ('child', '/x/child.jsonl', '/data/2026-01-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl', '/x', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', 1, 'scan')`,
  ).run();

  db.exec(readFileSync(join(import.meta.dirname, "..", "migrations", "002_parent_link.sql"), "utf8"));

  const row = db.prepare("SELECT parent_session_id, parent_session_file FROM sessions").get();
  assert.equal(row.parent_session_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(row.parent_session_file.endsWith(".jsonl"));
  db.close();
});

test("totals include nested subagent spend by default and can exclude it", () => {
  const db = seededDbWithSubagent();
  const withSubagents = getSummary(db, null, { includeSubagents: true }).allTime;
  const without = getSummary(db, null, { includeSubagents: false }).allTime;

  // subagent.jsonl bills 1000 + 2000 + 4000 = 7000 micros of the total.
  assert.equal(withSubagents.costMicros - without.costMicros, 7000);
  assert.equal(withSubagents.sessions - without.sessions, 1);
  db.close();
});

test("getSessions flags subagent rows and can drop them", () => {
  const db = seededDbWithSubagent();
  const all = getSessions(db, { limit: 50 });
  const nested = all.sessions.filter((session) => session.isSubagent);
  assert.equal(nested.length, 1);
  assert.equal(nested[0].parentSessionId, "11111111-1111-4111-8111-111111111111");

  const direct = getSessions(db, { limit: 50, includeSubagents: false });
  assert.equal(direct.sessions.some((session) => session.isSubagent), false);
  assert.equal(all.total - direct.total, 1);
  db.close();
});

test("daily and hourly points break tokens out by kind", () => {
  const db = seededDb();
  const daily = getDailyCost(db, { from: "2026-01-01", to: "2026-01-01" }).points[0];
  assert.ok(daily.cacheReadTokens > 0, "cache reads are reported");
  assert.ok(daily.outputTokens > 0, "output is reported");
  assert.equal(
    daily.totalTokens,
    daily.inputTokens + daily.outputTokens + daily.cacheReadTokens + daily.cacheWriteTokens,
  );

  const hourly = getHourlyCost(db, { day: "2026-01-01" }).points.find((p) => p.costMicros > 0);
  assert.equal(
    hourly.totalTokens,
    hourly.inputTokens + hourly.outputTokens + hourly.cacheReadTokens + hourly.cacheWriteTokens,
  );
  assert.ok(hourly.events > 0, "the number of billed calls is reported");
  db.close();
});

test("the subagents flag filters every aggregate and rejects a non-flag", async () => {
  const db = seededDbWithSubagent();
  await withServer(db, async (base) => {
    const summaryAll = await (await fetch(`${base}/api/summary`)).json();
    const summaryDirect = await (await fetch(`${base}/api/summary?subagents=0`)).json();
    assert.equal(summaryAll.allTime.costMicros - summaryDirect.allTime.costMicros, 7000);

    const dailyAll = await (await fetch(`${base}/api/daily?from=2026-01-01&to=2026-01-01`)).json();
    const dailyDirect = await (
      await fetch(`${base}/api/daily?from=2026-01-01&to=2026-01-01&subagents=0`)
    ).json();
    assert.equal(dailyAll.totalCostMicros - dailyDirect.totalCostMicros, 7000);

    const hourlyAll = await (await fetch(`${base}/api/hourly?day=2026-01-01`)).json();
    const hourlyDirect = await (await fetch(`${base}/api/hourly?day=2026-01-01&subagents=0`)).json();
    assert.equal(hourlyAll.totalCostMicros - hourlyDirect.totalCostMicros, 7000);

    const modelsAll = await (await fetch(`${base}/api/models`)).json();
    const modelsDirect = await (await fetch(`${base}/api/models?subagents=0`)).json();
    const sum = (rows) => rows.reduce((total, row) => total + row.costMicros, 0);
    assert.equal(sum(modelsAll) - sum(modelsDirect), 7000);

    const sessionsAll = await (await fetch(`${base}/api/sessions?limit=50`)).json();
    const sessionsDirect = await (await fetch(`${base}/api/sessions?limit=50&subagents=0`)).json();
    assert.equal(sessionsAll.total - sessionsDirect.total, 1);

    const bad = await fetch(`${base}/api/summary?subagents=maybe`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).parameter, "subagents");
  });
  db.close();
});

test("GET /api/hourly returns a full day of hours and rejects a bad day", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const ok = await fetch(`${base}/api/hourly?day=2026-01-01`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.points.length, 24);
    assert.equal(body.day, "2026-01-01");

    const noDay = await fetch(`${base}/api/hourly`);
    assert.equal(noDay.status, 400);
    assert.equal((await noDay.json()).parameter, "day");

    const badDay = await fetch(`${base}/api/hourly?day=01-01-2026`);
    assert.equal(badDay.status, 400);
    assert.equal((await badDay.json()).parameter, "day");

    const badOffset = await fetch(`${base}/api/hourly?day=2026-01-01&tzOffsetMinutes=x`);
    assert.equal(badOffset.status, 400);
    assert.equal((await badOffset.json()).parameter, "tzOffsetMinutes");
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
    assert.equal(currentVersion(reopened), LATEST_VERSION, "every migration is recorded on disk");
    assert.equal(migrateUp(reopened).applied.length, 0, "reopening applies nothing");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
