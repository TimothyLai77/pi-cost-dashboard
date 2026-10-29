/**
 * Read queries for the dashboard API.
 *
 * Every money value leaves this layer as `costMicros` (integer micro-US dollars) plus a
 * formatted `costUsd` string, so the UI never sums raw floats.
 *
 * Cost is also reported in the four parts Pi bills it in — prompt tokens, completion
 * tokens, cached tokens re-read, cached tokens written. Those travel next to the total as
 * `costBreakdown`, each part shaped with the same micro-dollar and string pair, so a chart
 * can split a bar and a summary cell can say where the money went without adding floats.
 *
 * Stored timestamps are UTC. Day and hour bucketing is a display decision, so it happens
 * here in JavaScript through `Intl` (see timezone.js) rather than in SQL with a fixed
 * minute offset: a fixed offset is only correct while daylight time does not change inside
 * the requested range. Pass `timeZone` (an IANA name, or null for UTC) and every bucket is
 * resolved at its own instant.
 */

import { formatUsd } from "./scanner/aggregate.js";
import { localDay, localDayStart, localHour, nextDayString, offsetLabel, windowStartDay } from "./timezone.js";

/** Default page size for the session list. @type {number} */
export const DEFAULT_PAGE_SIZE = 25;

/** Maximum page size, so a request cannot ask for the whole table. @type {number} */
export const MAX_PAGE_SIZE = 200;

/**
 * Convert a micro-dollar total into the pair the API returns.
 * @param {number} costMicros Integer micro-dollars, may be null from SUM over no rows
 * @returns {{ costMicros: number, costUsd: string }}
 */
const money = (costMicros) => ({ costMicros: costMicros ?? 0, costUsd: formatUsd(costMicros ?? 0) });

/**
 * A row with no spend in it, for a bucket that has no facts behind it.
 * @type {{ cost_input_micros: number, cost_output_micros: number, cost_cache_read_micros: number, cost_cache_write_micros: number }}
 */
const NO_COST_PARTS = {
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
const costBreakdown = (row) => ({
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
const FACT_COLUMNS = `u.occurred_at, u.session_id, u.cost_micros, u.total_tokens,
              u.cost_input_micros, u.cost_output_micros, u.cost_cache_read_micros,
              u.cost_cache_write_micros,
              u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens`;

/**
 * Fields a bucket adds up out of every fact row, in the order the columns are read.
 * @type {string[]}
 */
const BUCKET_SUM_FIELDS = [
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
const usageFilters = (options, timeZone) => {
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
const whereFrom = (filters) => (filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "");

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
const bucketFacts = (rows, keyFor) => {
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
    for (const field of BUCKET_SUM_FIELDS) {
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
const pointFromBucket = (bucket) => ({
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
const pointsTotal = (points) => {
  const totalCostMicros = points.reduce((sum, point) => sum + point.costMicros, 0);
  return { totalCostMicros, totalCostUsd: formatUsd(totalCostMicros) };
};

/**
 * Clamp a requested page size.
 * @param {unknown} rawValue Value from a query parameter
 * @param {number} [fallback]
 * @returns {number}
 */
const clampLimit = (rawValue, fallback = DEFAULT_PAGE_SIZE) => {
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
const subagentCondition = (includeSubagents = true) =>
  includeSubagents ? "" : " AND s.parent_session_id IS NULL";

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
        `SELECT COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
                COALESCE(SUM(u.cost_input_micros), 0) AS cost_input_micros,
                COALESCE(SUM(u.cost_output_micros), 0) AS cost_output_micros,
                COALESCE(SUM(u.cost_cache_read_micros), 0) AS cost_cache_read_micros,
                COALESCE(SUM(u.cost_cache_write_micros), 0) AS cost_cache_write_micros,
                COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
                COUNT(DISTINCT u.session_id)     AS sessions,
                COUNT(*)                         AS events
         FROM usage_events u
         ${sessionsJoin}
         ${where}`,
      )
      .get(params);
    return {
      ...money(row.cost_micros),
      costBreakdown: costBreakdown(row),
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      sessions: row.sessions,
      events: row.events,
    };
  };

  return {
    today: totalsFor(1),
    last7Days: totalsFor(7),
    last30Days: totalsFor(30),
    allTime: totalsFor(null),
    window: { days: Math.trunc(days), ...totalsFor(days) },
  };
};

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
 * Every `YYYY-MM-DD` calendar string from one day to another, inclusive.
 * @param {string} fromDay `YYYY-MM-DD`
 * @param {string} toDay `YYYY-MM-DD`
 * @returns {string[]} Ascending day strings, empty when the range is inverted
 */
const dayRange = (fromDay, toDay) => {
  const days = [];
  let current = fromDay;
  // A hard ceiling keeps a bad range from looping; 3660 days is a decade of chart.
  while (current <= toDay && days.length < 3660) {
    days.push(current);
    current = nextDayString(current);
  }
  return days;
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

/**
 * Node cap for the flows query: 20 models and 20 projects do not fit in one drawing.
 * @type {number}
 */
const DEFAULT_FLOW_NODES = 6;

/** Largest node cap a request can ask for. @type {number} */
const MAX_FLOW_NODES = 20;

/** Label for the node that absorbs everything past the cap on its side. @type {string} */
const OTHER_LABEL = "all other";

/**
 * Clamp a requested node cap to a number of nodes the chart can label.
 * @param {unknown} rawValue Value from a query parameter
 * @param {number} [fallback]
 * @returns {number}
 */
const clampNodeLimit = (rawValue, fallback = DEFAULT_FLOW_NODES) => {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), MAX_FLOW_NODES);
};

/**
 * Which side of the id a flows node belongs to.
 * @param {"model" | "project"} kind
 * @param {string} identity Provider/model, or a session's cwd
 * @returns {string} An id that cannot collide between the two sides
 */
const flowNodeId = (kind, identity) => `${kind}:${identity}`;

/**
 * Model and project spend as a bipartite graph: which model spent what, in which project.
 *
 * Grouped by model *and* cwd together, which none of the other queries do, and shaped as
 * nodes and links so a flow diagram can draw it without summing anything: models on the
 * left, projects on the right, one link per pair that has any of the chosen metric.
 *
 * The metric is chosen by the caller. Money is the default, and tokens tell a genuinely
 * different story on a machine running local models: the model that moved 746M tokens here
 * billed $0.00, so it has no money to draw and appears only in the token view.
 *
 * Only the top `nodeLimit` models and top `nodeLimit` projects get their own node; the tail
 * on each side is rolled into an `all other` node, which carries the full totals of
 * everything it absorbed, not merely the slices that get drawn. Links are keyed by node id
 * (`model:anthropic/claude-sonnet-4-5`, `project:/home/user/git/spool-tracker`,
 * `model:all other`), so the two sides can never be confused for one node.
 *
 * A link with zero of the chosen metric is left out of the drawing — it has no width — and
 * counted in `dropped` with its totals, so the caller can say "this drawing leaves out 834M
 * tokens across 39 flows" rather than implying the picture is the whole bill. Identities
 * folded into an `all other` node are counted separately in `dropped.rolled`, because those
 * are drawn, just not under their own name. `totals` always describes the whole filtered
 * window, drops included.
 *
 * A band's `sessions` counts the sessions in the flows folded into it. One session that
 * called two models in the same project is counted in both bands, because the grouping is
 * per model and project: it is a count of sessions touching the band, not a distinct count
 * of the sessions behind it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ from?: string, to?: string, cwd?: string, provider?: string,
 *   includeSubagents?: boolean, timeZone?: string | null,
 *   metric?: "cost" | "tokens", nodeLimit?: number }} [options] Day bounds are local days
 *   in `timeZone`; `metric` defaults to cost and `nodeLimit` to 6
 * @returns {{ metric: string, nodeLimit: number, nodes: { id: string, kind: string, label: string,
 *   sublabel: string | null, costMicros: number, costUsd: string, totalTokens: number,
 *   events: number, rolledUp: boolean }[], links: { source: string, target: string,
 *   costMicros: number, costUsd: string, costBreakdown: object, totalTokens: number,
 *   sessions: number, events: number, rolledUp: boolean }[],
 *   totals: { costMicros: number, costUsd: string, costBreakdown: object, totalTokens: number,
 *   events: number, sessions: number, models: number, projects: number },
 *   drawn: { costMicros: number, totalTokens: number, flows: number },
 *   dropped: { costMicros: number, costUsd: string, totalTokens: number, flows: number,
 *   models: number, projects: number, rolled: { models: number, projects: number } }}
 *   Nodes are ordered models-first, each side by the chosen metric descending
 */
export const getFlows = (db, options = {}) => {
  const metric = options.metric === "tokens" ? "tokens" : "cost";
  const nodeLimit = clampNodeLimit(options.nodeLimit);

  // Bounds are local days converted to UTC instants, exactly as the daily chart does them.
  const { filters, params } = usageFilters(options, options.timeZone ?? null);
  const whereClause = whereFrom(filters);

  const pairs = db
    .prepare(
      `SELECT u.provider, u.model_id, s.cwd,
              COALESCE(SUM(u.cost_micros), 0)         AS cost_micros,
              COALESCE(SUM(u.cost_input_micros), 0)   AS cost_input_micros,
              COALESCE(SUM(u.cost_output_micros), 0)  AS cost_output_micros,
              COALESCE(SUM(u.cost_cache_read_micros), 0) AS cost_cache_read_micros,
              COALESCE(SUM(u.cost_cache_write_micros), 0) AS cost_cache_write_micros,
              COALESCE(SUM(u.total_tokens), 0)        AS total_tokens,
              COUNT(*)                                AS events,
              COUNT(DISTINCT u.session_id)            AS sessions
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}
       GROUP BY u.provider, u.model_id, s.cwd
       ORDER BY ${metric === "cost" ? "cost_micros" : "total_tokens"} DESC`,
    )
    .all(params);

  // A pair's size in the chosen metric. Zero pairs are real spend-less facts, not gaps.
  const size = (pair) => (metric === "cost" ? pair.cost_micros : pair.total_tokens);

  const modelKey = (pair) => `${pair.provider ?? "unspecified"}/${pair.model_id ?? "unspecified"}`;
  const projectLabel = (cwd) => {
    const trimmed = cwd.replace(/\/+$/, "");
    const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    return base.length > 0 ? base : trimmed;
  };

  // Side totals: what a node is worth overall, which is what its label reports — a node
  // that absorbed five projects shows the five projects' money, not the drawn flows' money.
  const sides = { model: new Map(), project: new Map() };
  const addTo = (map, key, pair) => {
    const side = map.get(key) ?? { cost_micros: 0, total_tokens: 0, events: 0, pairs: 0 };
    side.cost_micros += pair.cost_micros;
    side.total_tokens += pair.total_tokens;
    side.events += pair.events;
    side.pairs += 1;
    map.set(key, side);
  };
  for (const pair of pairs) {
    addTo(sides.model, modelKey(pair), pair);
    addTo(sides.project, pair.cwd, pair);
  }

  const ranked = (map) =>
    [...map.entries()]
      .sort((a, b) => metric === "cost" ? b[1].cost_micros - a[1].cost_micros : b[1].total_tokens - a[1].total_tokens)
      .map(([key, totals]) => ({ key, ...totals }));
  const rankedModels = ranked(sides.model);
  const rankedProjects = ranked(sides.project);
  const drawnModels = new Set(rankedModels.slice(0, nodeLimit).map((entry) => entry.key));
  const drawnProjects = new Set(rankedProjects.slice(0, nodeLimit).map((entry) => entry.key));

  // Links, with the tails folded onto the side's `all other` node. Folding makes pairs
  // share a source and target, so same-key links are summed into one band.
  const linksByKey = new Map();
  const drop = { cost_micros: 0, total_tokens: 0, flows: 0 };
  for (const pair of pairs) {
    if (size(pair) === 0) {
      drop.cost_micros += pair.cost_micros;
      drop.total_tokens += pair.total_tokens;
      drop.flows += 1;
      continue;
    }
    const model = drawnModels.has(modelKey(pair)) ? modelKey(pair) : OTHER_LABEL;
    const project = drawnProjects.has(pair.cwd) ? pair.cwd : OTHER_LABEL;
    const source = flowNodeId("model", model);
    const target = flowNodeId("project", project);
    const existing = linksByKey.get(`${source}\u0000${target}`);
    if (existing) {
      existing.pair.cost_micros += pair.cost_micros;
      existing.pair.cost_input_micros += pair.cost_input_micros;
      existing.pair.cost_output_micros += pair.cost_output_micros;
      existing.pair.cost_cache_read_micros += pair.cost_cache_read_micros;
      existing.pair.cost_cache_write_micros += pair.cost_cache_write_micros;
      existing.pair.total_tokens += pair.total_tokens;
      existing.pair.events += pair.events;
      existing.pair.sessions += pair.sessions;
      existing.rolledUp = existing.rolledUp || model === OTHER_LABEL || project === OTHER_LABEL;
      continue;
    }
    linksByKey.set(`${source}\u0000${target}`, {
      source,
      target,
      pair: {
        cost_micros: pair.cost_micros,
        cost_input_micros: pair.cost_input_micros,
        cost_output_micros: pair.cost_output_micros,
        cost_cache_read_micros: pair.cost_cache_read_micros,
        cost_cache_write_micros: pair.cost_cache_write_micros,
        total_tokens: pair.total_tokens,
        events: pair.events,
        sessions: pair.sessions,
      },
      rolledUp: model === OTHER_LABEL || project === OTHER_LABEL,
    });
  }

  const links = [...linksByKey.values()]
    .map((entry) => ({
      source: entry.source,
      target: entry.target,
      ...money(entry.pair.cost_micros),
      costBreakdown: costBreakdown(entry.pair),
      totalTokens: entry.pair.total_tokens,
      sessions: entry.pair.sessions,
      events: entry.pair.events,
      rolledUp: entry.rolledUp,
    }))
    .sort((a, b) => (metric === "cost" ? b.costMicros - a.costMicros : b.totalTokens - a.totalTokens));

  // A node is drawn when a link touches it. A model whose every flow is $0.00 has no band
  // to draw in the money view, so it is not a node there, and is counted in `dropped`.
  const touched = new Set(links.flatMap((link) => [link.source, link.target]));
  const nodes = [
    ...rankedModels
      .filter((entry) => touched.has(flowNodeId("model", entry.key)))
      .map((entry) => {
        const [provider, ...rest] = entry.key.split("/");
        return {
          id: flowNodeId("model", entry.key),
          kind: "model",
          label: rest.join("/") || provider,
          sublabel: rest.length > 0 ? provider : null,
          ...money(entry.cost_micros),
          totalTokens: entry.total_tokens,
          events: entry.events,
          rolledUp: false,
        };
      }),
    ...rankedProjects
      .filter((entry) => touched.has(flowNodeId("project", entry.key)))
      .map((entry) => ({
        id: flowNodeId("project", entry.key),
        kind: "project",
        label: projectLabel(entry.key),
        sublabel: entry.key,
        ...money(entry.cost_micros),
        totalTokens: entry.total_tokens,
        events: entry.events,
        rolledUp: false,
      })),
  ];

  // The `all other` node carries the tail's own totals, which is everything past the cap on
  // that side — including the zero-metric pairs that have no band to draw.
  const tailNode = (kind, rankedEntries) => {
    const tail = rankedEntries.slice(nodeLimit);
    if (tail.length === 0 || !touched.has(flowNodeId(kind, OTHER_LABEL))) return null;
    const totals = tail.reduce(
      (acc, entry) => ({
        cost_micros: acc.cost_micros + entry.cost_micros,
        total_tokens: acc.total_tokens + entry.total_tokens,
        events: acc.events + entry.events,
      }),
      { cost_micros: 0, total_tokens: 0, events: 0 },
    );
    return {
      id: flowNodeId(kind, OTHER_LABEL),
      kind,
      label: OTHER_LABEL,
      sublabel: `${tail.length} more`,
      ...money(totals.cost_micros),
      totalTokens: totals.total_tokens,
      events: totals.events,
      rolledUp: true,
    };
  };
  const modelTail = tailNode("model", rankedModels);
  const projectTail = tailNode("project", rankedProjects);
  const drawnNodes = [
    ...nodes.filter((node) => node.kind === "model"),
    ...(modelTail ? [modelTail] : []),
    ...nodes.filter((node) => node.kind === "project"),
    ...(projectTail ? [projectTail] : []),
  ];

  const totalOf = (entries, field) => entries.reduce((sum, entry) => sum + entry[field], 0);
  const parts = pairs.reduce(
    (acc, pair) => ({
      cost_input_micros: acc.cost_input_micros + pair.cost_input_micros,
      cost_output_micros: acc.cost_output_micros + pair.cost_output_micros,
      cost_cache_read_micros: acc.cost_cache_read_micros + pair.cost_cache_read_micros,
      cost_cache_write_micros: acc.cost_cache_write_micros + pair.cost_cache_write_micros,
    }),
    { ...NO_COST_PARTS },
  );
  const droppedModels = rankedModels.filter((entry) => !touched.has(flowNodeId("model", entry.key)));
  const droppedProjects = rankedProjects.filter((entry) => !touched.has(flowNodeId("project", entry.key)));

  return {
    metric,
    nodeLimit,
    nodes: drawnNodes,
    links,
    totals: {
      ...money(totalOf(rankedModels, "cost_micros")),
      costBreakdown: costBreakdown(parts),
      totalTokens: totalOf(rankedModels, "total_tokens"),
      events: totalOf(rankedModels, "events"),
      sessions: db
        .prepare(
          `SELECT COUNT(DISTINCT s.session_id) AS n
           FROM usage_events u JOIN sessions s ON s.session_id = u.session_id
           ${whereClause}`,
        )
        .get(params).n,
      models: rankedModels.length,
      projects: rankedProjects.length,
    },
    drawn: {
      costMicros: links.reduce((sum, link) => sum + link.costMicros, 0),
      totalTokens: links.reduce((sum, link) => sum + link.totalTokens, 0),
      flows: links.length,
      models: drawnNodes.filter((node) => node.kind === "model").length,
      projects: drawnNodes.filter((node) => node.kind === "project").length,
    },
    dropped: {
      // Flows with none of the chosen metric: they have no band to draw, so their money and
      // tokens are named here and appear in no node.
      ...money(drop.cost_micros),
      totalTokens: drop.total_tokens,
      flows: drop.flows,
      models: droppedModels.length,
      projects: droppedProjects.length,
      // Identities that were folded into the side's `all other` node. These are drawn, just
      // not under their own name, which is a different fact from having nothing to draw.
      rolled: {
        models: rankedModels.filter((entry) => !drawnModels.has(entry.key)).length,
        projects: rankedProjects.filter((entry) => !drawnProjects.has(entry.key)).length,
      },
    },
  };
};

/**
 * Distinct filter values for the dashboard controls.
 * @param {import("better-sqlite3").Database} db
 * @returns {{ projects: string[], providers: string[] }}
 */
export const getFilters = (db) => ({
  projects: db
    .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd <> '' ORDER BY cwd")
    .all()
    .map((row) => row.cwd),
  providers: db
    .prepare("SELECT DISTINCT provider FROM usage_events WHERE provider IS NOT NULL ORDER BY provider")
    .all()
    .map((row) => row.provider),
});

/**
 * Operator sanity check: is the scanner keeping up with the files?
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionsDir
 * @param {number} [fileCount] Files currently on disk, when already known
 * @returns {object}
 */
export const getHealth = (db, sessionsDir, fileCount) => {
  const schemaVersion = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta")
    .get().version;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  const events = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
  const lastScan = db.prepare("SELECT MAX(scanned_at) AS at FROM scan_state").get().at;
  const totals = db
    .prepare("SELECT COALESCE(SUM(cost_micros), 0) AS cost_micros FROM sessions")
    .get();

  return {
    status: "ok",
    dbPath: db.name,
    sessionsDir,
    schemaVersion,
    sessionCount: sessions,
    usageEventCount: events,
    sessionFilesOnDisk: fileCount ?? null,
    lastScanAt: lastScan,
    ...money(totals.cost_micros),
  };
};
