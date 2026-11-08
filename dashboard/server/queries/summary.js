/**
 * The summary strip: today, the last 7 days, the last 30 days, and all time.
 *
 * A window is a floor at an instant rather than a filter, so each one is its own query:
 * "today" and "all time" share nothing but the column list. The instant a window starts at
 * is the instant that local day began, which is the same basis the daily chart buckets on.
 */

import {
  subagentCondition,
  USAGE_TOTALS_SELECT,
  usageTotals,
} from "./shared.js";
import { localDayStart, windowStartDay } from "../timezone.js";

/**
 * Totals for a window, and for all time.
 *
 * Sessions are counted by distinct sessions contributing usage in the window; cost is
 * counted by when the usage happened, which is the same basis the chart uses.
 *
 * Token totals are broken out by kind because "tokens" on a chart is a sum of four very
 * different things. Cache reads dominate - a long session re-reads its cached context on
 * every model call - so a 77M figure is throughput across hundreds of calls, not the size
 * of a conversation.
 *
 * Cost is broken out the same way, in money rather than tokens: `costBreakdown` says what
 * the window's spend bought — prompt tokens, completion tokens, cache reads, cache writes.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number | null} [days] Window length in days, counted backwards from today; null means all time
 * @param {{ includeSubagents?: boolean, timeZone?: string | null }} [options]
 * @returns {{ window: object, allTime: object, today: object, last7Days: object, last30Days: object }}
 */
export const getSummary = (db, days = 7, options = {}) => {
  const includeSubagents = options.includeSubagents !== false;
  const timeZone = options.timeZone ?? null;
  // Excluding subagents needs the sessions table, so the join is only paid for when used.
  const sessionsJoin = includeSubagents ? "" : "JOIN sessions s ON s.session_id = u.session_id";
  const subagents = subagentCondition(includeSubagents);

  const totalsFor = (dayCount) => {
    // Cost is bucketed by when the usage happened, the same basis the chart uses, so a
    // session resumed days later bills its new usage to the later day. "Today" is today in
    // the configured zone, so the floor is the instant that local day began.
    const where = dayCount === null
      ? subagents.trim().length > 0
        ? `WHERE TRUE ${subagents}`
        : ""
      : `WHERE u.occurred_at >= @start${subagents}`;
    const params =
      dayCount === null
        ? {}
        : { start: localDayStart(windowStartDay(dayCount, timeZone), timeZone) };
    const row = db
      .prepare(
        `SELECT ${USAGE_TOTALS_SELECT}
         FROM usage_events u
         ${sessionsJoin}
         ${where}`,
      )
      .get(params);
    return usageTotals(row);
  };

  return {
    today: totalsFor(1),
    last7Days: totalsFor(7),
    last30Days: totalsFor(30),
    allTime: totalsFor(null),
    window: { days: Math.trunc(days), ...totalsFor(days) },
  };
};
