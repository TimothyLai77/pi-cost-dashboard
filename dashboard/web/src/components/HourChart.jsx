/**
 * Hourly spend for one day, the drill-down under the daily chart.
 *
 * Same two-layer reading as the daily chart: cost bars on the left axis, token volume as a
 * quiet area behind them. All 24 hours are drawn, including the empty ones, because the
 * idle hours are the answer to "when was this machine actually burning money".
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

import { formatCost, formatTokens } from "../api.js";

const MONEY = "var(--money)";
const VOLUME = "var(--volume)";

/**
 * Tooltip over one hour: spend, volume, and how many sessions billed in it.
 * @param {{ active?: boolean, payload?: any[] }} props
 * @returns {JSX.Element | null}
 */
const HourTooltip = ({ active, payload }) => {
  if (!active || payload?.length !== 1) return null;
  const point = payload[0].payload;
  return (
    <div className="state" style={{ border: "1px solid var(--rule-strong)", background: "var(--paper-raised)" }}>
      <span className="eyebrow">
        {point.day} · {point.label}
      </span>
      <div className="numeral">{formatCost(point.costMicros, point.costMicros > 0 && point.costMicros < 10000 ? 4 : 2)}</div>
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
 * @param {{ points: { hour: string, label: string, costMicros: number, costUsd: string, totalTokens: number, sessions: number }[], day: string, timeZone?: string, offsetLabel?: string }} props
 * @returns {JSX.Element}
 */
export const HourChart = ({ points, day, timeZone = "UTC", offsetLabel = "UTC" }) => {
  const busiestHour = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);
  const billedHours = points.filter((point) => point.costMicros > 0).length;
  const activeHours = points.filter((point) => point.totalTokens > 0).length;
  const zone = `${timeZone} ${offsetLabel}`;

  return (
    <>
      <div className="chart-legend">
        <span>
          <span className="swatch swatch-money" />
          Spend
        </span>
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
            <Bar
              yAxisId="cost"
              dataKey={(point) => Number((point.costMicros / 1e6).toFixed(4))}
              name="costUsd"
              fill={MONEY}
              maxBarSize={10}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="chart-note">
        <span className="numeral">{activeHours}</span> of 24 hours used the agent,{" "}
        <span className="numeral">{billedHours}</span> of them billed something. Hours are clock
        hours in <span className="numeral">{zone}</span>. Token counts are cumulative across
        model calls, not the size of the context.
      </p>
    </>
  );
};
