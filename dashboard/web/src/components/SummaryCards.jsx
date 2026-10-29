/**
 * Summary strip: spend for today, 7 days, 30 days, and all time.
 *
 * Tokens are shown next to every figure. Most usage on this machine runs on local models
 * priced at zero, so a day that shows only $0.00 is real activity, not an outage, and the
 * token count is what proves it.
 *
 * The token figure is input + output + cache reads + cache writes, and cache reads are the
 * overwhelming majority of it: every model call re-reports the cached prefix it read, so a
 * busy day reads as hundreds of millions of tokens and a few dollars. The breakdown is
 * printed under the total, and the money line under it says which of those four things the
 * dollars actually went to.
 *
 * Under each total is a 100% stacked strip of the money: four segments in the same hues the
 * chart bars use, each one that part's share of that cell's spend. Every cell is the full
 * width, so the four cells compare the shape of a bill, and the dollar figure above the strip
 * carries the size. A cell that spent nothing shows the bare track.
 */

import { formatTokens, tokenKinds } from "../api.js";
import { costSplit } from "./costParts.js";

/**
 * One window of the strip: label, total, the money split as a bar and as dollars, tokens.
 *
 * The bar is 100% of this cell's own spend, so the four cells compare the shape of a bill
 * (today was all output, the month paid for cache reads) and not its size — the size is the
 * dollar figure above it. Segments only exist for parts that cost something; a window that
 * spent nothing shows the bare track.
 *
 * @param {{ label: string, costUsd: string, window: object }} props
 * @returns {JSX.Element}
 */
const SummaryCell = ({ label, costUsd, window }) => {
  const kinds = tokenKinds(window);
  const split = costSplit(window);
  return (
    <div className="summary-cell">
      <span className="eyebrow">{label}</span>
      <span className="value">{costUsd}</span>
      {split ? (
        <>
          <span
            className="cost-strip"
            role="img"
            aria-label={`Money split: ${split.ariaLabel}`}
            title={split.title}
          >
            {split.parts
              .filter((part) => part.costMicros > 0)
              .map((part) => (
                <span key={part.key} style={{ flexGrow: part.costMicros, backgroundColor: part.color }} />
              ))}
          </span>
          <span className="sub-cost numeral">
            {split.parts.map((part, index) => (
              <span key={part.key} style={{ color: part.color }}>
                {index > 0 ? " · " : ""}
                {part.label} {part.costUsd}
              </span>
            ))}
          </span>
        </>
      ) : null}
      <span
        className="sub numeral"
        title={`${kinds} · ${window?.sessions ?? 0} session(s), ${window?.events ?? 0} model call(s)`}
      >
        {formatTokens(window?.totalTokens ?? 0)} tokens · {window?.sessions ?? 0}{" "}
        session{window?.sessions === 1 ? "" : "s"}
      </span>
      <span className="sub-kinds numeral">{kinds}</span>
    </div>
  );
};

/**
 * @param {{ summary: object | null, loading: boolean }} props
 * @returns {JSX.Element}
 */
export const SummaryCards = ({ summary, loading }) => {
  const windows = [
    { label: "Today", key: "today" },
    { label: "Last 7 days", key: "last7Days" },
    { label: "Last 30 days", key: "last30Days" },
    { label: "All time", key: "allTime" },
  ];

  return (
    <section className="summary" aria-label="Spend summary">
      <div className="summary-grid">
        {windows.map(({ label, key }) => {
          const window = summary?.[key];
          return (
            <SummaryCell
              key={key}
              label={label}
              costUsd={loading ? "…" : (window?.costUsd ?? "$0.00")}
              window={window}
            />
          );
        })}
      </div>
    </section>
  );
};
