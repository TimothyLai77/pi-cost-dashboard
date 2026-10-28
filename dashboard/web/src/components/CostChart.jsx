/**
 * Daily spend chart, with a token underlay.
 *
 * The underlay is the point of this panel. Usage volume and cost are decoupled on a
 * machine running local models: a day can move 150 million tokens and bill nothing. A
 * plain cost line would draw that as a flat zero and read as a gap in the data, so token
 * volume is drawn as a quiet area behind the cost bars. Cost is the loud layer, volume is
 * the context, and a day with real usage and no bill is legible as what it is.
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
 * Tooltip over one day: spend, volume, and how many sessions produced it.
 * @param {{ active?: boolean, payload?: any[] }} props
 * @returns {JSX.Element | null}
 */
const DayTooltip = ({ active, payload }) => {
  if (!active || payload?.length !== 1) return null;
  const point = payload[0].payload;
  return (
    <div className="state" style={{ border: "1px solid var(--rule-strong)", background: "var(--paper-raised)" }}>
      <span className="eyebrow">{point.day}</span>
      <div className="numeral">{formatCost(point.costMicros, point.costMicros > 0 && point.costMicros < 10000 ? 4 : 2)}</div>
      <div className="numeral" style={{ color: "var(--ink-faint)" }}>
        {formatTokens(point.totalTokens)} tokens · {point.sessions} session{point.sessions === 1 ? "" : "s"}
      </div>
    </div>
  );
};

/**
 * @param {{ points: { day: string, costMicros: number, totalTokens: number, sessions: number }[], range: object }} props
 * @returns {JSX.Element}
 */
export const CostChart = ({ points, range }) => {
  const busiestDay = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);
  const zeroCostDays = points.filter((point) => point.costMicros === 0 && point.totalTokens > 0).length;

  return (
    <>
      <div className="chart-legend">
        <span>
          <span className="swatch swatch-money" />
          Spend
        </span>
        <span>
          <span className="swatch swatch-volume" />
          Token volume
        </span>
        <span className="numeral">
          {range?.from ?? "—"} → {range?.to ?? "—"}
        </span>
      </div>

      <div style={{ height: "20rem", padding: "0 var(--space-2)" }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 12, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="day"
              stroke="var(--rule-strong)"
              tick={{ fill: "var(--ink-faint)", fontSize: 11, fontFamily: "var(--font-numeral)" }}
              tickFormatter={(value) => value.slice(5)}
              interval="preserveStartEnd"
              minTickGap={24}
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
            <YAxis yAxisId="volume" hide domain={[0, busiestDay || 1]} />
            <Tooltip content={<DayTooltip />} cursor={{ fill: "var(--paper)" }}>
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
            <Bar
              yAxisId="cost"
              dataKey={(point) => Number((point.costMicros / 1e6).toFixed(4))}
              name="costUsd"
              fill={MONEY}
              maxBarSize={14}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="chart-note">
        {zeroCostDays > 0 ? (
          <>
            <span className="numeral">{zeroCostDays}</span> day{zeroCostDays === 1 ? "" : "s"} in this range used
            the agent with no charge — the models have no price in the catalog, so the grey band is the activity.
            Days with no band at all are days with no sessions.
          </>
        ) : (
          <>Every day in this range billed something. The grey band shows token volume for scale.</>
        )}
      </p>
    </>
  );
};
