/**
 * The whole-ledger facts behind `/lifetime`: totals, the day series, the shape of a day and
 * a week, and the records worth bragging about.
 *
 * Streaks, levels and progress bars are drawings over these facts, so they live in the page
 * (see web/src/lifetime.js). This module returns facts only.
 */

import {
  bucketFacts,
  dayRange,
  FACT_COLUMNS,
  money,
  pointFromBucket,
  subagentCondition,
  USAGE_TOTALS_SELECT,
  usageTotals,
} from "./shared.js";
import { localDay, localHour, offsetLabel } from "../timezone.js";
import { getModelCost } from "./models.js";

/** Weekday names, indexed by the 0-6 number a calendar day resolves to. @type {string[]} */
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Day of week for a `YYYY-MM-DD` calendar string.
 *
 * The string names a local calendar day, so it is read at local midnight in UTC terms
 * (`T00:00:00Z`) and the weekday falls out of the calendar without a zone lookup.
 *
 * @param {string} dayString `YYYY-MM-DD`
 * @returns {number} 0 for Sunday through 6 for Saturday
 */
const weekdayOf = (dayString) => new Date(`${dayString}T00:00:00Z`).getUTCDay();

/**
 * Shape one "best of the ledger" row: the session, what it cost, and how long it ran.
 * @param {object | undefined} row Row from a sessions-table record query, undefined when no sessions
 * @returns {object | null} session facts with a money pair and a span in seconds
 */
const recordSession = (row) =>
  row
    ? {
        sessionId: row.session_id,
        cwd: row.cwd,
        name: row.name,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        spanSeconds: row.span_seconds,
        ...money(row.cost_micros),
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        userMessages: row.user_messages,
        assistantMessages: row.assistant_messages,
        toolCalls: row.tool_calls,
      }
    : null;

/**
 * Whole-ledger totals, the day series, and the records worth bragging about.
 *
 * This is the data behind the `/lifetime` page, so it answers the questions the ledger
 * panels cannot: what everything cost, which days were the biggest, which hour of the day
 * and which weekday this machine spends most of its tokens in, and how long the streaks are.
 *
 * The day series is grouped in JavaScript, not in SQL: which local day a usage fact belongs
 * to is a wall-clock question, SQLite has no timezone database, and a lifetime range is
 * exactly the range where a fixed UTC offset is most likely to be wrong. The same
 * `bucketFacts` the daily and hourly charts use does the grouping, so a day on this page is
 * the same day as a bar on the chart.
 *
 * A day with tokens and no money is an active day. Most usage on this machine runs on local
 * models priced at zero, so measuring activity in money would call a hard day of local-model
 * work a gap, and a streak built on money would break on the days that did the most.
 *
 * Streaks, levels, and progress bars are drawings over these facts, so they live in the page
 * (see web/src/lifetime.js), not here. This query returns facts.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ includeSubagents?: boolean, timeZone?: string | null }} [options]
 * @returns {{
 *   range: { from: string | null, to: string | null, timeZone: string, offsetLabel: string },
 *   totals: object,
 *   counts: object,
 *   daily: object[],
 *   hoursOfDay: object[],
 *   weekdays: object[],
 *   records: object
 * }}
 */
export const getLifetimeStats = (db, options = {}) => {
  const timeZone = options.timeZone ?? null;
  const includeSubagents = options.includeSubagents !== false;
  // Excluding subagents needs the sessions table, so the join is only paid for when used.
  const sessionsJoin = includeSubagents ? "" : "JOIN sessions s ON s.session_id = u.session_id";
  const subagents = subagentCondition(includeSubagents);

  // Every recorded fact, in the shared column list, grouped by local day.
  const facts = db
    .prepare(
      `SELECT ${FACT_COLUMNS}
       FROM usage_events u
       ${sessionsJoin}
       WHERE TRUE ${subagents}
       ORDER BY u.occurred_at`,
    )
    .all();

  const byDay = bucketFacts(facts, (row) => localDay(row.occurred_at, timeZone));
  const daily = [...byDay.keys()]
    .sort()
    .map((day) => ({ day, ...pointFromBucket(byDay.get(day)) }));

  // The shape of a day and of a week, summed over all recorded history. The peak hour and the
  // peak weekday are the biggest numbers in these lists, and picking them is a drawing
  // decision, so they are returned whole.
  const hoursOfDay = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    costMicros: 0,
    totalTokens: 0,
    events: 0,
  }));
  for (const fact of facts) {
    // `localHour` reads "YYYY-MM-DD HH:00"; its last two characters are the wall-clock hour.
    const bucket = hoursOfDay[Number(localHour(fact.occurred_at, timeZone).slice(11, 13))];
    bucket.costMicros += fact.cost_micros;
    bucket.totalTokens += fact.total_tokens;
    bucket.events += 1;
  }

  const weekdaySums = new Map(
    [0, 1, 2, 3, 4, 5, 6].map((index) => [index, { name: WEEKDAY_NAMES[index], days: 0, costMicros: 0, totalTokens: 0 }]),
  );
  for (const point of daily) {
    const sum = weekdaySums.get(weekdayOf(point.day));
    sum.days += 1;
    sum.costMicros += point.costMicros;
    sum.totalTokens += point.totalTokens;
  }
  const weekdays = [...weekdaySums.values()];

  const totals = db
    .prepare(
      `SELECT ${USAGE_TOTALS_SELECT}
       FROM usage_events u
       ${sessionsJoin}
       WHERE TRUE ${subagents}`,
    )
    .get();

  // Work the ledger records, which live on the sessions rollups rather than on usage facts.
  const work = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(user_messages), 0)      AS user_messages,
              COALESCE(SUM(assistant_messages), 0) AS assistant_messages,
              COALESCE(SUM(tool_calls), 0)         AS tool_calls,
              COALESCE(SUM(tool_results), 0)       AS tool_results,
              COALESCE(SUM(total_messages), 0)     AS total_messages,
              COUNT(DISTINCT cwd)                  AS projects
       FROM sessions s
       WHERE TRUE ${subagents}`,
    )
    .get();

  const SESSION_RECORD_COLUMNS = `session_id, cwd, name, started_at, last_activity_at,
              cost_micros, total_tokens, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, user_messages, assistant_messages, tool_calls,
              CAST(strftime('%s', last_activity_at) - strftime('%s', started_at) AS INTEGER) AS span_seconds`;

  const biggestSession = recordSession(
    db
      .prepare(
        `SELECT ${SESSION_RECORD_COLUMNS}
         FROM sessions s
         WHERE TRUE ${subagents}
         ORDER BY cost_micros DESC, total_tokens DESC
         LIMIT 1`,
      )
      .get(),
  );

  const longestSession = recordSession(
    db
      .prepare(
        `SELECT ${SESSION_RECORD_COLUMNS}
         FROM sessions s
         WHERE TRUE ${subagents}
         ORDER BY span_seconds DESC, cost_micros DESC
         LIMIT 1`,
      )
      .get(),
  );

  const busiestDay = (field) =>
    daily.reduce((best, point) => (best[field] > point[field] ? best : point), daily[0]);

  const byCost = db
    .prepare(
      `SELECT s.cwd AS cwd,
              COALESCE(SUM(u.cost_micros), 0)  AS cost_micros,
              COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
              COUNT(DISTINCT u.session_id)     AS sessions
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       WHERE TRUE ${subagents}
       GROUP BY s.cwd
       ORDER BY cost_micros DESC,
                total_tokens DESC`,
    )
    .all();

  const byTokens = [...byCost].sort((a, b) => b.total_tokens - a.total_tokens);

  // Model leaderboard: the same query the ledger's model panel uses, read two ways.
  const models = getModelCost(db, { includeSubagents });
  const modelRow = (row) =>
    row
      ? { provider: row.provider, modelId: row.modelId, ...money(row.costMicros), totalTokens: row.totalTokens }
      : null;

  // The single most expensive model call on record, with the model and the kind of entry it
  // came from: "one call cost $4.12" is the most quotable number on the page.
  const call = db
    .prepare(
      `SELECT u.occurred_at, u.kind, u.provider, u.model_id,
              u.cost_micros, u.total_tokens
       FROM usage_events u
       ${sessionsJoin}
       WHERE TRUE ${subagents}
       ORDER BY u.cost_micros DESC, u.total_tokens DESC
       LIMIT 1`,
    )
    .get();

  const projectRow = (row) =>
    row
      ? {
          cwd: row.cwd,
          ...money(row.cost_micros),
          totalTokens: row.total_tokens,
          sessions: row.sessions,
        }
      : null;

  const firstDay = daily.length > 0 ? daily[0].day : null;
  const lastDay = daily.length > 0 ? daily[daily.length - 1].day : null;

  return {
    range: {
      from: firstDay,
      to: lastDay,
      timeZone: timeZone ?? "UTC",
      offsetLabel: offsetLabel(timeZone),
    },
    totals: {
      ...usageTotals(totals),
      // The streaks page counts days by tokens, so "active" is stated here once, in words the
      // page uses: a day is active when it recorded any token at all.
      activeDays: daily.filter((point) => point.totalTokens > 0).length,
      calendarDays: firstDay && lastDay ? dayRange(firstDay, lastDay).length : 0,
    },
    counts: {
      sessions: work.sessions,
      userMessages: work.user_messages,
      assistantMessages: work.assistant_messages,
      toolCalls: work.tool_calls,
      toolResults: work.tool_results,
      totalMessages: work.total_messages,
      projects: work.projects,
      models: models.length,
    },
    daily,
    hoursOfDay,
    weekdays,
    records: {
      mostExpensiveDay: busiestDay("costMicros"),
      busiestTokenDay: busiestDay("totalTokens"),
      mostSessionsDay: busiestDay("sessions"),
      biggestSession,
      longestSession,
      biggestCall: call
        ? {
            occurredAt: call.occurred_at,
            kind: call.kind,
            provider: call.provider,
            modelId: call.model_id,
            ...money(call.cost_micros),
            totalTokens: call.total_tokens,
          }
        : null,
      topProjectByCost: projectRow(byCost[0]),
      topProjectByTokens: projectRow(byTokens[0]),
      topModelByCost: modelRow(models[0]),
      topModelByTokens: modelRow([...models].sort((a, b) => b.totalTokens - a.totalTokens)[0]),
    },
  };
};
