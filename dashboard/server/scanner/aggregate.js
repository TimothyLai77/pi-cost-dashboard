/**
 * Cost aggregation for one Pi session file.
 *
 * Pi stores sessions as JSONL (one JSON object per line). Cost is not stored as a
 * session total; it is spread across the entries that carry model usage. This module
 * reproduces Pi's own accounting so the dashboard's numbers match what `/session`
 * shows inside Pi.
 *
 * Pi's formula (AgentSession.getSessionStats, dist/core/agent-session.js:3445) sums
 * `usage` from five places:
 *
 *   1. assistant messages
 *   2. tool-result messages that report usage (tools making nested model calls)
 *   3. `usage` entries            (cache warming, extension-reported usage)
 *   4. `compaction` entries       (the LLM call that wrote the summary)
 *   5. `branch_summary` entries   (the LLM call that summarized an abandoned branch)
 *
 * It iterates getEntries(), which is every entry on every branch, not just the
 * current branch. Abandoned branches were paid for, so a branch-only sum under-reports
 * on forked sessions.
 *
 * Money is kept in integer micro-US dollars (1e-6 USD). SQLite has no DECIMAL type and
 * sums of doubles drift, so rounding happens exactly once per entry here and every
 * downstream sum is integer arithmetic.
 */

import { readFileSync } from "node:fs";

/** Micro-dollars per US dollar. @type {number} */
const MICRO_DOLLARS_PER_DOLLAR = 1e6;

/**
 * Convert a US dollar amount to integer micro-dollars.
 * @param {number | undefined} dollars One of the `usage.cost` amounts; may be absent
 * @returns {number} Rounded micro-dollars, 0 when absent
 */
const toMicroDollars = (dollars) =>
  Number.isFinite(dollars) ? Math.round(dollars * MICRO_DOLLARS_PER_DOLLAR) : 0;

/**
 * Pull the parent session's UUID out of the path Pi records in `parentSession`.
 *
 * Pi names a session file `<started>_<uuid>.jsonl` and writes that whole path into a
 * forked session's header. The dashboard wants the id, so the 36-character UUID is read
 * out of the name and the path is kept separately.
 *
 * @param {unknown} parentSession Value of the header's `parentSession`; a path string or absent
 * @returns {string | null} The parent session's UUID, null when there is no parent
 */
const parentSessionIdFromPath = (parentSession) => {
  if (typeof parentSession !== "string") return null;
  const match = parentSession.match(/_([0-9a-fA-F-]{36})\.jsonl$/);
  return match ? match[1] : null;
};

/**
 * Read the `usage` block from a session entry, when that entry type contributes one.
 *
 * @param {any} entry A parsed session entry
 * @returns {{ entryKind: string, usage: any } | null} null when the entry carries no usage
 */
const usageFromEntry = (entry) => {
  if (entry.type === "usage") return { entryKind: "usage", usage: entry.usage };
  if (entry.type === "compaction") return { entryKind: "compaction", usage: entry.usage };
  if (entry.type === "branch_summary") return { entryKind: "branch_summary", usage: entry.usage };
  if (entry.type !== "message") return null;

  const message = entry.message ?? {};
  if (message.role === "assistant") return { entryKind: "assistant", usage: message.usage };
  if (message.role === "toolResult") return { entryKind: "tool_result", usage: message.usage };
  return null;
};

/**
 * Build one usage fact row from an entry that carries usage.
 *
 * Provider and model come from the entry when it names them: assistant messages name the
 * model that answered, and `usage` entries name the model they were attributed to.
 * Compaction, branch-summary, and tool-result usage name no model at all, so the caller
 * passes the model in effect at that point in the session, which is the model Pi paid for.
 *
 * @param {any} entry A parsed session entry
 * @param {string} entryKind One of assistant, tool_result, usage, compaction, branch_summary
 * @param {any} usage The entry's usage block
 * @param {{ provider: string | null, modelId: string | null }} activeModel Model in effect at this entry
 * @returns {object} A usage_events-shaped record
 */
const buildEvent = (entry, entryKind, usage, activeModel) => {
  const message = entry.message ?? {};
  return {
    entryId: entry.id,
    kind: entryKind,
    occurredAt: entry.timestamp,
    provider: message.provider ?? entry.provider ?? activeModel.provider,
    modelId: message.model ?? entry.model ?? activeModel.modelId,
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    costMicros: toMicroDollars(usage.cost?.total),
    // Pi's pricing pass writes the four parts next to the total, so the split is read,
    // not derived. Rounding each part separately is what makes the parts sum to the total
    // within a few micro-dollars, not exactly.
    costInputMicros: toMicroDollars(usage.cost?.input),
    costOutputMicros: toMicroDollars(usage.cost?.output),
    costCacheReadMicros: toMicroDollars(usage.cost?.cacheRead),
    costCacheWriteMicros: toMicroDollars(usage.cost?.cacheWrite),
  };
};

/**
 * Aggregate one Pi session file into a session rollup plus per-entry usage facts.
 *
 * Every usage-bearing entry becomes a fact row so cost can be attributed to the day it
 * occurred. A session that runs across three days must not bill all of its cost to the
 * day it started.
 *
 * Aborted and errored assistant messages keep their usage, matching Pi: the request was
 * sent and billed.
 *
 * @param {string} filePath Absolute path to a session `.jsonl` file
 * @param {string} [fileContents] Pre-read file text; read from disk when omitted
 * @returns {{
 *   session: {
 *     sessionId: string, sessionFile: string, parentSessionId: string | null,
 *     cwd: string, name: string | null, startedAt: string | null,
 *     lastActivityAt: string | null, entryCount: number,
 *     costMicros: number, costInputMicros: number, costOutputMicros: number,
 *     costCacheReadMicros: number, costCacheWriteMicros: number,
 *     inputTokens: number, outputTokens: number,
 *     cacheReadTokens: number, cacheWriteTokens: number, totalTokens: number,
 *     userMessages: number, assistantMessages: number, toolCalls: number,
 *     toolResults: number, totalMessages: number
 *   },
 *   events: object[],
 *   skippedLines: number,
 *   warnings: string[],
 *   missingUsageCount: Record<string, number>
 * }}
 */
export const aggregateSession = (filePath, fileContents) => {
  const text = fileContents ?? readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  const session = {
    sessionId: null,
    sessionFile: filePath,
    parentSessionId: null,
    parentSessionFile: null,
    cwd: null,
    name: null,
    startedAt: null,
    lastActivityAt: null,
    entryCount: 0,
    costMicros: 0,
    costInputMicros: 0,
    costOutputMicros: 0,
    costCacheReadMicros: 0,
    costCacheWriteMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
  };
  const events = [];
  const warnings = [];
  const missingUsageCount = {};
  let skippedLines = 0;

  // Provider and model in effect as the file is read. Pi records a model_change entry on
  // every switch and names the answering model on each assistant message, so this tracks
  // which model was billed at any point in the session.
  const activeModel = { provider: null, modelId: null };

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Pi writes complete JSON per line, so a bad line means a truncated tail from a
      // crash. Skip it and report it rather than failing the whole file.
      skippedLines += 1;
      continue;
    }

    // The header is metadata and is not part of the entry tree.
    if (entry.type === "session") {
      session.sessionId = entry.id ?? null;
      session.cwd = entry.cwd ?? null;
      // Pi records a forked session's parent as a file path named
      // `<started>_<uuid>.jsonl`, so the id has to be read out of it. Storing the path in
      // parent_session_id makes a path look like a session id to every consumer.
      session.parentSessionFile =
        typeof entry.parentSession === "string" ? entry.parentSession : null;
      session.parentSessionId = parentSessionIdFromPath(entry.parentSession);
      session.startedAt = entry.timestamp ?? null;
      continue;
    }

    session.entryCount += 1;

    // Timestamps are ISO-8601 with fixed-width milliseconds, so lexicographic
    // comparison is chronological for the format Pi writes.
    if (typeof entry.timestamp === "string" && entry.timestamp > (session.lastActivityAt ?? "")) {
      session.lastActivityAt = entry.timestamp;
    }

    if (entry.type === "model_change") {
      activeModel.provider = entry.provider ?? activeModel.provider;
      activeModel.modelId = entry.modelId ?? activeModel.modelId;
    }

    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.length > 0) {
      session.name = entry.name;
    }

    if (entry.type === "message") {
      session.totalMessages += 1;
      const role = entry.message?.role;
      if (role === "user") session.userMessages += 1;
      if (role === "toolResult") session.toolResults += 1;
      if (role === "assistant") {
        session.assistantMessages += 1;
        // An assistant message names the model that answered it, which is the model in
        // effect from here until the next model_change.
        activeModel.provider = entry.message?.provider ?? activeModel.provider;
        activeModel.modelId = entry.message?.model ?? activeModel.modelId;
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          session.toolCalls += content.filter((block) => block?.type === "toolCall").length;
        }
      }
    }

    const found = usageFromEntry(entry);
    if (!found) continue;

    // A missing usage block is normal for toolResult messages and for older compaction
    // and branch_summary entries, so it is counted rather than warned about: Pi's own
    // formula guards with `if (usage)` and skips them silently. A `usage` entry with no
    // usage block is malformed, because that entry type exists only to carry usage.
    if (!found.usage) {
      missingUsageCount[found.entryKind] = (missingUsageCount[found.entryKind] ?? 0) + 1;
      if (found.entryKind === "usage") {
        warnings.push(`usage entry ${entry.id} (kind ${entry.kind}) has no usage block`);
      }
      continue;
    }

    const event = buildEvent(entry, found.entryKind, found.usage, activeModel);
    events.push(event);

    session.costMicros += event.costMicros;
    session.costInputMicros += event.costInputMicros;
    session.costOutputMicros += event.costOutputMicros;
    session.costCacheReadMicros += event.costCacheReadMicros;
    session.costCacheWriteMicros += event.costCacheWriteMicros;
    session.inputTokens += event.inputTokens;
    session.outputTokens += event.outputTokens;
    session.cacheReadTokens += event.cacheReadTokens;
    session.cacheWriteTokens += event.cacheWriteTokens;
    session.totalTokens += event.totalTokens;
  }

  if (!session.sessionId) warnings.push("no session header found");
  if (skippedLines > 0) {
    warnings.push(`${skippedLines} unparseable line(s); the file may be truncated`);
  }

  return { session, events, skippedLines, warnings, missingUsageCount };
};

/**
 * Format micro-dollars as a US dollar string.
 * @param {number} microDollars Integer micro-dollars
 * @returns {string} e.g. "$0.61"
 */
export const formatUsd = (microDollars) => `$${(microDollars / MICRO_DOLLARS_PER_DOLLAR).toFixed(2)}`;
