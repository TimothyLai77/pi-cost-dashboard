/**
 * Model and project spend as a bipartite graph, for the flow drawing.
 *
 * Grouped by model and project together, which no other query does, and capped to the
 * number of nodes a drawing can label: the tail on each side rolls into an `all other` node
 * carrying everything it absorbed, and a flow with none of the chosen metric gets no band
 * to draw, so it is named in `dropped` instead of disappearing.
 */

import {
  costBreakdown,
  money,
  NO_COST_PARTS,
  usageFilters,
  whereFrom,
} from "./shared.js";

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
