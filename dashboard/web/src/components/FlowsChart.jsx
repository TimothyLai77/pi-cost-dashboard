/**
 * Where the money flowed: models on the left, projects on the right, bands sized by spend.
 *
 * The ledger panels answer "what did this model cost" and "what did this project cost".
 * Neither answers the question between them: which model's money landed in which project.
 * This panel answers that, so a project billed by three models shows the three bands, and a
 * model that worked in five projects shows five.
 *
 * Bands are colored by the model they come from, not by the part of the bill they were
 * charged in — the hues come from `flowGraph.js` and are a separate ramp from the four cost
 * hues, so a band here cannot be misread as a "cache read" segment in the chart above it.
 * Project nodes are neutral on purpose: color is the model's identity, position is the
 * project's.
 *
 * The metric is the caller's choice. Money is the default. Tokens exists because it tells a
 * different story on a machine running local models: the busiest model by tokens here moved
 * 746M of them for $0.00, so the money view does not draw it at all and the token view is
 * the only place it appears.
 *
 * The node/link geometry and the tooltip's lines come from `flowGraph.js`, which is where
 * those two are tested.
 */

import { ResponsiveContainer, Sankey, Tooltip } from "recharts";

import { flowTooltipLines, nodeColor, toIndexedLinks } from "./flowGraph.js";

/**
 * Tooltip over one band or one node.
 * @param {{ active?: boolean, payload?: any[] }} props
 * @returns {JSX.Element | null}
 */
const FlowTooltip = ({ active, payload }) => {
  const entry = payload?.[0]?.payload;
  if (!active || !entry) return null;
  const lines = flowTooltipLines(entry);

  return (
    <div
      className="chart-tooltip"
      style={{ border: "1px solid var(--rule-strong)", background: "var(--paper-raised)" }}
    >
      <span className="eyebrow">{lines.title}</span>
      <div className="numeral">{lines.money}</div>
      {lines.parts ? <div className="numeral tooltip-money">{lines.parts}</div> : null}
      <div className="numeral" style={{ color: "var(--ink-faint)" }}>
        {lines.context}
      </div>
      {lines.sub ? <div className="numeral tooltip-breakdown">{lines.sub}</div> : null}
    </div>
  );
};

/**
 * A node, with its name and its own total on the outside of the diagram.
 *
 * One line, not two: seven nodes per side at this height leaves about 26px between node
 * centres, and a two-line label printed on top of its neighbour's. The provider, the full
 * path, and the token count are in the tooltip.
 *
 * Labels lie over the bands they belong to, so each is stroked in the panel's own color and
 * painted over that stroke: the text punches a quiet patch out of whatever it crosses
 * instead of fighting the band underneath it.
 *
 * @param {{ x: number, y: number, width: number, height: number, payload: object, modelRank: number }} props
 * @returns {JSX.Element}
 */
const FlowNode = ({ x, y, width, height, payload, modelRank }) => {
  const onLeft = payload.kind === "model";

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={nodeColor(payload, modelRank)} rx={1} />
      <text
        x={onLeft ? x + width + 8 : x - 8}
        y={y + height / 2 + 4}
        textAnchor={onLeft ? "start" : "end"}
        fill="var(--ink)"
        fontSize={11}
        fontFamily="var(--font-body)"
        stroke="var(--paper-raised)"
        strokeWidth={4}
        paintOrder="stroke"
      >
        {payload.label}
        <tspan fill="var(--ink-soft)" fontFamily="var(--font-numeral)">
          {` ${payload.costUsd}`}
        </tspan>
      </text>
    </g>
  );
};

/**
 * A band: the usual S-curve, filled with the color of the model it leaves from.
 * @param {{ sourceX: number, sourceY: number, targetX: number, targetY: number, sourceControlX: number, targetControlX: number, linkWidth: number, payload: object, modelRank: number }} props
 * @returns {JSX.Element}
 */
const FlowBand = ({ sourceX, sourceY, targetX, targetY, sourceControlX, targetControlX, linkWidth, payload, modelRank }) => {
  const color = nodeColor({ kind: "model", rolledUp: payload.source.rolledUp ?? false }, modelRank);

  return (
    <path
      d={[
        `M${sourceX},${sourceY - linkWidth / 2}`,
        `C${sourceControlX},${sourceY - linkWidth / 2} ${sourceControlX},${targetY - linkWidth / 2} ${targetX},${targetY - linkWidth / 2}`,
        `L${targetX},${targetY + linkWidth / 2}`,
        `C${sourceControlX},${targetY + linkWidth / 2} ${sourceControlX},${sourceY + linkWidth / 2} ${sourceX},${sourceY + linkWidth / 2}`,
      ].join(" ")}
      fill={color}
      fillOpacity={0.42}
      stroke={color}
      strokeOpacity={0.18}
    />
  );
};

/**
 * @param {{ flows: object }} props The `/api/flows` payload, whose own `metric` field says
 *   which unit the bands are sized in
 * @returns {JSX.Element}
 */
export const FlowsChart = ({ flows }) => {
  const data = toIndexedLinks(flows);
  const modelOrder = flows.nodes.filter((node) => node.kind === "model").map((node) => node.id);
  const rankOf = (id) => modelOrder.indexOf(id);

  if (data.links.length === 0) {
    // A window with no money in it is a fact about this machine, not a broken chart: local
    // models do the work and bill nothing. Say what is here instead of drawing rules.
    return (
      <div className="state">
        {flows.totals.totalTokens > 0
          ? `${flows.totals.costUsd} billed across ${flows.totals.totalTokens.toLocaleString("en-US")} tokens on ${flows.totals.models} model${flows.totals.models === 1 ? "" : "s"} — this work ran on models priced at zero, so there is nothing to draw.`
          : "No model calls in this window."}
      </div>
    );
  }

  const drawnModels = flows.nodes.filter((node) => node.kind === "model" && !node.rolledUp).length;
  const drawnProjects = flows.nodes.filter((node) => node.kind === "project" && !node.rolledUp).length;

  return (
    <>
      <div className="chart-legend">
        <span>
          <span title="Each band is one model's money arriving in one project. The color names the model and the width is the money. Bands are not the four cost parts — those are the stacked bars in the panels above.">
            {flows.metric === "tokens" ? "Tokens from model to project" : "Money from model to project"}
          </span>
        </span>
        <span className="numeral">
          {drawnModels} models → {drawnProjects} projects · {data.links.length} band
          {data.links.length === 1 ? "" : "s"}
        </span>
        {flows.dropped.rolled.models > 0 || flows.dropped.rolled.projects > 0 ? (
          <span className="legend-hint">
            {flows.dropped.rolled.models} model{flows.dropped.rolled.models === 1 ? "" : "s"} and{" "}
            {flows.dropped.rolled.projects} project{flows.dropped.rolled.projects === 1 ? "" : "s"} folded into
            all other
          </span>
        ) : null}
        {flows.dropped.flows > 0 ? (
          <span className="legend-hint">
            {flows.dropped.flows} band{flows.dropped.flows === 1 ? "" : "s"} priced at zero left out
          </span>
        ) : null}
      </div>

      <div style={{ height: "22rem" }}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            node={(props) => <FlowNode {...props} modelRank={rankOf(props.payload.id)} />}
            link={(props) => <FlowBand {...props} modelRank={rankOf(props.payload.source.id)} />}
            nodeWidth={8}
            // Two lines of label sit beside each node, and they need about 26px of vertical
            // room; at the default 10 the tail nodes' labels printed on top of each other.
            nodePadding={26}
            margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
            title="Money from models to projects"
          >
            <Tooltip content={<FlowTooltip />} />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </>
  );
};
