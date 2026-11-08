/**
 * The session list, and one session's own ledger.
 *
 * Both read the `sessions` rollups rather than the usage facts, because the list wants one
 * row per session and not one per model call. `getSessionById` is the exception that pulls
 * a session's usage facts as well, so its events can be shown in order.
 */

import {
  clampLimit,
  money,
  whereFrom,
} from "./shared.js";
import { formatUsd } from "../scanner/aggregate.js";

/**
 * Session list, newest activity first.
 *
 * Token counts are returned broken out as well as total, because `total_tokens` is a sum of
 * four very different things and cache reads dominate it: every model call re-reports the
 * cached prefix it read. A session that cost $13.73 can show 113M total tokens, of which
 * 112M are cache reads billed at the model's cache rate. The breakdown is what lets the
 * session list say so next to the number.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ limit?: number, offset?: number, cwd?: string, provider?: string, sort?: "activity" | "cost" }} [options]
 * @returns {{ total: number, limit: number, offset: number, sessions: object[] }}
 */
export const getSessions = (db, options = {}) => {
  const limit = clampLimit(options.limit);
  const requestedOffset = Number(options.offset);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.trunc(requestedOffset) : 0;

  const filters = [];
  const params = {};
  if (options.cwd) {
    filters.push("s.cwd = @cwd");
    params.cwd = options.cwd;
  }
  if (options.provider) {
    filters.push(
      "s.session_id IN (SELECT session_id FROM usage_events WHERE provider = @provider)",
    );
    params.provider = options.provider;
  }
  if (options.includeSubagents === false) {
    filters.push("s.parent_session_id IS NULL");
  }
  const whereClause = whereFrom(filters);
  const orderBy = options.sort === "cost" ? "cost_micros DESC" : "last_activity_at DESC";

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM sessions s ${whereClause}`)
    .get(params).n;

  const rows = db
    .prepare(
      `SELECT s.session_id, s.session_file, s.parent_session_id, s.cwd, s.name,
              s.started_at, s.last_activity_at, s.entry_count, s.cost_micros,
              s.total_tokens, s.input_tokens, s.output_tokens, s.cache_read_tokens,
              s.cache_write_tokens, s.user_messages, s.assistant_messages, s.tool_calls,
              s.last_source
       FROM sessions s
       ${whereClause}
       ORDER BY s.${orderBy}
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset });

  return {
    total,
    limit,
    offset,
    sessions: rows.map((row) => ({
      sessionId: row.session_id,
      sessionFile: row.session_file,
      parentSessionId: row.parent_session_id,
      // Pi bills a subagent as its own session and again inside the parent's toolResult
      // usage, so the list marks which rows are the nested ones.
      isSubagent: row.parent_session_id !== null,
      cwd: row.cwd,
      name: row.name,
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      entryCount: row.entry_count,
      ...money(row.cost_micros),
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      userMessages: row.user_messages,
      assistantMessages: row.assistant_messages,
      toolCalls: row.tool_calls,
      provisional: row.last_source === "push",
    })),
  };
};

/**
 * One session, with its usage facts.
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionId
 * @returns {object | null} null when the session is not in the database
 */
export const getSessionById = (db, sessionId) => {
  const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
  if (!row) return null;

  const facts = db
    .prepare(
      `SELECT entry_id, kind, occurred_at, provider, model_id, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, total_tokens, cost_micros
       FROM usage_events WHERE session_id = ? ORDER BY occurred_at, entry_id`,
    )
    .all(sessionId);

  return {
    sessionId: row.session_id,
    sessionFile: row.session_file,
    parentSessionId: row.parent_session_id,
    cwd: row.cwd,
    name: row.name,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    entryCount: row.entry_count,
    ...money(row.cost_micros),
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      total: row.total_tokens,
    },
    messages: {
      user: row.user_messages,
      assistant: row.assistant_messages,
      toolCalls: row.tool_calls,
      toolResults: row.tool_results,
      total: row.total_messages,
    },
    provisional: row.last_source === "push",
    lastSource: row.last_source,
    events: facts.map((fact) => ({
      entryId: fact.entry_id,
      kind: fact.kind,
      occurredAt: fact.occurred_at,
      provider: fact.provider,
      modelId: fact.model_id,
      totalTokens: fact.total_tokens,
      costMicros: fact.cost_micros,
      costUsd: formatUsd(fact.cost_micros),
    })),
  };
};
