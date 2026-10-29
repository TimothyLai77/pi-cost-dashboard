/**
 * The four parts of a bill, shared by the summary strip and both charts.
 *
 * Pi's pricing pass reports a call's cost as prompt tokens, completion tokens, cache reads
 * and cache writes, and the API carries them as `costBreakdown`. This module is the single
 * place that names them, so a bar stack, a legend, a tooltip line and the summary strip all
 * list the same four in the same order.
 *
 * The colors follow the page's existing language: warm is text you pay for per token, cool is
 * the machine's own context traffic. Inside each pair the parts are separated by hue, not by
 * lightness, because a four-wide stack makes lightness steps hard to tell apart. Every value
 * clears 3:1 against the surface it is drawn on in both palettes, which is the rule the rest
 * of the chart colors were picked by.
 */

import { formatCost } from "../api.js";

/**
 * Stacking order, biggest first: on a coding agent, completion tokens are the bulk of a
 * bill, prompt tokens next, and cache money is the small part.
 *
 * @type {{ key: string, label: string, color: string, swatch: string }[]}
 */
export const COST_PARTS = [
  { key: "output", label: "out", color: "var(--cost-output)", swatch: "swatch-cost-output" },
  { key: "input", label: "in", color: "var(--cost-input)", swatch: "swatch-cost-input" },
  { key: "cacheRead", label: "cache read", color: "var(--cost-cache-read)", swatch: "swatch-cost-cache-read" },
  { key: "cacheWrite", label: "cache write", color: "var(--cost-cache-write)", swatch: "swatch-cost-cache-write" },
];

/**
 * Micro-dollars as dollars, with the extra digits a small figure needs.
 * @param {number} [costMicros]
 * @returns {string} e.g. "$1.76", "$0.0042"
 */
const dollars = (costMicros) => {
  const micros = costMicros ?? 0;
  return formatCost(micros, micros > 0 && micros < 10000 ? 4 : 2);
};

/**
 * One window's spend as the four parts, each with its share of that window's own money.
 *
 * The summary cells draw a 100% stacked strip, so they need shares alongside the dollars.
 * Every window reports all four parts, zeros included, so an empty window draws the bare
 * track in the same place a busy one draws its segments and the four cells stay the same
 * shape.
 *
 * @param {{ costBreakdown?: Record<string, { costMicros?: number, costUsd?: string }> }} [point]
 * @returns {{ parts: { key: string, label: string, color: string, costMicros: number, costUsd: string, share: number }[], totalMicros: number, title: string, ariaLabel: string } | null}
 *   null when the point carries no breakdown, which is what a server older than payload v2 sends
 */
export const costSplit = (point) => {
  if (!point?.costBreakdown) return null;

  const totalMicros = COST_PARTS.reduce(
    (sum, part) => sum + (point.costBreakdown[part.key]?.costMicros ?? 0),
    0,
  );

  const parts = COST_PARTS.map(({ key, label, color }) => {
    const costMicros = point.costBreakdown[key]?.costMicros ?? 0;
    return {
      key,
      label,
      color,
      costMicros,
      costUsd: point.costBreakdown[key]?.costUsd ?? dollars(costMicros),
      share: totalMicros > 0 ? (costMicros / totalMicros) * 100 : 0,
    };
  });

  // A window that spent nothing has no shares to name; saying so reads better than a list
  // of four zeros.
  const paid = parts.filter((part) => part.costMicros > 0);

  return {
    parts,
    totalMicros,
    title: parts.map((part) => `${part.label} ${part.costMicros.toLocaleString("en-US")} micro-dollars`).join(" · "),
    ariaLabel: paid.length > 0 ? paid.map((part) => `${part.label} ${Math.round(part.share)}%`).join(", ") : "no spend",
  };
};

/**
 * One day's or one hour's spend, written out as the four parts it was billed in.
 *
 * Returns null when the point carries no breakdown, which is what a server older than
 * payload version 2 sends. Showing four zeros under a non-zero figure would read as "this
 * money cost nothing", so the line is left out instead.
 *
 * @param {{ costBreakdown?: Record<string, { costMicros: number, costUsd: string }> }} point
 * @returns {string | null} e.g. "out $1.76 · in $0.34 · cache read $0.01 · cache write $0.00"
 */
export const moneyBreakdown = (point) => {
  if (!point?.costBreakdown) return null;
  return COST_PARTS.map((part) => `${part.label} ${dollars(point.costBreakdown[part.key]?.costMicros)}`).join(" · ");
};

/**
 * One part of a point's breakdown, in dollars, for a chart's stacked bar.
 *
 * Recharts wants a number per series per row; micro-dollars are truncated to four decimals
 * of a dollar so a bar's height is the money, not a float artifact.
 *
 * @param {object} point A daily or hourly point
 * @param {string} key One of the `COST_PARTS` keys
 * @returns {number} Dollars, to four decimals
 */
export const partDollars = (point, key) => Number(((point.costBreakdown?.[key]?.costMicros ?? 0) / 1e6).toFixed(4));
