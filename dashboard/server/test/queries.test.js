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
  getFlows,
  getHourlyCost,
  getFilters,
  getHealth,
  getLifetimeStats,
  getModelCost,
  getSessionById,
  getSessions,
  getSummary,
  MAX_PAGE_SIZE,
} from "../queries.js";
import { createApp } from "../index.js";
import { SCHEMA_VERSION } from "../ingest.js";

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

/**
 * A migrated in-memory database whose nested session lives in a project of its own.
 *
 * `subagent.jsonl` nests inside project-a, which is already in the set, so it cannot change
 * the project count. `forked-zero-cost.jsonl` nests in project-c and bills nothing, which
 * makes it the fixture that can show the subagent filter adding and removing a project.
 *
 * @returns {import("better-sqlite3").Database}
 */
const seededDbWithForkedChild = () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  for (const fixture of ["full-usage.jsonl", "usage-only.jsonl", "forked-zero-cost.jsonl"]) {
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

test("getDailyCost buckets days by the zone it is given", () => {
  const db = seededDb();

  const utc = getDailyCost(db, { from: "2026-01-01", to: "2026-01-05" });
  // full-usage bills at 2026-01-01T10:00:05Z. UTC+14 (Kiritimati) reads that as Jan 2.
  const east = getDailyCost(db, { from: "2026-01-01", to: "2026-01-05", timeZone: "Pacific/Kiritimati" });
  const denver = getDailyCost(db, { from: "2026-01-01", to: "2026-01-05", timeZone: "America/Denver" });

  assert.equal(utc.points[0].day, "2026-01-01");
  assert.equal(utc.range.timeZone, "UTC");
  assert.equal(utc.range.offsetLabel, "UTC");

  const eastBilled = east.points.find((point) => point.costMicros > 0);
  assert.equal(eastBilled.day, "2026-01-02");
  assert.equal(east.range.timeZone, "Pacific/Kiritimati");
  assert.equal(east.range.offsetLabel, "UTC+14");

  // UTC-7 keeps it on the same day, at 03:00 local.
  assert.equal(denver.points.find((point) => point.costMicros > 0).day, "2026-01-01");
  assert.equal(denver.range.offsetLabel, "UTC-7");

  assert.equal(
    east.points.reduce((sum, point) => sum + point.costMicros, 0),
    utc.points.reduce((sum, point) => sum + point.costMicros, 0),
    "a zone moves cost between days, it never changes the total",
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

test("getSessions breaks out the token kinds behind totalTokens", () => {
  const db = seededDb();
  const rows = getSessions(db, { limit: 10 }).sessions;

  for (const row of rows) {
    assert.equal(
      row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
      row.totalTokens,
      "the four kinds add up to the headline total",
    );

    const detail = getSessionById(db, row.sessionId);
    assert.equal(row.inputTokens, detail.tokens.input, "list input matches detail");
    assert.equal(row.outputTokens, detail.tokens.output, "list output matches detail");
    assert.equal(row.cacheReadTokens, detail.tokens.cacheRead, "list cache read matches detail");
    assert.equal(row.cacheWriteTokens, detail.tokens.cacheWrite, "list cache write matches detail");
  }

  // Cache reads dominate a long session, which is exactly what the flat total hides.
  const caching = rows.find((row) => row.cacheReadTokens > 0);
  assert.ok(
    caching.cacheReadTokens > caching.inputTokens + caching.outputTokens,
    "cache reads outweigh the billable kinds",
  );

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

test("getLifetimeStats totals the whole ledger and names the record days", () => {
  const db = seededDb();
  const stats = getLifetimeStats(db);

  assert.equal(stats.range.from, "2026-01-01");
  assert.equal(stats.range.to, "2026-01-03");

  assert.equal(stats.totals.costMicros, 119250);
  assert.equal(stats.totals.totalTokens, 151435);
  assert.equal(stats.totals.sessions, 2, "both fixture sessions recorded usage");
  assert.equal(stats.totals.events, 10, "every usage-bearing entry");
  assert.equal(stats.totals.activeDays, 3);
  assert.equal(stats.totals.calendarDays, 3);
  assert.equal(
    Object.values(stats.totals.costBreakdown).reduce((sum, part) => sum + part.costMicros, 0),
    stats.totals.costMicros,
    "the four money parts add up to the reported total",
  );

  assert.equal(stats.counts.sessions, 2);
  assert.equal(stats.counts.projects, 2);
  assert.equal(stats.counts.models, 2, "claude-sonnet-4-5 and the zero-priced custom model");
  assert.equal(stats.counts.toolCalls, 1);

  // The day series is the heatmap's raw material: one point per day with usage, ascending.
  assert.deepEqual(
    stats.daily.map((point) => [point.day, point.costMicros, point.totalTokens, point.sessions]),
    [
      ["2026-01-01", 19150, 51359, 1],
      ["2026-01-02", 100, 66, 1],
      ["2026-01-03", 100000, 100010, 1],
    ],
  );

  assert.equal(stats.records.mostExpensiveDay.day, "2026-01-03");
  assert.equal(stats.records.busiestTokenDay.day, "2026-01-03");
  assert.equal(stats.records.mostSessionsDay.day, "2026-01-03", "a tie goes to the later day");
  assert.equal(stats.records.biggestSession.sessionId.startsWith("22222222"), true, "usage-only bills most");
  assert.equal(stats.records.longestSession.spanSeconds, 90005, "full-usage spans 2026-01-01 10:00 to 01-02 11:00:05");
  assert.equal(stats.records.biggestCall.costMicros, 100000, "the single cache-warm call in usage-only");
  assert.equal(stats.records.biggestCall.kind, "usage");
  assert.equal(stats.records.biggestCall.occurredAt, "2026-01-03T09:00:01.000Z");
  assert.equal(stats.records.topProjectByCost.cwd, "/home/user/project-b");
  assert.equal(stats.records.topModelByCost.modelId, "claude-sonnet-4-5");
  assert.equal(stats.records.topModelByTokens.modelId, "claude-sonnet-4-5");
  db.close();
});

test("getLifetimeStats shapes the hour-of-day and weekday series for the page", () => {
  const db = seededDb();
  const stats = getLifetimeStats(db);

  // Full 24-hour and 7-weekday series: a hour that never ran is a visible zero, not a hole.
  assert.equal(stats.hoursOfDay.length, 24);
  assert.equal(
    stats.hoursOfDay.reduce((sum, hour) => sum + hour.totalTokens, 0),
    stats.totals.totalTokens,
    "every fact lands in exactly one hour bucket",
  );
  assert.equal(stats.hoursOfDay[9].totalTokens, 100010, "usage-only bills at 09:00Z");
  assert.equal(stats.hoursOfDay[10].costMicros, 19150, "full-usage bills at 10:00Z");

  assert.deepEqual(
    stats.weekdays.map((day) => day.name),
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    "the week starts on Sunday, so the page can draw it in list order",
  );
  assert.equal(stats.weekdays.reduce((sum, day) => sum + day.days, 0), stats.totals.activeDays);
  assert.equal(stats.weekdays[4].name, "Thursday", "2026-01-01 is a Thursday");
  assert.equal(stats.weekdays[4].costMicros, 19150);
  assert.equal(stats.weekdays[6].costMicros, 100000, "2026-01-03 is a Saturday");
  db.close();
});

test("getLifetimeStats counts a zero-cost day as an active day", () => {
  const db = seededDbWithForkedChild();
  const stats = getLifetimeStats(db);

  // forked-zero-cost bills nothing on 2026-01-04 and burns 10,000 tokens doing it.
  assert.equal(stats.totals.activeDays, 4, "a day of free local-model work is not a gap");
  assert.equal(stats.totals.calendarDays, 4);
  assert.equal(stats.daily.at(-1).day, "2026-01-04");
  assert.equal(stats.daily.at(-1).costMicros, 0);
  assert.equal(stats.daily.at(-1).totalTokens, 10000);
  assert.equal(stats.totals.costMicros, 119250, "the free day added no money");
  assert.equal(stats.counts.projects, 3, "the nested session lives in project-c");
  db.close();
});

test("getLifetimeStats drops nested subagent spend when asked", () => {
  const withNested = getLifetimeStats(seededDbWithSubagent());
  const directOnly = getLifetimeStats(seededDbWithSubagent(), { includeSubagents: false });

  // subagent.jsonl bills 7,000 micros on 2026-01-01 inside its parent's project.
  assert.equal(withNested.totals.costMicros, 126250);
  assert.equal(directOnly.totals.costMicros, 119250);
  assert.equal(withNested.totals.sessions, 3, "the nested session is a session");
  assert.equal(directOnly.totals.sessions, 2);
  assert.equal(directOnly.counts.projects, 2, "the filter is the ledger's, not a new project view");
  assert.equal(
    directOnly.hoursOfDay.reduce((sum, hour) => sum + hour.events, 0),
    directOnly.totals.events,
    "the hour series follows the filter, as the day series does",
  );
});

test("getLifetimeStats groups days on the zone it is given", () => {
  const utc = getLifetimeStats(seededDb());
  const east = getLifetimeStats(seededDb(), { timeZone: "Pacific/Kiritimati" });

  // UTC+14 reads 2026-01-01T10:00Z as Jan 2, and pushes 2026-01-02T11:00Z into Jan 3, so the
  // record days move with the zone while the totals stay put.
  assert.equal(utc.range.offsetLabel, "UTC");
  assert.equal(east.range.offsetLabel, "UTC+14");
  assert.equal(east.daily.length, 2, "two local days: Jan 1 disappears, Jan 4 never existed");
  assert.equal(east.daily[0].day, "2026-01-02");
  assert.equal(east.daily[0].costMicros, 19150, "the Jan 1 spend, read on the far-east wall clock");
  assert.equal(east.daily[1].costMicros, 100100, "Jan 2's 100 micros arrive on Jan 3 in UTC+14");
  assert.equal(east.totals.costMicros, utc.totals.costMicros, "a zone moves days, it never changes the total");
  assert.equal(east.totals.calendarDays, 2);
});

/**
 * Start the app on an ephemeral port and run a block of requests against it.
 * @param {import("better-sqlite3").Database} db
 * @param {(baseUrl: string) => Promise<void>} block
 * @returns {Promise<void>}
 */
const withServer = async (db, block, timeZone = null) => {
  const app = createApp(db, { sessionsDir: "/tmp/sessions", rescan: () => ({ scanned: 0 }), timeZone });
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

test("GET /api/lifetime reports the whole ledger with no range to choose", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/lifetime`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totals.costMicros, 119250);
    assert.equal(body.totals.costUsd, "$0.12");
    assert.equal(body.daily.length, 3);
    assert.equal(body.records.mostExpensiveDay.costUsd, "$0.10");

    const withoutNested = await fetch(`${base}/api/lifetime?subagents=0`);
    assert.equal((await withoutNested.json()).totals.costMicros, 119250);

    const badFlag = await fetch(`${base}/api/lifetime?subagents=maybe`);
    assert.equal(badFlag.status, 400);
    assert.equal((await badFlag.json()).parameter, "subagents");
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

test("getHourlyCost labels hours on the zone's wall clock", () => {
  const db = seededDb();
  const utc = getHourlyCost(db, { day: "2026-01-01" }).points.find((p) => p.costMicros > 0);
  const istResult = getHourlyCost(db, { day: "2026-01-01", timeZone: "Asia/Kolkata" });
  const ist = istResult.points.find((p) => p.costMicros > 0);
  const denver = getHourlyCost(db, { day: "2026-01-01", timeZone: "America/Denver" }).points.find(
    (p) => p.costMicros > 0,
  );

  // The same fact, 2026-01-01T10:00:05Z: 10:00 UTC, 15:30 in Kolkata, 03:00 in Denver.
  assert.equal(utc.label, "10:00");
  assert.equal(ist.label, "15:00");
  assert.equal(denver.label, "03:00");
  assert.equal(ist.hour, "2026-01-01 15:00");
  assert.equal(ist.costMicros, utc.costMicros);
  assert.equal(istResult.range.offsetLabel, "UTC+5:30");
  assert.equal(istResult.range.from, "2026-01-01 00:00");
  assert.equal(istResult.range.to, "2026-01-01 23:00");
  assert.equal(istResult.points.length, 24);
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

test("summary, daily and hourly report the money in the four parts Pi bills", () => {
  const db = seededDb();

  // full-usage: 265 input, 485 output, 17900 cache read, 500 cache write on 2026-01-01,
  // and 11/22/67/0 on 2026-01-02. usage-only bills its 100000 entirely as cache reads.
  const summary = getSummary(db);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(summary.allTime.costBreakdown).map(([part, value]) => [part, value.costMicros]),
    ),
    { input: 276, output: 507, cacheRead: 117967, cacheWrite: 500 },
  );
  assert.equal(
    Object.values(summary.allTime.costBreakdown).reduce((sum, part) => sum + part.costMicros, 0),
    summary.allTime.costMicros,
    "the parts add up to the reported total",
  );
  assert.equal(summary.allTime.costBreakdown.cacheRead.costUsd, "$0.12", "each part carries a display string");

  const daily = getDailyCost(db, { from: "2026-01-01", to: "2026-01-04" }).points;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(daily[0].costBreakdown).map(([part, value]) => [part, value.costMicros]),
    ),
    { input: 265, output: 485, cacheRead: 17900, cacheWrite: 500 },
    "the first day's split",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(daily[2].costBreakdown).map(([part, value]) => [part, value.costMicros]),
    ),
    { input: 0, output: 0, cacheRead: 100000, cacheWrite: 0 },
    "a cache warm bills its money entirely as cache reads",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(daily[3].costBreakdown).map(([part, value]) => [part, value.costUsd]),
    ),
    { input: "$0.00", output: "$0.00", cacheRead: "$0.00", cacheWrite: "$0.00" },
    "a day with no spend has four zero parts, not a missing breakdown",
  );

  const hourly = getHourlyCost(db, { day: "2026-01-01" }).points;
  const partsFromHours = hourly.reduce(
    (totals, point) => ({
      input: totals.input + point.costBreakdown.input.costMicros,
      output: totals.output + point.costBreakdown.output.costMicros,
      cacheRead: totals.cacheRead + point.costBreakdown.cacheRead.costMicros,
      cacheWrite: totals.cacheWrite + point.costBreakdown.cacheWrite.costMicros,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.deepEqual(partsFromHours, { input: 265, output: 485, cacheRead: 17900, cacheWrite: 500 });
  assert.equal(
    Object.values(partsFromHours).reduce((sum, value) => sum + value, 0),
    hourly.reduce((sum, point) => sum + point.costMicros, 0),
    "the hours' parts add up to the day's cost",
  );
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

test("getFlows draws money as model-to-project bands, leaving out what has no money", () => {
  const db = seededDb();
  const flows = getFlows(db);

  assert.equal(flows.metric, "cost");
  assert.equal(flows.nodeLimit, 6);
  assert.deepEqual(
    flows.links.map((link) => [link.source, link.target, link.costMicros]),
    [
      ["model:anthropic/claude-sonnet-4-5", "project:/home/user/project-b", 100000],
      ["model:anthropic/claude-sonnet-4-5", "project:/home/user/project-a", 19250],
    ],
    "bands are ordered by the chosen metric",
  );

  // Nothing billed is left out, so the drawing is the whole bill in money terms.
  assert.equal(flows.drawn.costMicros, flows.totals.costMicros);

  // The custom-provider model billed nothing: it is counted, not drawn, and not a node.
  assert.equal(flows.dropped.flows, 1);
  assert.equal(flows.dropped.models, 1);
  assert.equal(flows.dropped.projects, 0);
  assert.equal(flows.dropped.rolled.models, 0, "both models fit under the node cap");
  assert.equal(flows.totals.models, 2);
  assert.equal(flows.totals.projects, 2);

  const modelNode = flows.nodes.find((node) => node.kind === "model");
  assert.deepEqual([modelNode.label, modelNode.sublabel], ["claude-sonnet-4-5", "anthropic"]);
  const projectNode = flows.nodes.find((node) => node.id.endsWith("/home/user/project-b"));
  assert.deepEqual([projectNode.label, projectNode.sublabel], ["project-b", "/home/user/project-b"]);

  // Bands carry the four parts of the bill, so a tooltip can say what the money bought.
  assert.equal(flows.links[0].costBreakdown.cacheRead.costMicros, 100000);
  assert.equal(flows.links[0].costBreakdown.output.costMicros, 0);
  db.close();
});

test("getFlows on tokens draws the models that were priced at zero", () => {
  const db = seededDb();
  const flows = getFlows(db, { metric: "tokens" });

  assert.equal(flows.links.length, 3, "the free model's 10 tokens are a band in this view");
  assert.equal(flows.drawn.totalTokens, flows.totals.totalTokens);
  assert.equal(flows.dropped.flows, 0);

  const freeNode = flows.nodes.find((node) => node.label === "cheap-model");
  assert.ok(freeNode, "the free model is a node when tokens are the metric");
  assert.equal(freeNode.costMicros, 0);
  assert.equal(freeNode.sublabel, "custom");
  db.close();
});

test("getFlows rolls the tail into an 'all other' node that carries its own totals", () => {
  const db = seededDb();
  const flows = getFlows(db, { nodeLimit: 1 });

  assert.equal(flows.nodeLimit, 1);
  assert.deepEqual(
    flows.links.map((link) => [link.source, link.target, link.costMicros, link.rolledUp]),
    [
      ["model:anthropic/claude-sonnet-4-5", "project:/home/user/project-b", 100000, false],
      ["model:anthropic/claude-sonnet-4-5", "project:all other", 19250, true],
    ],
  );

  const other = flows.nodes.find((node) => node.id === "project:all other");
  assert.deepEqual([other.label, other.sublabel, other.costMicros], ["all other", "1 more", 19250]);
  assert.equal(other.rolledUp, true);

  // The band sum still equals the whole bill: rolling up is not dropping.
  assert.equal(flows.drawn.costMicros, flows.totals.costMicros);
  assert.equal(flows.dropped.rolled.projects, 1);
  db.close();
});

test("getFlows honours the subagent, project, provider, and date filters", () => {
  const withChild = seededDbWithForkedChild();
  const nested = getFlows(withChild);
  assert.equal(nested.totals.projects, 3, "the nested session's own project is in the window");

  const mainOnly = getFlows(withChild, { includeSubagents: false });
  assert.equal(mainOnly.totals.projects, 2, "the nested session's project drops out with the filter");
  assert.equal(mainOnly.totals.models, 2, "its model drops out too");

  const db = seededDb();
  const project = getFlows(db, { cwd: "/home/user/project-b" });
  assert.equal(project.totals.costMicros, 100000);
  assert.equal(project.totals.projects, 1);

  const provider = getFlows(db, { provider: "custom" });
  assert.deepEqual(
    [provider.links.length, provider.totals.costMicros, provider.dropped.flows],
    [0, 0, 1],
    "the only custom-provider flow billed nothing, so there is no band to draw",
  );

  const oneDay = getFlows(db, { from: "2026-01-03", to: "2026-01-03", timeZone: "America/Denver" });
  assert.deepEqual(
    [oneDay.links.length, oneDay.totals.costMicros],
    [1, 100000],
    "the 2026-01-03 bill lands in that local day",
  );
  db.close();
  withChild.close();
});

test("GET /api/flows sizes bands by the metric asked for and rejects a bad one", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const money = await fetch(`${base}/api/flows`);
    assert.equal(money.status, 200);
    const moneyBody = await money.json();
    assert.equal(moneyBody.metric, "cost");
    assert.equal(moneyBody.links.length, 2);

    const tokens = await fetch(`${base}/api/flows?metric=tokens&limit=1&subagents=0`);
    assert.equal(tokens.status, 200);
    const tokensBody = await tokens.json();
    assert.deepEqual([tokensBody.metric, tokensBody.nodeLimit], ["tokens", 1]);

    const badMetric = await fetch(`${base}/api/flows?metric=rubber`);
    assert.equal(badMetric.status, 400);
    assert.equal((await badMetric.json()).parameter, "metric");

    const badLimit = await fetch(`${base}/api/flows?limit=lots`);
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).parameter, "limit");

    const badDate = await fetch(`${base}/api/flows?from=yesterday`);
    assert.equal(badDate.status, 400);
    assert.equal((await badDate.json()).parameter, "from");
  });
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

test("the server's configured zone drives the charts and is reported by /api/config", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.timezone, "America/Denver");
    assert.equal(config.timezoneSource, "env");
    // October in Denver is daylight time, UTC-6.
    assert.equal(config.offsetLabel, "UTC-6");
    assert.equal(config.utcOffsetMinutes, -360);
  }, "America/Denver");

  await withServer(db, async (base) => {
    // 2026-01-01T10:00:05Z is 03:00 on the same day in Denver (UTC-7), so the Jan 1 spend
    // stays on Jan 1, and the labels say which zone the reader is looking at.
    const daily = await (await fetch(`${base}/api/daily?from=2026-01-01&to=2026-01-02`)).json();
    assert.equal(daily.range.timeZone, "America/Denver");
    assert.equal(daily.range.offsetLabel, "UTC-7");

    const hourly = await (await fetch(`${base}/api/hourly?day=2026-01-01`)).json();
    assert.equal(hourly.range.offsetLabel, "UTC-7");
    assert.equal(hourly.points.find((point) => point.costMicros > 0).label, "03:00");

    // A zone moves money between buckets; it never changes the all-time total.
    const summary = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(summary.allTime.costMicros, 19250 + 100000);
  }, "America/Denver");
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

    const config = await fetch(`${base}/api/config`);
    assert.equal(config.status, 200);
    const configured = await config.json();
    assert.equal(configured.timezone, "UTC", "no zone configured in the test server");
    assert.equal(configured.timezoneSource, "default");
    assert.equal(configured.offsetLabel, "UTC");
  });
  db.close();
});

test("GET /api/daily rejects a malformed date", async () => {
  const db = seededDb();
  await withServer(db, async (base) => {
    const badDate = await fetch(`${base}/api/daily?from=not-a-date`);
    assert.equal(badDate.status, 400);
    assert.equal((await badDate.json()).parameter, "from");

    const ok = await fetch(`${base}/api/daily?from=2026-01-01&to=2026-01-03`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.range.timeZone, "UTC");
    assert.equal(body.range.offsetLabel, "UTC");
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
    assert.equal(body.supported, SCHEMA_VERSION);
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
