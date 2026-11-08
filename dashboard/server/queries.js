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
import { localDay, localDayStart, localHour, offsetLabel, windowStartDay } from "./timezone.js";
import {
  bucketFacts,
  clampLimit,
  costBreakdown,
  dayRange,
  FACT_COLUMNS,
  money,
  NO_COST_PARTS,
  pointFromBucket,
  pointsTotal,
  subagentCondition,
  USAGE_TOTALS_SELECT,
  usageFilters,
  usageTotals,
  whereFrom,
} from "./queries/shared.js";

// The page sizes live in the shared kernel; re-exported so the API keeps one entry point.
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./queries/shared.js";

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
 * Operator sanity check: what is in the database, and can the scanner see any files at all?
 *
 * `scanner` comes from `scannerStatus()` in the scanner module. It is passed in rather than
 * worked out here because "not looked" and "looked, found none" are different answers, and only
 * the caller knows which one it has.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionsDir The directory the scanner was told to read
 * @param {{ enabled?: boolean, reason?: string | null, fileCount?: number | null }} [scanner]
 * @returns {object}
 */
export const getHealth = (db, sessionsDir, scanner) => {
  const state = scanner ?? { enabled: false, reason: "scanner state unavailable", fileCount: null };
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
    scanner: { enabled: state.enabled ?? false, reason: state.reason ?? null },
    schemaVersion,
    sessionCount: sessions,
    usageEventCount: events,
    sessionFilesOnDisk: state.fileCount ?? null,
    lastScanAt: lastScan,
    ...money(totals.cost_micros),
  };
};
