#!/usr/bin/env node
/**
 * CLI: print the cost rollup for one Pi session file.
 *
 * Phase 1 deliverable. It is also the debugging tool for the scanner: point it at any
 * session file and compare the cost against what Pi's `/session` shows for the same file.
 *
 * Usage:
 *   node server/cli-aggregate.js <session.jsonl> [--json]
 *   node server/cli-aggregate.js ~/.pi/agent/sessions/--home-user--/....jsonl
 */

import { resolve } from "node:path";
import { aggregateSession, formatUsd } from "./scanner/aggregate.js";

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const asJson = flags.includes("--json");

if (positional.length !== 1) {
  console.error("usage: node server/cli-aggregate.js <session.jsonl> [--json]");
  process.exit(1);
}

const filePath = resolve(positional[0]);
const { session, events, skippedLines, warnings, missingUsageCount } = aggregateSession(filePath);

if (asJson) {
  console.log(JSON.stringify({ session, events, skippedLines, warnings, missingUsageCount }, null, 2));
  process.exit(0);
}

console.log(`file        ${session.sessionFile}`);
console.log(`session     ${session.sessionId}`);
console.log(`project     ${session.cwd}`);
console.log(`name        ${session.name ?? "(none)"}`);
console.log(`parent      ${session.parentSessionId ?? "(none)"}`);
console.log(`started     ${session.startedAt}`);
console.log(`last at     ${session.lastActivityAt}`);
console.log(`entries     ${session.entryCount}`);
console.log("");
console.log(`cost        ${formatUsd(session.costMicros)}  (${session.costMicros} micros)`);
console.log(`tokens      ${session.totalTokens.toLocaleString("en-US")}`);
console.log(
  `  in/out    ${session.inputTokens.toLocaleString("en-US")} / ${session.outputTokens.toLocaleString("en-US")}`,
);
console.log(
  `  cache     r${session.cacheReadTokens.toLocaleString("en-US")} w${session.cacheWriteTokens.toLocaleString("en-US")}`,
);
console.log("");
console.log(`messages    ${session.totalMessages} total, ${session.userMessages} user, ${session.assistantMessages} assistant`);
console.log(`tools       ${session.toolCalls} calls, ${session.toolResults} results`);
console.log(`usage facts ${events.length} row(s)`);

if (skippedLines > 0) console.log(`skipped     ${skippedLines} unparseable line(s)`);

// Entries with no usage block are counted, not warned about: toolResult messages and
// older compaction entries legitimately carry none.
const missingEntries = Object.entries(missingUsageCount);
if (missingEntries.length > 0) {
  console.log(`no usage    ${missingEntries.map(([kind, n]) => `${n} ${kind}`).join(", ")}`);
}

for (const warning of warnings) console.log(`warning     ${warning}`);
