/**
 * Unit tests for the flow diagram's geometry and tooltip content.
 *
 * The diagram is the one panel where a small arithmetic mistake draws something that is not
 * in the data: a band attached to a missing node index lands on node 0, a band with no
 * money in it takes width it has not earned, and a tooltip that reads a node's totals as
 * bill parts prints four numbers that were never billed that way.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bandValue, flowTooltipLines, nodeColor, toIndexedLinks, PROJECT_NODE, ROLLUP_NODE } from "../src/components/flowGraph.js";

/** The shape `/api/flows` returns, at the smallest size that exercises both sides. */
const flows = {
  metric: "cost",
  nodes: [
    { id: "model:anthropic/claude-sonnet-4-5", kind: "model", label: "claude-sonnet-4-5", rolledUp: false },
    { id: "model:all other", kind: "model", label: "all other", rolledUp: true },
    { id: "project:/home/user/git/spool-tracker", kind: "project", label: "spool-tracker", rolledUp: false },
    { id: "project:all other", kind: "project", label: "all other", rolledUp: true },
  ],
  links: [
    {
      source: "model:anthropic/claude-sonnet-4-5",
      target: "project:/home/user/git/spool-tracker",
      costMicros: 1_000_000,
      totalTokens: 4000,
      sessions: 2,
      events: 9,
      costBreakdown: {
        input: { costUsd: "$0.10" },
        output: { costUsd: "$0.60" },
        cacheRead: { costUsd: "$0.30" },
        cacheWrite: { costUsd: "$0.00" },
      },
    },
    {
      source: "model:all other",
      target: "project:all other",
      costMicros: 250,
      totalTokens: 12_000_000,
      sessions: 11,
      events: 400,
      costBreakdown: {
        input: { costUsd: "$0.00" },
        output: { costUsd: "$0.00" },
        cacheRead: { costUsd: "$0.25" },
        cacheWrite: { costUsd: "$0.00" },
      },
    },
    {
      // A band that carries tokens but no money: no width in the money view, a wide one in
      // the token view.
      source: "model:all other",
      target: "project:/home/user/git/spool-tracker",
      costMicros: 0,
      totalTokens: 7_000_000,
      sessions: 3,
      events: 120,
      costBreakdown: {
        input: { costUsd: "$0.00" },
        output: { costUsd: "$0.00" },
        cacheRead: { costUsd: "$0.00" },
        cacheWrite: { costUsd: "$0.00" },
      },
    },
  ],
};

test("the metric chooses the unit the band is measured in", () => {
  assert.equal(bandValue("cost", flows.links[1]), 250);
  assert.equal(bandValue("tokens", flows.links[1]), 12_000_000);
  assert.equal(bandValue("cost", flows.links[0]), 1_000_000, "no metric means money");
});

test("a band with none of the chosen metric is not drawn, and the same band is in the token view", () => {
  const money = toIndexedLinks(flows);
  assert.deepEqual(
    money.links.map((link) => link.value),
    [1_000_000, 250],
    "the $0.00 flow has no width",
  );

  const tokens = toIndexedLinks({ ...flows, metric: "tokens" });
  assert.deepEqual(
    tokens.links.map((link) => link.value),
    [4000, 12_000_000, 7_000_000],
    "the same flow is a wide band when tokens are the metric, and the order the server sent is kept",
  );
});

test("links attach to node indexes, and a link with an endpoint off the picture is dropped", () => {
  const { links } = toIndexedLinks(flows);
  assert.deepEqual(
    links.map((link) => [link.source, link.target]),
    [
      [0, 2],
      [1, 3],
    ],
  );

  const dangling = toIndexedLinks({
    ...flows,
    links: [{ source: "model:not-in-the-picture", target: "project:/home/user/git/spool-tracker", costMicros: 5000, totalTokens: 10 }],
  });
  assert.deepEqual(dangling.links, [], "a missing endpoint would have landed the band on node 0");
});

test("color names the model, and a tally node never wears a model's hue", () => {
  assert.equal(nodeColor({ kind: "model", rolledUp: false }, 0), "var(--flow-1)");
  assert.equal(nodeColor({ kind: "model", rolledUp: false }, 2), "var(--flow-3)");
  assert.equal(nodeColor({ kind: "model", rolledUp: false }, 9), "var(--flow-3)", "the ramp wraps");
  assert.equal(nodeColor({ kind: "model", rolledUp: true }, 0), ROLLUP_NODE);
  assert.equal(nodeColor({ kind: "project", rolledUp: false }, -1), PROJECT_NODE);
  assert.equal(nodeColor({ kind: "project", rolledUp: true }, -1), ROLLUP_NODE);
  assert.equal(nodeColor({ kind: "model", rolledUp: false }, -1), "var(--flow-1)", "an unknown rank draws the first hue, not a negative index");
});

test("a band's tooltip names both ends, the money, and what the money was billed in", () => {
  // In the drawing, Recharts hands the tooltip a link whose ends are the node objects, which
  // is where the short labels come from.
  const drawn = {
    ...flows.links[0],
    source: flows.nodes[0],
    target: flows.nodes[2],
  };
  const lines = flowTooltipLines(drawn);

  assert.equal(lines.title, "claude-sonnet-4-5 → spool-tracker");
  assert.equal(lines.money, "$1.00");
  assert.equal(lines.parts, "out $0.60 · in $0.10 · cache read $0.30 · cache write $0.00");
  assert.equal(lines.context, "4.0k tokens · 2 sessions · 9 calls");
  assert.equal(lines.sub, null);

  // The raw payload, before the drawing resolves the ends, still says which two things it
  // joins rather than printing nothing.
  assert.equal(flowTooltipLines(flows.links[0]).title, "model:anthropic/claude-sonnet-4-5 → project:/home/user/git/spool-tracker");
});

test("a node's tooltip counts calls, not sessions, and names no bill parts", () => {
  const node = {
    kind: "model",
    label: "claude-sonnet-4-5",
    sublabel: "anthropic",
    costMicros: 119250,
    totalTokens: 151425,
    events: 9,
  };
  const lines = flowTooltipLines(node);

  assert.equal(lines.title, "Model · claude-sonnet-4-5");
  assert.equal(lines.money, "$0.12", "119,250 micro-dollars is twelve cents");
  assert.equal(lines.parts, null, "a node sums flows from many bills; the server splits no node totals into parts");
  assert.equal(lines.context, "151k tokens · 9 calls");
  assert.equal(lines.sub, "anthropic");

  assert.equal(flowTooltipLines({ kind: "project", label: "all other", costMicros: 0, totalTokens: 0, events: 1 }).title, "Project · all other");
});
