/**
 * Shared building blocks behind the dashboard's read queries.
 *
 * These are the pieces every read query in this directory needs and none of them owns: the
 * micro-dollar pair money leaves the API in, the WHERE terms a request turns into SQL, the
 * column list every aggregate reads, and the bucket sums that answer a wall-clock question in
 * JavaScript because SQLite has no timezone database.
 *
 * Nothing here answers a question by itself; the sibling modules do that. Two rules the whole
 * layer rests on are worth restating here, because every helper below assumes both: stored
 * timestamps are UTC, so a day or hour bucket is resolved at its own instant through `Intl`
 * (see ../timezone.js) rather than by a fixed minute offset, and money travels as integer
 * micro-dollars next to a display string, so nothing upstream adds floats.
 */

import { formatUsd } from "../scanner/aggregate.js";
import { localDayStart, nextDayString } from "../timezone.js";

/** Default page size for the session list. @type {number} */
export const DEFAULT_PAGE_SIZE = 25;

/** Maximum page size, so a request cannot ask for the whole table. @type {number} */
export const MAX_PAGE_SIZE = 200;

/**
 * Convert a micro-dollar total into the pair the API returns.
 * @param {number} costMicros Integer micro-dollars, may be null from SUM over no rows
 * @returns {{ costMicros: number, costUsd: string }}
 */
export const money = (costMicros) => ({ costMicros: costMicros ?? 0, costUsd: formatUsd(costMicros ?? 0) });

/**
 * A row with no spend in it, for a bucket that has no facts behind it.
 * @type {{ cost_input_micros: number, cost_output_micros: number, cost_cache_read_micros: number, cost_cache_write_micros: number }}
 */
export const NO_COST_PARTS = {
  cost_input_micros: 0,
  cost_output_micros: 0,
  cost_cache_read_micros: 0,
  cost_cache_write_micros: 0,
};

/**
 * Shape the four parts of a bill the way the totals are shaped.
 *
 * The parts come straight from the stored columns, which came from Pi's `usage.cost`, so
 * this adds nothing up: it names the four and formats each for display.
 *
 * @param {object} row Query row carrying cost_input_micros, cost_output_micros,
 *   cost_cache_read_micros and cost_cache_write_micros; missing columns read as zero
 * @returns {{ input: object, output: object, cacheRead: object, cacheWrite: object }}
 *   Each value is a `{ costMicros, costUsd }` pair
 */
export const costBreakdown = (row) => ({
  input: money(row.cost_input_micros),
  output: money(row.cost_output_micros),
  cacheRead: money(row.cost_cache_read_micros),
  cacheWrite: money(row.cost_cache_write_micros),
});

/**
 * The columns every aggregate reads when it sums usage facts itself.
 *
 * Daily, hourly and flow grouping all need money in its four parts, tokens in its four
 * kinds, and the instant and session each fact belongs to. They read one shared column list
 * so a bucket cannot sum a field the others leave out.
 *
 * @type {string}
 */
export const FACT_COLUMNS = `u.occurred_at, u.session_id, u.cost_micros, u.total_tokens,
              u.cost_input_micros, u.cost_output_micros, u.cost_cache_read_micros,
              u.cost_cache_write_micros,
              u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens`;

/**
 * Shape a row of summed usage columns into the totals every endpoint reports.
 *
 * The summary windows and the lifetime page both answer the same question — what this set of
 * usage facts spent — so they shape their answer the same way: the money pair, its four
 * parts, the four token kinds, and how much work produced them. A chart bucket is not passed
 * through here; it holds its sessions as a Set and sums no rows at all.
 *
 * @param {object} row Query row carrying cost_micros, the four cost parts, the five token
 *   columns, sessions and events
 * @returns {object} `costMicros`/`costUsd`, `costBreakdown`, the four token kinds, sessions, events
 */
export const usageTotals = (row) => ({
  ...money(row.cost_micros),
  costBreakdown: costBreakdown(row),
  totalTokens: row.total_tokens,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteTokens: row.cache_write_tokens,
  sessions: row.sessions,
  events: row.events,
});

/**
 * The usage columns every total adds up, in the order they are read.
 *
 * One list feeds the SQL sums and the JavaScript bucket sums, so a day on the chart and the
 * summary next to it cannot drift apart by leaving a field out of one of them.
 *
 * @type {string[]}
 */
const USAGE_SUM_FIELDS = [
  "cost_micros",
  "cost_input_micros",
  "cost_output_micros",
  "cost_cache_read_micros",
  "cost_cache_write_micros",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

/**
 * The SELECT list that turns usage facts into one totals row.
 *
 * Money in its four parts, tokens in their four kinds, and the sessions and events behind
 * them. Written once because every endpoint that reports a whole total reads exactly these
 * columns, so a sum cannot be missing from one endpoint and present in another.
 *
 * Names `u` for usage_events, so the caller must alias the table the same way.
 * @type {string}
 */
export const USAGE_TOTALS_SELECT = [
  ...USAGE_SUM_FIELDS.map((field) => `COALESCE(SUM(u.${field}), 0) AS ${field}`),
  "COUNT(DISTINCT u.session_id) AS sessions",
  "COUNT(*) AS events",
].join(",\n              ");

/**
 * WHERE clauses and parameters for the filters every aggregate over usage shares.
 *
 * Day bounds are local days in `timeZone` and become UTC instants here: `from` is the instant
 * that day began (inclusive) and `to` is the instant the day after it began (exclusive), so a
 * one-day window passes the same string as both. Timestamps are fixed-width ISO strings, so
 * string comparison is chronological.
 *
 * The clauses name `u` (usage_events) and `s` (sessions), so the caller must join both. Each
 * term is bare, without an `AND` prefix, because the caller joins the list with `AND`.
 *
 * @param {{ from?: string, to?: string, cwd?: string, provider?: string, includeSubagents?: boolean }} options
 *   Absent bounds and filters add no clause
 * @param {string | null} timeZone IANA zone name; null means UTC
 * @returns {{ filters: string[], params: Record<string, string> }} Clauses to join, and their parameters
 */
export const usageFilters = (options, timeZone) => {
  const filters = [];
  const params = {};
  if (options.from) {
    filters.push("u.occurred_at >= @start");
    params.start = localDayStart(options.from, timeZone);
  }
  if (options.to) {
    filters.push("u.occurred_at < @end");
    params.end = localDayStart(nextDayString(options.to), timeZone);
  }
  if (options.cwd) {
    filters.push("s.cwd = @cwd");
    params.cwd = options.cwd;
  }
  if (options.provider) {
    filters.push("u.provider = @provider");
    params.provider = options.provider;
  }
  if (options.includeSubagents === false) {
    filters.push("s.parent_session_id IS NULL");
  }
  return { filters, params };
};

/**
 * A WHERE clause built from bare filter terms.
 * @param {string[]} filters Terms the caller joins with AND
 * @returns {string} `WHERE a AND b`, or an empty string when nothing filters
 */
export const whereFrom = (filters) => (filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "");

/**
 * Sum usage facts into one bucket per time period.
 *
 * A bucket carries money in its four parts, tokens in their four kinds, a call count, and the
 * set of sessions that touched the period. The period is a caller-supplied key, which is the
 * only difference between the daily and hourly views: same facts, same sums, grouped by
 * `localDay` in one and `localHour` in the other.
 *
 * @param {object[]} rows Facts read with the shared FACT_COLUMNS list
 * @param {(row: object) => string} keyFor The period a fact belongs to
 * @returns {Map<string, object>} Buckets keyed by period, in first-seen order
 */
export const bucketFacts = (rows, keyFor) => {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const bucket = buckets.get(key) ?? {
      ...NO_COST_PARTS,
      cost_micros: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      events: 0,
      sessions: new Set(),
    };
    for (const field of USAGE_SUM_FIELDS) {
      bucket[field] += row[field];
    }
    bucket.events += 1;
    bucket.sessions.add(row.session_id);
    buckets.set(key, bucket);
  }
  return buckets;
};

/**
 * One chart point from a bucket, in the shape every chart reads.
 *
 * A period with no facts is not a gap: it spent nothing, so it renders as a zero point with
 * four zero parts. That is what keeps a zero-cost day on the chart instead of leaving a hole.
 *
 * @param {object | undefined} bucket The period's bucket, undefined when nothing landed in it
 * @returns {object} costMicros, costUsd, costBreakdown, the four token kinds, events, sessions
 */
export const pointFromBucket = (bucket) => ({
  ...money(bucket?.cost_micros ?? 0),
  costBreakdown: costBreakdown(bucket ?? NO_COST_PARTS),
  totalTokens: bucket?.total_tokens ?? 0,
  inputTokens: bucket?.input_tokens ?? 0,
  outputTokens: bucket?.output_tokens ?? 0,
  cacheReadTokens: bucket?.cache_read_tokens ?? 0,
  cacheWriteTokens: bucket?.cache_write_tokens ?? 0,
  events: bucket?.events ?? 0,
  sessions: bucket ? bucket.sessions.size : 0,
});

/**
 * A range's whole total, summed once from the points that make it up.
 * @param {{ costMicros: number }[]} points
 * @returns {{ totalCostMicros: number, totalCostUsd: string }}
 */
export const pointsTotal = (points) => {
  const totalCostMicros = points.reduce((sum, point) => sum + point.costMicros, 0);
  return { totalCostMicros, totalCostUsd: formatUsd(totalCostMicros) };
};

/**
 * Clamp a requested page size.
 * @param {unknown} rawValue Value from a query parameter
 * @param {number} [fallback]
 * @returns {number}
 */
export const clampLimit = (rawValue, fallback = DEFAULT_PAGE_SIZE) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), MAX_PAGE_SIZE);
};

/**
 * SQL condition that drops nested subagent sessions, when the caller asked for that.
 *
 * Pi bills a subagent twice over: the child session file carries its own usage, and the
 * parent records a toolResult usage entry summarising the same nested calls. Both are real
 * spend, so totals include both by default. The filter exists so you can read the ledger
 * as "money this session paid directly" without the nested half appearing again.
 *
 * Needs the sessions table aliased as `s` in the query.
 *
 * @param {boolean} [includeSubagents] Default true: count nested sessions too
 * @returns {string} An `AND ...` clause, empty when nothing is excluded
 */
export const subagentCondition = (includeSubagents = true) =>
  includeSubagents ? "" : " AND s.parent_session_id IS NULL";

/**
 * Every `YYYY-MM-DD` calendar string from one day to another, inclusive.
 * @param {string} fromDay `YYYY-MM-DD`
 * @param {string} toDay `YYYY-MM-DD`
 * @returns {string[]} Ascending day strings, empty when the range is inverted
 */
export const dayRange = (fromDay, toDay) => {
  const days = [];
  let current = fromDay;
  // A hard ceiling keeps a bad range from looping; 3660 days is a decade of chart.
  while (current <= toDay && days.length < 3660) {
    days.push(current);
    current = nextDayString(current);
  }
  return days;
};
