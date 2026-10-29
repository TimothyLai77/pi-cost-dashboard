/**
 * The flow diagram's geometry and tooltip content, computed outside the drawing.
 *
 * `FlowsChart.jsx` draws; everything here decides what gets drawn and what the tooltip
 * says. It lives in a plain module because the two things most likely to be wrong in a
 * flow diagram — which band attaches to which node, and what disappears when the metric
 * is money — are arithmetic, and a chart canvas is a poor place to test arithmetic.
 *
 * The API hands back nodes with string ids (`model:strata/swift-1.5-iq3_xxs`,
 * `project:/home/user/git/spool-tracker`) because two sides of a diagram can share a
 * name — "all other" exists on both — while Recharts wants links that point at node
 * indexes. `toIndexedLinks` is the bridge.
 */

import { formatTokens, formatCostSmart } from "../api.js";
import { COST_PARTS } from "./costParts.js";

/**
 * Band and node hues, one per model, in the order models are ranked by the metric.
 *
 * These are deliberately not the four cost-part hues: in the charts those mean "which part
 * of the bill", and here a color means "which model".
 *
 * @type {string[]}
 */
export const FLOW_HUES = [
  "var(--flow-1)",
  "var(--flow-2)",
  "var(--flow-3)",
  "var(--flow-4)",
  "var(--flow-5)",
  "var(--flow-6)",
  "var(--flow-7)",
];

/** Project nodes carry no color of their own; the bands arriving in them do. @type {string} */
export const PROJECT_NODE = "var(--ink-soft)";

/** The `all other` node: a tally, not an entity, so it wears the page's quietest line. @type {string} */
export const ROLLUP_NODE = "var(--rule-strong)";

/**
 * Which unit a band is measured in, as an exact integer.
 *
 * Micro-dollars and tokens are both whole numbers, so no float summing decides how wide a
 * band is.
 *
 * @param {string} metric "cost" or "tokens"
 * @param {{ costMicros: number, totalTokens: number }} entry A link from `/api/flows`
 * @returns {number} The band's value
 */
export const bandValue = (metric, entry) => (metric === "tokens" ? entry.totalTokens : entry.costMicros);

/**
 * Which hue a node wears.
 *
 * Models wear the hue of their rank in the drawn list, so the same model's bands all match
 * and the biggest spender is always the first hue. A roll-up node wears the rule color, and
 * project nodes are neutral: color is the model's identity, position is the project's.
 *
 * @param {{ kind: string, rolledUp: boolean }} node
 * @param {number} modelRank Index of the model among the drawn models; ignored for projects
 * @returns {string} A CSS color
 */
export const nodeColor = (node, modelRank) => {
  if (node.rolledUp) return ROLLUP_NODE;
  if (node.kind !== "model") return PROJECT_NODE;
  return FLOW_HUES[Math.max(modelRank, 0) % FLOW_HUES.length];
};

/**
 * Turn the API's named nodes and links into the index-keyed shape Recharts draws.
 *
 * Two bands are dropped here. A band with none of the chosen metric has no width, and the
 * server already excludes those; this is the guard, not the rule. A band whose endpoints
 * are not in the node list is dropped too, because attaching it to a missing index places
 * it at node 0 and draws a flow that is not in the picture.
 *
 * @param {{ metric: string, nodes: { id: string }[], links: { source: string, target: string, costMicros: number, totalTokens: number }[] }} flows
 * @returns {{ nodes: object[], links: { source: number, target: number, value: number, payload: object }[] }}
 */
export const toIndexedLinks = (flows) => {
  const indexOf = new Map(flows.nodes.map((node, index) => [node.id, index]));

  return {
    nodes: flows.nodes,
    links: flows.links
      .map((link) => ({
        source: indexOf.get(link.source),
        target: indexOf.get(link.target),
        value: bandValue(flows.metric, link),
        payload: link,
      }))
      .filter((link) => link.source !== undefined && link.target !== undefined && link.value > 0),
  };
};

/**
 * What the tooltip says about a band or a node, in lines.
 *
 * A band names the model and the project it joins, the money in dollars, what that money
 * was billed in (the four parts), and the sessions and calls behind it. A node names
 * itself, its total, the calls that touched it, and its sublabel — the provider under a
 * model, the full path under a project, the count of what an `all other` node stands for.
 *
 * @param {object} entry A link or a node from `/api/flows`
 * @returns {{ title: string, money: string, parts: string | null, context: string, sub: string | null }}
 */
export const flowTooltipLines = (entry) => {
  const isNode = entry.kind === "model" || entry.kind === "project";
  const title = isNode
    ? `${entry.kind === "model" ? "Model" : "Project"} · ${entry.label}`
    : `${entry.source?.label ?? entry.source} → ${entry.target?.label ?? entry.target}`;

  return {
    title,
    money: formatCostSmart(entry.costMicros),
    // The four parts belong to a band: a node sums flows from many bills, and its own parts
    // come from the node's totals, which the server does not split into parts.
    parts: isNode
      ? null
      : COST_PARTS.map((part) => `${part.label} ${entry.costBreakdown?.[part.key]?.costUsd ?? "$0.00"}`).join(
          " · ",
        ),
    context: isNode
      ? `${formatTokens(entry.totalTokens)} tokens · ${entry.events} call${entry.events === 1 ? "" : "s"}`
      : `${formatTokens(entry.totalTokens)} tokens · ${entry.sessions} session${entry.sessions === 1 ? "" : "s"} · ${
          entry.events
        } call${entry.events === 1 ? "" : "s"}`,
    sub: isNode ? (entry.sublabel ?? null) : null,
  };
};
