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
 * printed under the total, and the strip footer spells out what the number means.
 */

import { formatTokens } from "../api.js";

/**
 * The four token kinds behind a window's total, as a compact second line.
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} window
 * @returns {string} e.g. "cache read 113M · in 494k · out 480k"
 */
const tokenKinds = (window) =>
  [
    `cache read ${formatTokens(window?.cacheReadTokens ?? 0)}`,
    `in ${formatTokens(window?.inputTokens ?? 0)}`,
    `out ${formatTokens(window?.outputTokens ?? 0)}`,
    ...(window?.cacheWriteTokens > 0 ? [`cache write ${formatTokens(window.cacheWriteTokens)}`] : []),
  ].join(" · ");

/**
 * @param {{ label: string, costUsd: string, window: object, sessions: number }} props
 * @returns {JSX.Element}
 */
const SummaryCell = ({ label, costUsd, window }) => {
  const kinds = tokenKinds(window);
  return (
    <div className="summary-cell">
      <span className="eyebrow">{label}</span>
      <span className="value">{costUsd}</span>
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
      <p className="summary-note">
        Tokens are input + output + cache reads + cache writes. Cache reads are counted again
        on every model call, so a long session's token total is throughput, not its size.
      </p>
    </section>
  );
};
