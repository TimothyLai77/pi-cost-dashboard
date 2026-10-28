/**
 * Unit tests for the session cost aggregator.
 *
 * Fixture totals are hand-computed from the fixture files and written down here as
 * literals, so a change to the formula that shifts a total has to be justified against
 * numbers a person can verify by adding up the fixture.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { aggregateSession, formatUsd } from "../scanner/aggregate.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = (name) => join(fixtures, name);

/**
 * Count usage facts by kind.
 * @param {object[]} events Facts produced by aggregateSession
 * @returns {Record<string, number>} Count per kind
 */
const countByKind = (events) =>
  events.reduce((counts, event) => ({ ...counts, [event.kind]: (counts[event.kind] ?? 0) + 1 }), {});

test("full-usage fixture totals match hand-computed values", () => {
  const { session, events } = aggregateSession(fixturePath("full-usage.jsonl"));

  assert.equal(session.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(session.cwd, "/home/user/project-a");
  assert.equal(session.name, "Fixture session");
  assert.equal(session.parentSessionId, null);
  assert.equal(session.startedAt, "2026-01-01T10:00:00.000Z");
  assert.equal(session.lastActivityAt, "2026-01-02T11:00:05.000Z");

  // Header is excluded from entryCount; 16 tree entries follow it.
  assert.equal(session.entryCount, 16);

  assert.equal(session.costMicros, 19250);
  assert.equal(session.inputTokens, 186);
  assert.equal(session.outputTokens, 327);
  assert.equal(session.cacheReadTokens, 50412);
  assert.equal(session.cacheWriteTokens, 500);
  assert.equal(session.totalTokens, 51425);

  assert.equal(session.totalMessages, 7);
  assert.equal(session.userMessages, 2);
  assert.equal(session.assistantMessages, 4);
  assert.equal(session.toolCalls, 1);
  assert.equal(session.toolResults, 1);

  assert.equal(events.length, 8);
});

test("all five usage-bearing entry types are counted", () => {
  const { events } = aggregateSession(fixturePath("full-usage.jsonl"));

  assert.deepEqual(countByKind(events), {
    assistant: 4,
    tool_result: 1,
    usage: 1,
    compaction: 1,
    branch_summary: 1,
  });
});

test("tool-result usage is billed, matching Pi's formula", () => {
  const { events } = aggregateSession(fixturePath("full-usage.jsonl"));
  const toolResult = events.find((event) => event.kind === "tool_result");

  assert.ok(toolResult, "expected one tool_result fact");
  assert.equal(toolResult.costMicros, 500);
  assert.equal(toolResult.entryId, "r1");
});

test("aborted assistant usage is counted, not discarded", () => {
  const { events } = aggregateSession(fixturePath("full-usage.jsonl"));
  const aborted = events.find((event) => event.entryId === "a3");

  // The request was sent and billed, so its usage belongs in the total.
  assert.equal(aborted.costMicros, 100);
});

test("non-usage entry types add no facts", () => {
  const { events, session } = aggregateSession(fixturePath("full-usage.jsonl"));
  const kindsWithEntryIds = new Set(events.map((event) => event.entryId));

  // model_change, thinking_level_change, label, context_edit, custom, session_info
  for (const id of ["m1", "t1", "l1", "e1", "x1", "s1"]) {
    assert.equal(kindsWithEntryIds.has(id), false, `${id} should produce no usage fact`);
  }
  assert.equal(session.totalMessages, 7, "non-message entries are not counted as messages");
});

test("usage-only session is counted even with no messages", () => {
  const { session, events, warnings } = aggregateSession(fixturePath("usage-only.jsonl"));

  assert.equal(session.totalMessages, 0);
  assert.equal(session.assistantMessages, 0);
  assert.equal(events.length, 2);

  // A cache warm at $0.10 plus an unpriced custom kind at $0.
  assert.equal(session.costMicros, 100000);
  assert.equal(session.cacheReadTokens, 100000);
  assert.equal(session.totalTokens, 100010);
  assert.deepEqual(warnings, []);
});

test("an unpriced model costs zero and is reported, not skipped", () => {
  const { session, events } = aggregateSession(fixturePath("forked-zero-cost.jsonl"));

  assert.equal(session.costMicros, 0);
  assert.equal(events.length, 1, "tokens are recorded even when cost is zero");
  assert.equal(session.totalTokens, 10000);
});

test("forked sessions record the parent's session id, plus the file it came from", () => {
  const { session } = aggregateSession(fixturePath("forked-zero-cost.jsonl"));

  // Pi writes a path into the header; the id is read out of it so parent_session_id
  // holds an id, and the path is kept separately.
  assert.equal(session.parentSessionId, "00000000-0000-4000-8000-000000000000");
  assert.equal(
    session.parentSessionFile,
    "/home/user/.pi/agent/sessions/--home-user-project-c--/2026-01-01T00-00-00-000Z_00000000-0000-4000-8000-000000000000.jsonl",
  );
});

test("a truncated file skips the broken tail and warns once", () => {
  const { session, events, skippedLines, warnings } = aggregateSession(fixturePath("truncated.jsonl"));

  assert.equal(skippedLines, 1);
  assert.equal(events.length, 1, "complete entries before the tail are still aggregated");
  assert.equal(session.costMicros, 100);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unparseable/);
});

test("a missing usage block is counted, not warned, for kinds that may lack one", () => {
  const contents = [
    '{"type":"session","version":3,"id":"55555555-5555-5555-8555-555555555555","timestamp":"2026-01-06T06:00:00.000Z","cwd":"/x"}',
    // Older compaction entries carry no usage field at all.
    '{"type":"compaction","id":"c1","parentId":null,"timestamp":"2026-01-06T06:00:01.000Z","summary":"s","firstKeptEntryId":"c1"}',
    '{"type":"message","id":"r1","parentId":"c1","timestamp":"2026-01-06T06:00:02.000Z","message":{"role":"toolResult","toolCallId":"c","toolName":"bash","content":[],"isError":false}}',
  ].join("\n");

  const { events, warnings, missingUsageCount } = aggregateSession("/virtual", contents);

  assert.equal(events.length, 0);
  assert.deepEqual(warnings, [], "normal absent usage must not warn");
  assert.deepEqual(missingUsageCount, { compaction: 1, tool_result: 1 });
});

test("a usage entry with no usage block is reported as malformed", () => {
  const contents = [
    '{"type":"session","version":3,"id":"66666666-6666-6666-8666-666666666666","timestamp":"2026-01-07T05:00:00.000Z","cwd":"/x"}',
    '{"type":"usage","id":"w1","parentId":null,"timestamp":"2026-01-07T05:00:01.000Z","kind":"cache_warm","provider":"p","model":"m"}',
  ].join("\n");

  const { warnings, missingUsageCount } = aggregateSession("/virtual", contents);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /has no usage block/);
  assert.deepEqual(missingUsageCount, { usage: 1 });
});

test("a file with no header warns and reports a null session id", () => {
  const contents =
    '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-08T04:00:00.000Z","message":{"role":"user","content":"hi"}}';

  const { session, warnings } = aggregateSession("/virtual", contents);

  assert.equal(session.sessionId, null);
  assert.ok(warnings.includes("no session header found"));
});

test("absent cost and usage fields are treated as zero", () => {
  const contents = [
    '{"type":"session","version":3,"id":"77777777-7777-7777-8777-777777777777","timestamp":"2026-01-09T03:00:00.000Z","cwd":"/x"}',
    '{"type":"message","id":"a1","parentId":null,"timestamp":"2026-01-09T03:00:01.000Z","message":{"role":"assistant","content":[],"provider":"p","model":"m","usage":{"input":5,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":10}}}',
  ].join("\n");

  const { session, events } = aggregateSession("/virtual", contents);

  assert.equal(events.length, 1, "usage with no cost block still counts as a fact");
  assert.equal(session.costMicros, 0);
  assert.equal(session.totalTokens, 10);
});

test("formatUsd renders micro-dollars as a dollar string", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(19250), "$0.02");
  assert.equal(formatUsd(1000000), "$1.00");
  assert.equal(formatUsd(61), "$0.00");
});
