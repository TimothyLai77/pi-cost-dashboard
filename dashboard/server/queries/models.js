/**
 * Spend by provider and model — the ledger's model panel.
 *
 * Read on its own by the API, and reused by the lifetime page, which wants the same
 * leaderboard ranked two ways.
 */

import {
  money,
  subagentCondition,
} from "./shared.js";

/**
 * Spend by provider and model.
 * @param {import("better-sqlite3").Database} db
 * @returns {{ provider: string | null, modelId: string | null, costMicros: number, costUsd: string, totalTokens: number, events: number }[]}
 */
export const getModelCost = (db, options = {}) =>
  db
    .prepare(
      `SELECT u.provider, u.model_id,
              COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
              COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
              COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
              COUNT(*)                         AS events
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       WHERE TRUE ${subagentCondition(options.includeSubagents)}
       GROUP BY u.provider, u.model_id
       ORDER BY cost_micros DESC`,
    )
    .all()
    .map((row) => ({
      provider: row.provider,
      modelId: row.model_id,
      ...money(row.cost_micros),
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      events: row.events,
    }));
