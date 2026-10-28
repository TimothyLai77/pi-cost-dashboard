/**
 * Unit tests for ingest validation and the guarded store path.
 *
 * A valid payload is built from the fixture aggregation, so totals and facts agree by
 * construction and the tests target one rule at a time.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { openDatabase, migrateUp } from "../db.js";
import { upsertSession } from "../upsert.js";
import { aggregateSession } from "../scanner/aggregate.js";
import { SCHEMA_VERSION, ingestSession, payloadToRecord, validateIngestPayload } from "../ingest.js";
import { createApp } from "../index.js";

const fixturesDir = join(import.meta.dirname, "fixtures");

/**
 * A valid v1 payload built from a fixture file.
 * @param {string} [fixture]
 * @returns {object}
 */
const validPayload = (fixture = "full-usage.jsonl") => {
  const { session, events } = aggregateSession(join(fixturesDir, fixture));
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
    reportedAt: "2026-01-02T12:00:00.000Z",
  };
};

/**
 * A migrated in-memory database.
 * @returns {import("better-sqlite3").Database}
 */
const freshDb = () => {
  const db = openDatabase(":memory:");
  migrateUp(db);
  return db;
};

test("a valid payload is stored and marked provisional", () => {
  const db = freshDb();
  const response = ingestSession(db, validPayload());

  assert.equal(response.status, 201);
  assert.equal(response.body.applied, true);

  const row = db.prepare("SELECT * FROM sessions").get();
  assert.equal(row.last_source, "push");
  assert.equal(row.cost_micros, 19250);

  const facts = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
  assert.equal(facts, 8);
  db.close();
});

test("re-sending the same snapshot does not duplicate facts", () => {
  const db = freshDb();
  ingestSession(db, validPayload());
  const second = ingestSession(db, validPayload());

  assert.equal(second.status, 201);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 8);
  db.close();
});

test("a snapshot with fewer entries is refused and says why", () => {
  const db = freshDb();
  const payload = validPayload();
  ingestSession(db, payload);

  // Only entryCount is lowered. Totals stay consistent with the events, so validation
  // passes and the request reaches the staleness guard.
  const stale = { ...payload, entryCount: payload.entryCount - 4 };
  const response = ingestSession(db, stale);

  assert.equal(response.status, 200, "a rejected snapshot is a normal outcome, not an error");
  assert.equal(response.body.applied, false);
  assert.equal(response.body.reason, "stale_snapshot");

  assert.equal(db.prepare("SELECT cost_micros FROM sessions").get().cost_micros, 19250);
  db.close();
});

test("a scan overwrites a provisional push", () => {
  const db = freshDb();
  const payload = validPayload();
  ingestSession(db, { ...payload, entryCount: payload.entryCount + 50 });

  const { session, events } = aggregateSession(join(fixturesDir, "full-usage.jsonl"));
  upsertSession(db, session, events, "scan");

  const row = db.prepare("SELECT last_source, cost_micros FROM sessions").get();
  assert.equal(row.last_source, "scan");
  assert.equal(row.cost_micros, 19250);
  db.close();
});

test("an unsupported schema version is refused before anything is read", () => {
  const result = validateIngestPayload({ ...validPayload(), schemaVersion: 99 });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, "unsupported_schema_version");
  assert.equal(result.supported, SCHEMA_VERSION);
});

test("a missing required field is refused with the field named", () => {
  const payload = validPayload();
  delete payload.sessionId;
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, false);
  assert.equal(result.field, "sessionId");
  assert.equal(result.reason, "required");
});

test("a malformed session id, timestamp, and reporter are refused", () => {
  const cases = [
    { field: "sessionId", payload: { ...validPayload(), sessionId: "not-a-uuid" } },
    { field: "startedAt", payload: { ...validPayload(), startedAt: "yesterday" } },
    { field: "lastActivityAt", payload: { ...validPayload(), lastActivityAt: "2026-01-02" } },
    { field: "reportedBy", payload: { ...validPayload(), reportedBy: "whenever" } },
    { field: "entryCount", payload: { ...validPayload(), entryCount: 2.5 } },
    { field: "entryCount", payload: { ...validPayload(), entryCount: -3 } },
  ];

  for (const { field, payload } of cases) {
    const result = validateIngestPayload(payload);
    assert.equal(result.ok, false, `${field} should be refused`);
    assert.equal(result.field, field);
  }
});

test("unknown top-level keys are refused, including transcript-shaped ones", () => {
  for (const key of ["prompt", "transcript", "toolOutput", "assistantText", "apiKey"]) {
    const result = validateIngestPayload({ ...validPayload(), [key]: "content" });
    assert.equal(result.ok, false, `${key} must not be accepted`);
    assert.equal(result.error, "unknown_field");
    assert.equal(result.field, key);
  }
});

test("unknown keys inside totals and events are refused", () => {
  const inTotals = validateIngestPayload({
    ...validPayload(),
    totals: { ...validPayload().totals, promptTokens: 5 },
  });
  assert.equal(inTotals.ok, false);
  assert.match(inTotals.field, /^totals\./);

  const events = validPayload().events.map((event) => ({ ...event, text: "leak" }));
  const inEvent = validateIngestPayload({ ...validPayload(), events });
  assert.equal(inEvent.ok, false);
  assert.match(inEvent.field, /^events\[0\]\./);
});

test("negative money and token counts are refused", () => {
  const payload = validPayload();
  const negativeCost = validateIngestPayload({
    ...payload,
    events: payload.events.map((event) => ({ ...event, costMicros: -1 })),
  });
  assert.equal(negativeCost.ok, false);

  const negativeTotals = validateIngestPayload({
    ...payload,
    totals: { ...payload.totals, outputTokens: -10 },
  });
  assert.equal(negativeTotals.ok, false);
});

test("an unknown usage kind is refused", () => {
  const events = validPayload().events.map((event) => ({ ...event, kind: "vibes" }));
  const result = validateIngestPayload({ ...validPayload(), events });

  assert.equal(result.ok, false);
  assert.match(result.reason, /must be one of/);
});

test("totals that disagree with the events are refused", () => {
  const payload = validPayload();

  const inflated = validateIngestPayload({
    ...payload,
    totals: { ...payload.totals, costMicros: payload.totals.costMicros + 50_000 },
  });
  assert.equal(inflated.ok, false);
  assert.match(inflated.field, /costMicros/);

  const inflatedTokens = validateIngestPayload({
    ...payload,
    totals: { ...payload.totals, totalTokens: payload.totals.totalTokens + 200_000 },
  });
  assert.equal(inflatedTokens.ok, false);

  // A rounding-level difference is tolerated; the check is for broken clients.
  const tiny = validateIngestPayload({
    ...payload,
    totals: { ...payload.totals, costMicros: payload.totals.costMicros + 3 },
  });
  assert.equal(tiny.ok, true);
});

test("an oversized events array is refused", () => {
  const events = Array.from({ length: 10_001 }, (unused, index) => ({
    entryId: `e${index}`,
    kind: "assistant",
    occurredAt: "2026-01-01T00:00:00.000Z",
    costMicros: 0,
  }));
  const payload = {
    ...validPayload(),
    events,
    totals: { ...validPayload().totals, costMicros: 0, totalTokens: 0 },
  };
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, false);
  assert.match(result.reason, /too many events/);
});

test("a long session name is refused", () => {
  const result = validateIngestPayload({ ...validPayload(), name: "x".repeat(300) });

  assert.equal(result.ok, false);
  assert.equal(result.field, "name");
});

test("payloadToRecord maps snake-case columns from the camel-case payload", () => {
  const payload = validPayload("forked-zero-cost.jsonl");
  const { session, events } = payloadToRecord(payload);

  assert.equal(session.parentSessionId, payload.parentSessionId);
  assert.equal(session.totalMessages, payload.totals.totalMessages);
  assert.equal(events[0].entryId, payload.events[0].entryId);
  assert.equal(events[0].kind, "assistant");
});

/**
 * Run a block of requests against the app on an ephemeral port.
 * @param {import("better-sqlite3").Database} db
 * @param {(base: string) => Promise<void>} block
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

test("POST /api/ingest stores a snapshot and answers 201", async () => {
  const db = freshDb();
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload()),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.applied, true);
    assert.equal(body.costMicros, 19250);

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.sessionCount, 1);
  });
  db.close();
});

test("POST /api/ingest requires the shared secret when one is configured", async () => {
  const db = freshDb();
  const saved = process.env.PI_COST_TOKEN;
  try {
    process.env.PI_COST_TOKEN = "shared-secret";
    await withServer(db, async (base) => {
      const noToken = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(noToken.status, 401);

      const withToken = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pi-cost-token": "shared-secret" },
        body: JSON.stringify(validPayload()),
      });
      assert.equal(withToken.status, 201);
    });
  } finally {
    if (saved === undefined) delete process.env.PI_COST_TOKEN;
    else process.env.PI_COST_TOKEN = saved;
    db.close();
  }
});

test("POST /api/ingest answers a validation problem the extension can act on", async () => {
  const db = freshDb();
  const payload = validPayload();
  payload.totals.costMicros = 10_000_000;
  await withServer(db, async (base) => {
    const response = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, "invalid_payload");
    assert.match(body.field, /costMicros/);
    assert.match(body.reason, /must match the sum of events/);
  });
  db.close();
});
