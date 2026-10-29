/**
 * Hourly spend for one day: the shared spend chart configured for 24 hour slots.
 *
 * The drill-down under the daily chart, reached by clicking a day bar. Same two-layer reading
 * as its parent panel — cost bars on the left axis, token volume as a quiet band behind them —
 * and the same four hues in the same order, so an hour that burned money on output looks
 * different from an hour that was mostly prompt re-reads.
 *
 * All 24 hours are drawn, empty ones as zeros. A sparse day that shows only the hours with
 * spend reads as a claim that nothing happened in the gaps, and the whole point of this view is
 * saying which hours were idle. The server supplies the zero-filled 24.
 *
 * Bars are inert here: there is nothing below an hour. The day they belong to is on the legend,
 * and the panel header carries a way back.
 */

import { SpendChart } from "./SpendChart.jsx";

/**
 * @param {{
 *   points: { hour: string, label: string, costMicros: number, costUsd: string, totalTokens: number, sessions: number }[],
 *   day: string,
 *   timeZone?: string,
 *   offsetLabel?: string,
 *   animateBars?: boolean,
 * }} props
 * @returns {JSX.Element}
 */
export const HourChart = ({ points, day, timeZone = "UTC", offsetLabel = "UTC", animateBars = false }) => (
  <SpendChart
    points={points}
    xKey="label"
    // 24 slots in the width a 30-day range gets: narrower bars and a tighter tick gap than
    // the daily chart uses, or the hour labels collide.
    minTickGap={20}
    maxBarSize={10}
    // A lone "14:00" has no date on it, and the tooltip outlives the panel header it came
    // from. The day comes from this component's prop: `/api/hourly` carries `day` once at the
    // top level, not on each of the 24 points, so a point has no date to name itself with.
    labelFor={(point) => `${day} · ${point.label}`}
    legendValue={<span className="numeral">{day}</span>}
    legendHint={`${timeZone} ${offsetLabel}`}
    animateBars={animateBars}
  />
);
