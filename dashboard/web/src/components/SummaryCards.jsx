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
 */

import { formatTokens } from "../api.js";
import { COST_PARTS } from "./costParts.js";

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
 * The window's spend in the four parts the provider billed it in.
 *
 * Always four parts, zeros included: a session on a locally hosted model is priced at zero,
 * and "out $0.00 · in $0.00 · cache read $0.00 · cache write $0.00" is the honest label for
 * that spend. Showing it only when money was spent would make free usage look identical to a
 * window with no data at all.
 *
 * @param {{ costBreakdown?: { input?: object, output?: object, cacheRead?: object, cacheWrite?: object } }} [window]
 * @returns {{ parts: { label: string, costUsd: string, color: string }[], title: string } | null}
 *   the four parts in bar order, each with the hue its bar segment uses, and a title carrying
 *   the same figures as exact micro-dollars; null when the response has no breakdown at all
 */
const costParts = (window) => {
  // A server older than contract version 2 has no split to report. Four $0.00 parts under a
  // non-zero total would read as "this money cost nothing", so the line is simply absent
  // until the server is updated.
  if (!window?.costBreakdown) return null;

  const parts = COST_PARTS.map(({ key, label, color }) => ({
    label,
    color,
    costUsd: window.costBreakdown[key]?.costUsd ?? "$0.00",
    costMicros: window.costBreakdown[key]?.costMicros ?? 0,
  }));

  return {
    parts,
    // Each part is rounded for display, so the four can add up to a cent away from the
    // window's total. The exact figures are one hover away.
    title: parts.map((part) => `${part.label} ${part.costMicros.toLocaleString("en-US")} micro-dollars`).join(" · "),
  };
};

/**
 * @param {{ label: string, costUsd: string, window: object }} props
 * @returns {JSX.Element}
 */
const SummaryCell = ({ label, costUsd, window }) => {
  const kinds = tokenKinds(window);
  const parts = costParts(window);
  return (
    <div className="summary-cell">
      <span className="eyebrow">{label}</span>
      <span className="value">{costUsd}</span>
      {parts ? (
        <span className="sub-cost numeral" title={parts.title}>
          {parts.parts.map((part, index) => (
            <span key={part.label} style={{ color: part.color }}>
              {index > 0 ? " · " : ""}
              {part.label} {part.costUsd}
            </span>
          ))}
        </span>
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
