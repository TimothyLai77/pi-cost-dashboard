/**
 * Daily spend chart, with a token underlay.
 *
 * The underlay is the point of this panel. Usage volume and cost are decoupled on a
 * machine running local models: a day can move 150 million tokens and bill nothing. A
 * plain cost line would draw that as a flat zero and read as a gap in the data, so token
 * volume is drawn as a quiet area behind the cost bars. Cost is the loud layer, volume is
 * the context, and a day with real usage and no bill is legible as what it is.
 *
 * The chart prints no caption under itself. What the token figures include is stated in the
 * summary strip footer and in the legend, which is where a reader looks before parsing a
 * paragraph under the axis.
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
 * @param {{ points: { day: string, costMicros: number, totalTokens: number, sessions: number }[], range: object, onSelectDay?: (day: string) => void }} props
 * @returns {JSX.Element}
 */
export const CostChart = ({ points, range, onSelectDay }) => {
  const busiestDay = points.reduce((max, point) => Math.max(max, point.totalTokens), 0);

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
        <span className="numeral">
          {range?.from ?? "—"} → {range?.to ?? "—"}
        </span>
        {range?.timeZone && (
          <span className="legend-hint">
            {range.timeZone} {range.offsetLabel}
          </span>
        )}
        {onSelectDay && <span className="legend-hint">click a bar for its hours</span>}
      </div>

      <div style={{ height: "20rem" }}>
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
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  );
};
