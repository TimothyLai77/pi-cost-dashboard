/**
 * Ingest: validate a session snapshot from the Pi extension, then store it.
 *
 * Validation is written by hand against pi-extension/payload.schema.json rather than
 * pulled from a schema library, so the server keeps no extra dependency and the checks
 * stay readable in one place. The contract file is the source of truth for field names,
 * and the key lists below are derived from it.
 *
 * Two of the checks exist for privacy and drift, not correctness:
 *   - Unknown keys are rejected. A future extension version cannot quietly start sending
 *     transcript content into the database.
 *   - `totals` must match the sum of `events`. A broken client is refused rather than
 *     trusted with a number the dashboard would display as fact.
 */

import { upsertSession } from "./upsert.js";

/** Supported contract version. @type {number} */
export const SCHEMA_VERSION = 1;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-fA-F-]{36}$/;

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "sessionId",
  "sessionFile",
  "cwd",
  "name",
  "parentSessionId",
  "parentSessionFile",
  "startedAt",
  "lastActivityAt",
  "entryCount",
  "totals",
  "events",
  "reportedBy",
  "reportedAt",
]);

const TOP_LEVEL_REQUIRED = [
  "schemaVersion",
  "sessionId",
  "sessionFile",
  "cwd",
  "startedAt",
  "lastActivityAt",
  "entryCount",
  "totals",
  "events",
  "reportedBy",
];

const TOTAL_KEYS = new Set([
  "costMicros",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "userMessages",
  "assistantMessages",
  "toolCalls",
  "toolResults",
  "totalMessages",
]);

const TOTAL_REQUIRED = [
  "costMicros",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
];

const EVENT_KEYS = new Set([
  "entryId",
  "kind",
  "occurredAt",
  "provider",
  "modelId",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "costMicros",
]);

const EVENT_REQUIRED = ["entryId", "kind", "occurredAt", "costMicros"];

const EVENT_KINDS = new Set(["assistant", "tool_result", "usage", "compaction", "branch_summary"]);
const REPORTERS = new Set(["command", "agent_settled", "shutdown"]);

/**
 * @param {string} field
 * @param {string} reason
 * @returns {{ ok: false, status: number, error: string, field: string, reason: string }}
 */
const reject = (field, reason) => ({
  ok: false,
  status: 422,
  error: "invalid_payload",
  field,
  reason,
});

/**
 * A non-negative integer, as required for every token and money field.
 * @param {unknown} value
 * @returns {boolean}
 */
const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Validate an ingest payload against the v1 contract.
 * @param {any} body Parsed request body
 * @returns {{ ok: true, payload: any } | { ok: false, status: number, error: string, field?: string, reason?: string }}
 */
export const validateIngestPayload = (body) => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_payload", reason: "body must be a JSON object" };
  }

  if (body.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      status: 400,
      error: "unsupported_schema_version",
      received: body.schemaVersion ?? null,
      supported: SCHEMA_VERSION,
    };
  }

  for (const key of Object.keys(body)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, status: 400, error: "unknown_field", field: key };
    }
  }

  for (const key of TOP_LEVEL_REQUIRED) {
    if (body[key] === undefined || body[key] === null) {
      return reject(key, "required");
    }
  }

  if (!UUID.test(body.sessionId)) return reject("sessionId", "must be a UUID");
  if (typeof body.sessionFile !== "string" || body.sessionFile.length === 0) {
    return reject("sessionFile", "must be a non-empty string");
  }
  if (typeof body.cwd !== "string" || body.cwd.length === 0) {
    return reject("cwd", "must be a non-empty string");
  }
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== "string") return reject("name", "must be a string when present");
    if (body.name.length > 200) return reject("name", "must be 200 characters or fewer");
  }
  if (!ISO_8601.test(body.startedAt)) return reject("startedAt", "must be ISO-8601 UTC");
  if (!ISO_8601.test(body.lastActivityAt)) return reject("lastActivityAt", "must be ISO-8601 UTC");
  if (!isCount(body.entryCount)) return reject("entryCount", "must be a non-negative integer");
  if (!REPORTERS.has(body.reportedBy)) return reject("reportedBy", "must be command, agent_settled, or shutdown");
  if (body.reportedAt !== undefined && body.reportedAt !== null && !ISO_8601.test(body.reportedAt)) {
    return reject("reportedAt", "must be ISO-8601 UTC");
  }

  const totals = body.totals;
  if (totals === null || typeof totals !== "object" || Array.isArray(totals)) {
    return reject("totals", "must be an object");
  }
  for (const key of Object.keys(totals)) {
    if (!TOTAL_KEYS.has(key)) return reject(`totals.${key}`, "unknown field");
  }
  for (const key of TOTAL_REQUIRED) {
    if (!isCount(totals[key])) return reject(`totals.${key}`, "must be a non-negative integer");
  }
  for (const key of Object.keys(totals)) {
    if (!isCount(totals[key])) return reject(`totals.${key}`, "must be a non-negative integer");
  }

  if (!Array.isArray(body.events)) return reject("events", "must be an array");
  if (body.events.length > 10_000) return reject("events", "too many events (max 10000)");

  let eventCostMicros = 0;
  let eventTotalTokens = 0;

  for (const [index, event] of body.events.entries()) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return reject(`events[${index}]`, "must be an object");
    }
    for (const key of Object.keys(event)) {
      if (!EVENT_KEYS.has(key)) return reject(`events[${index}].${key}`, "unknown field");
    }
    for (const key of EVENT_REQUIRED) {
      if (event[key] === undefined || event[key] === null) return reject(`events[${index}].${key}`, "required");
    }
    if (typeof event.entryId !== "string" || event.entryId.length === 0) {
      return reject(`events[${index}].entryId`, "must be a non-empty string");
    }
    if (!EVENT_KINDS.has(event.kind)) {
      return reject(`events[${index}].kind`, `must be one of ${[...EVENT_KINDS].join(", ")}`);
    }
    if (!ISO_8601.test(event.occurredAt)) {
      return reject(`events[${index}].occurredAt`, "must be ISO-8601 UTC");
    }
    if (!isCount(event.costMicros)) {
      return reject(`events[${index}].costMicros`, "must be a non-negative integer");
    }
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"]) {
      if (event[key] !== undefined && event[key] !== null && !isCount(event[key])) {
        return reject(`events[${index}].${key}`, "must be a non-negative integer");
      }
    }
    for (const key of ["provider", "modelId"]) {
      if (event[key] !== undefined && event[key] !== null && typeof event[key] !== "string") {
        return reject(`events[${index}].${key}`, "must be a string when present");
      }
    }
    eventCostMicros += event.costMicros;
    eventTotalTokens += event.totalTokens ?? 0;
  }

  // Totals must agree with the facts, within a rounding allowance. Two independent
  // computations that disagree mean the client is broken, and a bad total would be
  // displayed as fact.
  const costTolerance = Math.max(10, Math.round(totals.costMicros * 0.01));
  if (Math.abs(totals.costMicros - eventCostMicros) > costTolerance) {
    return reject("totals.costMicros", `must match the sum of events (${eventCostMicros})`);
  }
  const tokenTolerance = Math.max(100, Math.round(totals.totalTokens * 0.01));
  if (Math.abs(totals.totalTokens - eventTotalTokens) > tokenTolerance) {
    return reject("totals.totalTokens", `must match the sum of events (${eventTotalTokens})`);
  }

  return { ok: true, payload: body };
}

/**
 * Convert a validated payload into the shape the upsert expects.
 * @param {any} payload Validated body
 * @returns {{ session: object, events: object[] }}
 */
export const payloadToRecord = (payload) => ({
  session: {
    sessionId: payload.sessionId,
    sessionFile: payload.sessionFile,
    parentSessionId: payload.parentSessionId ?? null,
    parentSessionFile:
      typeof payload.parentSessionFile === "string" && payload.parentSessionFile.length > 0
        ? payload.parentSessionFile
        : null,
    cwd: payload.cwd,
    name: payload.name ?? null,
    startedAt: payload.startedAt,
    lastActivityAt: payload.lastActivityAt,
    entryCount: payload.entryCount,
    costMicros: payload.totals.costMicros,
    inputTokens: payload.totals.inputTokens ?? 0,
    outputTokens: payload.totals.outputTokens ?? 0,
    cacheReadTokens: payload.totals.cacheReadTokens ?? 0,
    cacheWriteTokens: payload.totals.cacheWriteTokens ?? 0,
    totalTokens: payload.totals.totalTokens ?? 0,
    userMessages: payload.totals.userMessages ?? 0,
    assistantMessages: payload.totals.assistantMessages ?? 0,
    toolCalls: payload.totals.toolCalls ?? 0,
    toolResults: payload.totals.toolResults ?? 0,
    totalMessages: payload.totals.totalMessages ?? 0,
  },
  events: payload.events.map((event) => ({
    entryId: event.entryId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    provider: event.provider ?? null,
    modelId: event.modelId ?? null,
    inputTokens: event.inputTokens ?? 0,
    outputTokens: event.outputTokens ?? 0,
    cacheReadTokens: event.cacheReadTokens ?? 0,
    cacheWriteTokens: event.cacheWriteTokens ?? 0,
    totalTokens: event.totalTokens ?? 0,
    costMicros: event.costMicros,
  })),
});

/**
 * Validate a payload and store it.
 *
 * A rejected update is a normal outcome, not an error: it means a fresher snapshot is
 * already stored, and the stale one is discarded. The response says so with applied:
 * false, so the extension does not retry in a loop.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {any} body Parsed request body
 * @returns {{ status: number, body: object }} HTTP status and response body
 */
export const ingestSession = (db, body) => {
  const validated = validateIngestPayload(body);
  if (!validated.ok) return { status: validated.status, body: validated };

  const { session, events } = payloadToRecord(validated.payload);
  const applied = upsertSession(db, session, events, "push");

  return {
    status: applied ? 201 : 200,
    body: {
      ok: true,
      applied,
      sessionId: session.sessionId,
      ...(applied
        ? { costMicros: session.costMicros, totalTokens: session.totalTokens, source: "push" }
        : { reason: "stale_snapshot", detail: "a snapshot with at least this many entries is already stored" }),
    },
  };
};
