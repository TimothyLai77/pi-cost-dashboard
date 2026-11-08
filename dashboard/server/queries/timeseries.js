/**
 * The time series behind the two charts: daily spend, and the 24 hours of one day.
 *
 * Both read the same facts and bucket them in JavaScript rather than in SQL, because which
 * local day or hour a fact belongs to is a wall-clock question and SQLite has no timezone
 * database. Both fill every period in range with a zero point when nothing landed in it, so
 * an idle day or hour reads as a quiet machine rather than an outage.
 */

import {
  bucketFacts,
  dayRange,
  FACT_COLUMNS,
  pointFromBucket,
  pointsTotal,
  usageFilters,
  whereFrom,
} from "./shared.js";
import { localDay, localDayStart, localHour, offsetLabel } from "../timezone.js";

/**
 * Daily cost points for the chart.
 *
 * Days with no spend are returned as zero points across the whole requested range, so
 * the chart does not draw a straight line between sparse days. Unpriced local models
 * produce genuine $0 days, and a chart that hides them reads as an outage.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ from?: string, to?: string, cwd?: string, provider?: string, includeSubagents?: boolean, timeZone?: string | null }} [options]
 * @returns {{ range: object, points: { day: string, costMicros: number, costUsd: string, costBreakdown: object, totalTokens: number, sessions: number }[] }}
 */
export const getDailyCost = (db, options = {}) => {
  const timeZone = options.timeZone ?? null;

  // Bounds are local days, so the shared builder turns them into UTC instants: from-day
  // start (inclusive) to the instant the day after `to` begins (exclusive).
  const { filters, params } = usageFilters(options, timeZone);
  const whereClause = whereFrom(filters);

  // Facts, not SQL aggregates: the day a fact belongs to is a wall-clock question, and
  // SQLite has no timezone database. This is a few thousand rows on a large install.
  const rows = db
    .prepare(
      `SELECT ${FACT_COLUMNS}
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}
       ORDER BY u.occurred_at`,
    )
    .all(params);

  const byDay = bucketFacts(rows, (row) => localDay(row.occurred_at, timeZone));

  const days = [...byDay.keys()].sort();
  const startDay = options.from ?? days[0] ?? null;
  const endDay = options.to ?? days[days.length - 1] ?? null;
  const points = [];

  if (startDay && endDay) {
    // Zero-fill the whole range: a day that spent nothing is a fact about this machine, not
    // a gap, and a chart that hides it reads as an outage.
    for (const day of dayRange(startDay, endDay)) {
      points.push({ day, ...pointFromBucket(byDay.get(day)) });
    }
  }

  return {
    range: {
      from: startDay,
      to: endDay,
      timeZone: timeZone ?? "UTC",
      // The offset a reader wants is the one in effect for the window they are looking at,
      // not today's: a January range in Denver is UTC-7 even when it is July right now.
      offsetLabel: offsetLabel(
        timeZone,
        endDay ? new Date(localDayStart(endDay, timeZone)) : new Date(),
      ),
    },
    ...pointsTotal(points),
    points,
  };
};

/**
 * Hourly cost points for one day, for the drill-down under the daily chart.
 *
 * All 24 hours of the day are returned, empty ones as zeros. A sparse day that shows only
 * the hours with spend reads as a claim that nothing happened in the gaps, and the whole
 * point of the hourly view is to say which hours were idle.
 *
 * Each hour carries `costBreakdown`, so the drill-down can say what an hour's spend was
 * made of, not only how much it was.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ day: string, cwd?: string, provider?: string, includeSubagents?: boolean, timeZone?: string | null }} options
 *   `day` is the YYYY-MM-DD value the daily chart showed, in the same zone frame
 * @returns {{ day: string, range: object, points: { hour: string, label: string, costMicros: number, costUsd: string, costBreakdown: object, totalTokens: number, sessions: number }[] }}
 */
export const getHourlyCost = (db, options = {}) => {
  const timeZone = options.timeZone ?? null;

  // The drill-down is one day, so the same string bounds both ends: the instant the day
  // began, and the instant the next one began.
  const { filters, params } = usageFilters({ ...options, from: options.day, to: options.day }, timeZone);
  const whereClause = `WHERE ${filters.join(" AND ")}`;

  const rows = db
    .prepare(
      `SELECT ${FACT_COLUMNS}
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}
       ORDER BY u.occurred_at`,
    )
    .all(params);

  const byHour = bucketFacts(rows, (row) => localHour(row.occurred_at, timeZone));

  // 24 fixed labels for the local day, so idle hours are visible.
  const points = Array.from({ length: 24 }, (_, index) => {
    const hour = `${options.day} ${String(index).padStart(2, "0")}:00`;
    return { hour, label: hour.slice(11, 16), ...pointFromBucket(byHour.get(hour)) };
  });

  return {
    day: options.day,
    range: {
      from: points[0]?.hour ?? null,
      to: points[points.length - 1]?.hour ?? null,
      timeZone: timeZone ?? "UTC",
      offsetLabel: offsetLabel(timeZone, new Date(localDayStart(options.day, timeZone))),
    },
    ...pointsTotal(points),
    points,
  };
};
