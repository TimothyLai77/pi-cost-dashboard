/**
 * Summary strip: spend for today, 7 days, 30 days, and all time.
 *
 * Tokens are shown next to every figure. Most usage on this machine runs on local models
 * priced at zero, so a day that shows only $0.00 is real activity, not an outage, and the
 * token count is what proves it.
 */

import { formatTokens } from "../api.js";

/**
 * @param {{ label: string, costUsd: string, totalTokens: number, sessions: number }} props
 * @returns {JSX.Element}
 */
const SummaryCell = ({ label, costUsd, totalTokens, sessions }) => (
  <div className="summary-cell">
    <span className="eyebrow">{label}</span>
    <span className="value">{costUsd}</span>
    <span className="sub numeral">
      {formatTokens(totalTokens)} tokens · {sessions} session{sessions === 1 ? "" : "s"}
    </span>
  </div>
);

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
      {windows.map(({ label, key }) => {
        const window = summary?.[key];
        return (
          <SummaryCell
            key={key}
            label={label}
            costUsd={loading ? "…" : (window?.costUsd ?? "$0.00")}
            totalTokens={window?.totalTokens ?? 0}
            sessions={window?.sessions ?? 0}
          />
        );
      })}
    </section>
  );
};
