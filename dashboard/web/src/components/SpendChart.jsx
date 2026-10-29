/**
 * The spend chart both time views draw: cost bars stacked in the four parts the provider
 * billed them in, with token volume as a quiet band behind them.
 *
 * The daily and hourly panels are the same drawing, so they share this component and pass
 * only what differs: which field names the x axis, how its ticks are labeled, how wide a bar
 * may get, what the legend's right end says, what the tooltip calls one period, and whether
 * a bar can be clicked. Everything else — the legend swatches, the two y scales, the volume
 * area, the four stacked bars, the tooltip's money and token lines — exists once, here.
 *
 * The two layers are the point of the panel. Usage volume and cost are decoupled on a machine
 * running local models: a day can move 150 million tokens and bill nothing. A plain cost line
 * would draw that as a flat zero and read as a gap in the data, so volume goes behind the bars
 * as context and cost stays the loud layer. A day with real usage and no bill is then legible
 * as what it is.
 *
 * The four hues, not a lightness ramp: burnt orange for completion tokens, mustard gold for
 * prompt tokens, blue for cache reads, teal for cache writes. Warm is text you pay for per
 * token, cool is the machine's own context traffic. The bars carry hairline gaps in the panel's
 * own colour, so the stack reads as ledger bands rather than a blended gradient.
 *
 * Nothing here prints a caption under the chart. What the token figures include is stated in
 * the legend, which is where a reader looks before parsing a paragraph under the axis.
 */

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCostSmart, formatTokens } from "../api.js";
import { COST_PARTS, moneyBreakdown, partDollars } from "./costParts.js";

const VOLUME = "var(--volume)";

/**
 * Tooltip over one period: spend, what the spend was made of, volume, and who produced it.
 *
 * @param {{ active?: boolean, payload?: any[], labelFor?: (point: object) => string }} props
 *   `labelFor` names the period — a day string for the daily chart, `2026-09-24 · 14:00` for
 *   the hourly one, where a lone hour label carries no date
 * @returns {JSX.Element | null}
 */
const SpendTooltip = ({ active, payload, labelFor }) => {
  // A stacked bar contributes one payload entry per part, so the guard is "is there a
  // datum", not "is there exactly one series".
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const money = moneyBreakdown(point);
  return (
    <div
      className="chart-tooltip"
      style={{ border: "1px solid var(--rule-strong)", background: "var(--paper-raised)" }}
    >
      <span className="eyebrow">{labelFor ? labelFor(point) : ""}</span>
      <div className="numeral">{formatCostSmart(point.costMicros)}</div>
      {money ? <div className="numeral tooltip-money">{money}</div> : null}
      <div className="numeral" style={{ color: "var(--ink-faint)" }}>
        {formatTokens(point.totalTokens)} tokens · {point.sessions} session{point.sessions === 1 ? "" : "s"} ·{" "}
        {point.events} call{point.events === 1 ? "" : "s"}
      </div>
      {/* Token totals are dominated by cache reads: a long session re-reads its cached
          context on every call, so "tokens" on a chart is throughput, not context size. */}
      <div className="numeral tooltip-breakdown">
        cache read {formatTokens(point.cacheReadTokens ?? 0)} · output{" "}
        {formatTokens(point.outputTokens ?? 0)} · input {formatTokens(point.inputTokens ?? 0)} · cache write{" "}
        {formatTokens(point.cacheWriteTokens ?? 0)}
      </div>
    </div>
  );
};

/**
 * @param {object} props
 * @param {{ day: string, label?: string, costMicros: number, costBreakdown: object,
 *   totalTokens: number, cacheReadTokens?: number, inputTokens?: number,
 *   outputTokens?: number, cacheWriteTokens?: number, sessions: number, events: number }[]} points
 *   One point per period, gaps already filled by the server
 * @param {string} [xKey] Field naming the x axis: `day` for days, `label` for `HH:00` strings
 * @param {(value: any) => string} [tickFormatter] Shortens axis ticks. The daily chart drops
 *   the year, which every tick would otherwise pay in width for no information.
 * @param {number} [minTickGap] Gap between axis ticks, so a 90-day range stays readable
 * @param {number} [maxBarSize] Ceiling in pixels. 24 hours need narrower bars than 30 days.
 * @param {(point: object) => string} [labelFor] What the tooltip calls one period
 * @param {React.ReactNode} [legendValue] The right end of the legend: a day, or a range
 * @param {React.ReactNode} [legendHint] The zone the buckets are drawn in, e.g. `America/Denver UTC-6`
 * @param {(day: string) => void} [onSelectDay] Present makes a bar clickable; absent leaves it inert
 * @param {(day: string) => void} [onHoverDay] Hovering starts that day's hourly request
 * @param {boolean} [animateBars] Bars animate only when the series is new to the panel
 * @returns {JSX.Element}
 */
export const SpendChart = ({
  points,
  xKey = "day",
  tickFormatter,
  minTickGap = 24,
  maxBarSize = 14,
  labelFor,
  legendValue = null,
  legendHint = null,
  onSelectDay,
  onHoverDay,
  animateBars = false,
}) => {
  const busiest = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);

  return (
    <>
      <div className="chart-legend">
        {COST_PARTS.map((part) => (
          <span key={part.key}>
            <span className={`swatch ${part.swatch}`} />
            {part.label}
          </span>
        ))}
        <span>
          <span className="swatch swatch-volume" />
          <span title="input + output + cache reads + cache writes. Cache reads are counted again on every model call, so this bar tracks model calls x context size, not spend.">
            Token volume · incl. cache reads
          </span>
        </span>
        {legendValue}
        {legendHint && <span className="legend-hint">{legendHint}</span>}
      </div>

      <div style={{ height: "20rem" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 12, right: 8, bottom: 4, left: 8 }}
            // Hovering a bar starts that day's hourly request. By the time the click lands the
            // answer is usually already in the cache, so the drill-down swaps with no wait.
            onMouseMove={
              onHoverDay
                ? (state) => {
                    const day = state?.activeLabel;
                    if (day) onHoverDay(day);
                  }
                : undefined
            }
          >
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey={xKey}
              stroke="var(--rule-strong)"
              tick={{ fill: "var(--ink-faint)", fontSize: 11, fontFamily: "var(--font-numeral)" }}
              tickFormatter={tickFormatter}
              interval="preserveStartEnd"
              minTickGap={minTickGap}
            />
            {/* Two scales, on purpose: cost is read on the left axis, volume fills the
                background and is only ever read from the tooltip. */}
            <YAxis
              yAxisId="cost"
              stroke="var(--rule-strong)"
              tick={{ fill: "var(--ink-faint)", fontSize: 11, fontFamily: "var(--font-numeral)" }}
              tickFormatter={(value) => `$${value}`}
              width={48}
            />
            <YAxis yAxisId="volume" hide domain={[0, busiest || 1]} />
            <Tooltip content={<SpendTooltip labelFor={labelFor} />} cursor={{ fill: "var(--paper)" }}>
            </Tooltip>
            <Area
              yAxisId="volume"
              dataKey="totalTokens"
              type="monotone"
              stroke="none"
              fill={VOLUME}
              fillOpacity={0.35}
              isAnimationActive={false}
            />
            {COST_PARTS.map((part) => (
              <Bar
                key={part.key}
                yAxisId="cost"
                stackId="cost"
                dataKey={(point) => partDollars(point, part.key)}
                name={part.key}
                fill={part.color}
                // Hairline gaps, in the panel's own colour: the stack reads as ledger bands,
                // which keeps segments legible without pushing their parts apart in hue.
                stroke="var(--paper-raised)"
                strokeWidth={1}
                maxBarSize={maxBarSize}
                isAnimationActive={animateBars}
                animationDuration={350}
                className={onSelectDay ? "bar-clickable" : undefined}
                onClick={
                  onSelectDay
                    ? (entry) => {
                        // Recharts hands back the datum it drew, which carries the day label.
                        const day = entry?.payload?.day ?? entry?.day;
                        if (day) onSelectDay(day);
                      }
                    : undefined
                }
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
};
