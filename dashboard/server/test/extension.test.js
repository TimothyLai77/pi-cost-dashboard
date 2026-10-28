/**
 * Tests for the Pi extension's payload, checked against the server's validator.
 *
 * The extension and the server are written independently, so the useful test is the seam
 * between them: build a payload from a fixture session and require the server to accept it.
 * Node's built-in type stripping imports the extension's TypeScript directly, and its only
 * package import is `import type`, which is erased.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateSession } from "../scanner/aggregate.js";
import { validateIngestPayload } from "../ingest.js";

const extensionPath = join(import.meta.dirname, "..", "..", "..", "pi-extension", "pi-cost.ts");
const { buildPayload, buildSnapshot } = await import(extensionPath);

const fixturesDir = join(import.meta.dirname, "fixtures");

/**
 * A stand-in for the session manager extensions receive, backed by a fixture file.
 * @param {string} name Fixture file name
 * @returns {object}
 */
const fakeSessionManager = (name) => {
  const filePath = join(fixturesDir, name);
  const entries = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return {
    getEntries: () => entries,
    getHeader: () => entries.find((entry) => entry.type === "session"),
    getSessionId: () => entries.find((entry) => entry.type === "session")?.id,
    getSessionFile: () => filePath,
    getCwd: () => entries.find((entry) => entry.type === "session")?.cwd,
  };
};

test("the extension's totals match the server's own aggregation", () => {
  for (const fixture of ["full-usage.jsonl", "usage-only.jsonl", "forked-zero-cost.jsonl"]) {
    const fromFile = aggregateSession(join(fixturesDir, fixture));
    const snapshot = buildSnapshot(fakeSessionManager(fixture));

    assert.equal(snapshot.sessionId, fromFile.session.sessionId, fixture);
    assert.equal(snapshot.costMicros, fromFile.session.costMicros, `${fixture} cost`);
    assert.equal(snapshot.totalTokens, fromFile.session.totalTokens, `${fixture} tokens`);
    assert.equal(snapshot.entryCount, fromFile.session.entryCount, `${fixture} entries`);
    assert.equal(snapshot.facts.length, fromFile.events.length, `${fixture} fact count`);
  }
});

test("the server accepts the extension's payload", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildPayload(snapshot, "agent_settled");
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.reportedBy, "agent_settled");
  assert.equal(payload.totals.costMicros, 19250);
});

test("facts carry the kinds the server's CHECK constraint allows", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const kinds = new Set(snapshot.facts.map((fact) => fact.kind));

  assert.deepEqual(
    [...kinds].sort(),
    ["assistant", "branch_summary", "compaction", "tool_result", "usage"],
  );
});

test("a forked session's parent is reported by session id, not file path", () => {
  const snapshot = buildSnapshot(fakeSessionManager("forked-zero-cost.jsonl"));
  const payload = buildPayload(snapshot, "command");
  const result = validateIngestPayload(payload);

  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(snapshot.parentSessionId, "00000000-0000-4000-8000-000000000000");
});

test("the payload carries no transcript content", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const payload = buildPayload(snapshot, "command");

  const serialized = JSON.stringify(payload);
  for (const forbidden of ["prompt", "transcript", "toolOutput", "content", "text", "apiKey"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `payload must not contain ${forbidden}`);
  }
  assert.ok(serialized.includes("sessionId"), "identifiers are present");
});

test("model attribution falls back to the model in effect", () => {
  const snapshot = buildSnapshot(fakeSessionManager("full-usage.jsonl"));
  const unattributedKinds = snapshot.facts.filter((fact) =>
    ["tool_result", "compaction", "branch_summary"].includes(fact.kind),
  );

  for (const fact of unattributedKinds) {
    assert.equal(fact.provider, "anthropic", `${fact.kind} keeps a provider`);
    assert.equal(fact.modelId, "claude-sonnet-4-5", `${fact.kind} keeps a model`);
  }
});

test("an unpriced session is still a valid payload", () => {
  const snapshot = buildSnapshot(fakeSessionManager("forked-zero-cost.jsonl"));
  const result = validateIngestPayload(buildPayload(snapshot, "shutdown"));

  assert.equal(snapshot.costMicros, 0);
  assert.equal(result.ok, true, result.reason ?? "");
});

test("a session with no header falls back to the manager's session id", () => {
  const manager = fakeSessionManager("full-usage.jsonl");
  const headerless = {
    ...manager,
    getEntries: () => manager.getEntries().filter((entry) => entry.type !== "session"),
    getHeader: () => undefined,
  };
  const snapshot = buildSnapshot(headerless);
  const payload = buildPayload(snapshot, "command");
  const result = validateIngestPayload(payload);

  assert.equal(snapshot.sessionId, manager.getSessionId(), "id comes from getSessionId()");
  assert.equal(result.ok, true, result.reason ?? "");
});

test("a session manager with no id at all yields no snapshot", () => {
  const manager = fakeSessionManager("full-usage.jsonl");
  const anonymous = {
    ...manager,
    getEntries: () => manager.getEntries().filter((entry) => entry.type !== "session"),
    getHeader: () => undefined,
    getSessionId: () => undefined,
  };

  assert.equal(buildSnapshot(anonymous), null);
});
