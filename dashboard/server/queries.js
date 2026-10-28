/**
 * Read queries for the dashboard API.
 *
 * Every money value leaves this layer as `costMicros` (integer micro-US dollars) plus a
 * formatted `costUsd` string, so the UI never sums raw floats.
 *
 * Day bucketing is UTC by default because stored timestamps are UTC. Pass
 * `tzOffsetMinutes` to bucket by local day instead: the offset is applied in SQL with
 * `datetime(occurred_at, offset)`, so stored data stays unambiguous.
 */

import { formatUsd } from "./scanner/aggregate.js";

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
 * Build the SQL fragment that shifts a UTC timestamp into the requested day.
 * @param {number} [tzOffsetMinutes] Minutes east of UTC; omitted means UTC
 * @returns {string} SQL expression producing a YYYY-MM-DD string
 */
const dayExpression = (tzOffsetMinutes) => {
  const offset = Number(tzOffsetMinutes);
  if (!Number.isFinite(offset) || offset === 0) return "date(u.occurred_at)";
  return `date(datetime(u.occurred_at, '${Math.trunc(offset)} minutes'))`;
};

/**
 * Totals for a window, and for all time.
 *
 * Sessions are counted by distinct sessions contributing usage in the window; cost is
 * counted by when the usage happened, which is the same basis the chart uses.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {number} [days] Window length in days, counted backwards from today (UTC)
 * @returns {{ window: object, allTime: object, today: object, last7Days: object, last30Days: object }}
 */
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
 * @param {import("better-sqlite3").Database} db
 * @param {number | null} [days] Window length in days, counted backwards from today (UTC); null means all time
 * @param {{ includeSubagents?: boolean }} [options]
 * @returns {{ window: object, allTime: object, today: object, last7Days: object, last30Days: object }}
 */
export const getSummary = (db, days = 7, options = {}) => {
  const includeSubagents = options.includeSubagents !== false;
  // Excluding subagents needs the sessions table, so the join is only paid for when used.
  const sessionsJoin = includeSubagents ? "" : "JOIN sessions s ON s.session_id = u.session_id";
  const subagents = subagentCondition(includeSubagents);

  const totalsFor = (dayCount) => {
    // Cost is bucketed by when the usage happened, the same basis the chart uses, so a
    // session resumed days later bills its new usage to the later day.
    const where = dayCount === null
      ? subagents.trim().length > 0
        ? `WHERE TRUE ${subagents}`
        : ""
      : `WHERE date(u.occurred_at) >= date('now', '-${Math.trunc(dayCount) - 1} days')${subagents}`;
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
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
      .get();
    return {
      ...money(row.cost_micros),
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
 * @param {{ from?: string, to?: string, cwd?: string, provider?: string, tzOffsetMinutes?: number }} [options]
 * @returns {{ range: object, points: { day: string, costMicros: number, costUsd: string, totalTokens: number, sessions: number }[] }}
 */
export const getDailyCost = (db, options = {}) => {
  const tzOffset = Number(options.tzOffsetMinutes ?? 0);
  const day = dayExpression(options.tzOffsetMinutes);

  const filters = [];
  const params = {};
  if (options.from) {
    filters.push(`${day} >= date(@from)`);
    params.from = options.from;
  }
  if (options.to) {
    filters.push(`${day} <= date(@to)`);
    params.to = options.to;
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
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT ${day} AS day,
              COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
              COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
              COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
              COUNT(*)                         AS events,
              COUNT(DISTINCT u.session_id)     AS sessions
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}
       GROUP BY day
       ORDER BY day`,
    )
    .all(params);

  const pointsByDay = new Map(rows.map((row) => [row.day, row]));

  // Fill gaps between the first and last day in range.
  const boundaries = db
    .prepare(
      `SELECT MIN(${day}) AS first_day, MAX(${day}) AS last_day
       FROM usage_events u JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}`,
    )
    .get(params);

  const startDay = options.from ?? boundaries.first_day;
  const endDay = options.to ?? boundaries.last_day;
  const points = [];

  if (startDay && endDay) {
    const fill = db
      .prepare(
        `WITH days AS (
           SELECT date(@start) AS day
           UNION ALL
           SELECT date(day, '+1 day') FROM days WHERE day < date(@end)
         )
         SELECT day FROM days ORDER BY day`,
      )
      .all({ start: startDay, end: endDay });

    for (const { day: dayValue } of fill) {
      const row = pointsByDay.get(dayValue) ?? {
        cost_micros: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        events: 0,
        sessions: 0,
      };
      points.push({
        day: dayValue,
        ...money(row.cost_micros),
        totalTokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        events: row.events,
        sessions: row.sessions,
      });
    }
  }

  return {
    range: {
      from: startDay ?? null,
      to: endDay ?? null,
      tzOffsetMinutes: Number.isFinite(tzOffset) ? Math.trunc(tzOffset) : 0,
    },
    totalCostMicros: points.reduce((sum, point) => sum + point.costMicros, 0),
    totalCostUsd: formatUsd(points.reduce((sum, point) => sum + point.costMicros, 0)),
    points,
  };
};

/**
 * Build the SQL fragment that shifts a UTC timestamp into the requested hour.
 *
 * Mirrors dayExpression: the shift is applied to the timestamp before formatting, so the
 * hour labels are in the same frame as the day labels the daily chart shows.
 *
 * @param {number} [tzOffsetMinutes] Minutes east of UTC; omitted means UTC
 * @returns {string} SQL expression producing a 'YYYY-MM-DD HH:00' string
 */
const hourExpression = (tzOffsetMinutes) => {
  const offset = Number(tzOffsetMinutes);
  const shift = Number.isFinite(offset) && offset !== 0 ? `, '${Math.trunc(offset)} minutes'` : "";
  return `strftime('%Y-%m-%d %H:00', datetime(u.occurred_at${shift}))`;
};

/**
 * Hourly cost points for one day, for the drill-down under the daily chart.
 *
 * All 24 hours of the day are returned, empty ones as zeros. A sparse day that shows only
 * the hours with spend reads as a claim that nothing happened in the gaps, and the whole
 * point of the hourly view is to say which hours were idle.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ day: string, cwd?: string, provider?: string, tzOffsetMinutes?: number }} options
 *   `day` is the YYYY-MM-DD value the daily chart showed, in the same timezone frame
 * @returns {{ day: string, range: object, points: { hour: string, label: string, costMicros: number, costUsd: string, totalTokens: number, sessions: number }[] }}
 */
export const getHourlyCost = (db, options = {}) => {
  const tzOffset = Number(options.tzOffsetMinutes ?? 0);
  const hour = hourExpression(options.tzOffsetMinutes);

  const filters = [`CAST(${hour} AS TEXT) >= datetime(@day)`, `CAST(${hour} AS TEXT) < datetime(@day, '+1 day')`];
  const params = { day: options.day };

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
  const whereClause = `WHERE ${filters.join(" AND ")}`;

  const rows = db
    .prepare(
      `SELECT ${hour} AS hour,
              COALESCE(SUM(u.cost_micros), 0) AS cost_micros,
              COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
              COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
              COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
              COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
              COUNT(*)                         AS events,
              COUNT(DISTINCT u.session_id)     AS sessions
       FROM usage_events u
       JOIN sessions s ON s.session_id = u.session_id
       ${whereClause}
       GROUP BY hour
       ORDER BY hour`,
    )
    .all(params);

  const pointsByHour = new Map(rows.map((row) => [row.hour, row]));

  // 24 fixed labels for the day, in the requested timezone frame.
  const hours = db
    .prepare(
      `WITH hours AS (
         SELECT strftime('%Y-%m-%d %H:00', datetime(date(@day))) AS hour
         UNION ALL
         SELECT strftime('%Y-%m-%d %H:00', datetime(hour, '+1 hour'))
         FROM hours
         WHERE datetime(hour, '+1 hour') < datetime(date(@day), '+1 day')
       )
       SELECT hour FROM hours ORDER BY hour`,
    )
    .all({ day: options.day });

  const points = hours.map(({ hour: hourValue }) => {
    const row = pointsByHour.get(hourValue) ?? {
      cost_micros: 0,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      events: 0,
      sessions: 0,
    };
    return {
      hour: hourValue,
      label: hourValue.slice(11, 16),
      ...money(row.cost_micros),
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      events: row.events,
      sessions: row.sessions,
    };
  });

  return {
    day: options.day,
    range: {
      from: hours[0]?.hour ?? null,
      to: hours[hours.length - 1]?.hour ?? null,
      tzOffsetMinutes: Number.isFinite(tzOffset) ? Math.trunc(tzOffset) : 0,
    },
    totalCostMicros: points.reduce((sum, point) => sum + point.costMicros, 0),
    totalCostUsd: formatUsd(points.reduce((sum, point) => sum + point.costMicros, 0)),
    points,
  };
};

/**
 * Session list, newest activity first.
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
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const orderBy = options.sort === "cost" ? "cost_micros DESC" : "last_activity_at DESC";

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM sessions s ${whereClause}`)
    .get(params).n;

  const rows = db
    .prepare(
      `SELECT s.session_id, s.session_file, s.parent_session_id, s.cwd, s.name,
              s.started_at, s.last_activity_at, s.entry_count, s.cost_micros,
              s.total_tokens, s.user_messages, s.assistant_messages, s.tool_calls,
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
