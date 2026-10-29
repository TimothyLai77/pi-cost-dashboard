/**
 * Daily spend: the shared spend chart configured for a range of days.
 *
 * This is the panel's front page, and the only chart you can leave by. A bar click drills into
 * that day's 24 hours, hovering prefetches them, and the day range and zone are printed on the
 * legend so a screenshot says which clock its bars are on.
 *
 * Days with no spend are drawn as zero bars, not left out: most usage here runs on local models
 * with no catalog price, so a $0 day is real activity, and a chart that hides it reads as an
 * outage. The server supplies the zero-filled range.
 */

import { SpendChart } from "./SpendChart.jsx";

/**
 * @param {{
 *   points: { day: string, costMicros: number, totalTokens: number, sessions: number, events: number }[],
 *   range: { from: string, to: string, timeZone?: string, offsetLabel?: string },
 *   onSelectDay?: (day: string) => void,
 *   onHoverDay?: (day: string) => void,
 *   animateBars?: boolean,
 * }} props
 * @returns {JSX.Element}
 */
export const CostChart = ({ points, range, onSelectDay, onHoverDay, animateBars = false }) => (
  <SpendChart
    points={points}
    xKey="day"
    // 2026-10-28 becomes 10-28. The range printed on the legend carries the year, and 365
    // ticks each paying for it is width spent on information the chart already shows.
    tickFormatter={(value) => value.slice(5)}
    minTickGap={24}
    maxBarSize={14}
    labelFor={(point) => point.day}
    legendValue={
      <span className="numeral">
        {range?.from ?? "—"} → {range?.to ?? "—"}
      </span>
    }
    legendHint={range?.timeZone ? `${range.timeZone} ${range.offsetLabel}` : null}
    onSelectDay={onSelectDay}
    onHoverDay={onHoverDay}
    animateBars={animateBars}
  />
);
