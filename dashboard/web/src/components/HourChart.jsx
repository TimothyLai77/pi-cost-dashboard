/**
 * Hourly spend for one day, the drill-down under the daily chart.
 *
 * Same two-layer reading as the daily chart: cost bars on the left axis, token volume as a
 * quiet area behind them. All 24 hours are drawn, including the empty ones, because the
 * idle hours are the answer to "when was this machine actually burning money".
 *
 * Like the daily chart, it prints no caption: the 24 hour labels, the bars, and the volume
 * band carry the reading, and the zone is in the legend next to the day.
 *
 * Each hour's bar is stacked in the four parts the provider billed it in, in the same colors
 * and order as the daily chart, so an hour that burned money on output looks different from
 * an hour that was mostly prompt re-reads.
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

import { formatTokens, formatCostSmart } from "../api.js";
import { COST_PARTS, moneyBreakdown, partDollars } from "./costParts.js";

const VOLUME = "var(--volume)";

/**
 * Tooltip over one hour: spend, what the spend was made of, volume, and who billed in it.
 * @param {{ active?: boolean, payload?: any[] }} props
 * @returns {JSX.Element | null}
 */
const HourTooltip = ({ active, payload }) => {
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
      <span className="eyebrow">
        {point.day} · {point.label}
      </span>
      <div className="numeral">{formatCostSmart(point.costMicros)}</div>
      {money ? <div className="numeral tooltip-money">{money}</div> : null}
      <div className="numeral" style={{ color: "var(--ink-faint)" }}>
        {formatTokens(point.totalTokens)} tokens · {point.sessions} session{point.sessions === 1 ? "" : "s"} ·{" "}
        {point.events} call{point.events === 1 ? "" : "s"}
      </div>
      <div className="numeral tooltip-breakdown">
        cache read {formatTokens(point.cacheReadTokens ?? 0)} · output{" "}
        {formatTokens(point.outputTokens ?? 0)} · input {formatTokens(point.inputTokens ?? 0)} · cache write{" "}
        {formatTokens(point.cacheWriteTokens ?? 0)}
      </div>
    </div>
  );
};

/**
 * @param {{ points: { hour: string, label: string, costMicros: number, costUsd: string, totalTokens: number, sessions: number }[], day: string, timeZone?: string, offsetLabel?: string, animateBars?: boolean }} props
 * @returns {JSX.Element}
 */
export const HourChart = ({ points, day, timeZone = "UTC", offsetLabel = "UTC", animateBars = false }) => {
  const busiestHour = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);
  const zone = `${timeZone} ${offsetLabel}`;

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
        <span className="numeral">{day}</span>
        <span className="legend-hint">{zone}</span>
      </div>

      <div style={{ height: "20rem" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 12, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="var(--rule-strong)"
              tick={{ fill: "var(--ink-faint)", fontSize: 11, fontFamily: "var(--font-numeral)" }}
              interval="preserveStartEnd"
              minTickGap={20}
            />
            <YAxis
              yAxisId="cost"
              stroke="var(--rule-strong)"
              tick={{ fill: "var(--ink-faint)", fontSize: 11, fontFamily: "var(--font-numeral)" }}
              tickFormatter={(value) => `$${value}`}
              width={48}
            />
            <YAxis yAxisId="volume" hide domain={[0, busiestHour || 1]} />
            <Tooltip content={<HourTooltip />} cursor={{ fill: "var(--paper)" }} />
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
                stroke="var(--paper-raised)"
                strokeWidth={1}
                maxBarSize={10}
                isAnimationActive={animateBars}
                animationDuration={350}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
};
