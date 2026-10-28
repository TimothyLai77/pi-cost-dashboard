/**
 * Dashboard root: owns the filter state the chart, model list, and session table share.
 *
 * Range is expressed as a day count so the chart can ask for a window; "all" sends no
 * bounds and the server returns the full recorded history.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useApi } from "./api.js";
import { CostChart } from "./components/CostChart.jsx";
import { ModelBreakdown } from "./components/ModelBreakdown.jsx";
import { SessionTable } from "./components/SessionTable.jsx";
import { SummaryCards } from "./components/SummaryCards.jsx";

const RANGES = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "all", days: null },
];

/** Seconds between automatic refreshes, so a running session's numbers move on their own. */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * @param {{ title: string, children: React.ReactNode, actions?: React.ReactNode }} props
 * @returns {JSX.Element}
 */
const Panel = ({ title, actions, children }) => (
  <section className="panel">
    <div className="panel-head">
      <h2>{title}</h2>
      <span className="spacer" />
      {actions}
    </div>
    {children}
  </section>
);

/**
 * @param {{ message: string, hint?: string }} props
 * @returns {JSX.Element}
 */
const ErrorState = ({ message, hint }) => (
  <div className="state-error state" role="alert">
    <h3>Could not load the dashboard</h3>
    <p>
      <code>{message}</code>
    </p>
    {hint && <p>{hint}</p>}
  </div>
);

export const App = () => {
  const [rangeIndex, setRangeIndex] = useState(1);
  const [project, setProject] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  // UTC is how the data is stored. Bucketing by local day is a display choice, so it
  // defaults off and is applied as an offset the server computes in SQL.
  const [localDays, setLocalDays] = useState(false);

  const range = RANGES[rangeIndex];
  const tzOffsetMinutes = localDays ? -new Date().getTimezoneOffset() : 0;

  const summary = useApi("/api/summary", { days: range.days ?? 7, _k: refreshKey });
  const filters = useApi("/api/filters", { _k: refreshKey });
  const models = useApi("/api/models", { _k: refreshKey });

  // "all" sends no bounds, so the server returns the full recorded history.
  const rangeParams = useMemo(() => {
    if (!range.days) return {};
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - (range.days - 1) * 86_400_000).toISOString().slice(0, 10);
    return { from, to };
  }, [range.days, refreshKey]);

  const chart = useApi("/api/daily", {
    ...rangeParams,
    cwd: project,
    provider,
    tzOffsetMinutes,
    _k: refreshKey,
  });

  const sessions = useApi("/api/sessions", {
    limit: 15,
    offset: page * 15,
    cwd: project,
    _k: refreshKey,
  });

  const health = useApi("/api/health", { _k: refreshKey });

  const reloadAll = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  // A running session pushes a provisional snapshot, and the server rescans every 60s.
  // Refreshing on the same cadence means you do not have to press anything to watch a
  // session's cost climb.
  useEffect(() => {
    const timer = setInterval(reloadAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reloadAll]);

  const firstError = [summary, chart, models, sessions].find((request) => request.error);
  const loading = [summary, chart, models, sessions].some((request) => request.loading);

  const changeRange = (index) => {
    setRangeIndex(index);
    setPage(0);
  };

  const changeProject = (value) => {
    setProject(value);
    setPage(0);
  };

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-copy">
          <h1>Pi session spend</h1>
          <p>What the agents cost, by day, project, and model.</p>
          {loading && <p className="eyebrow">Updating…</p>}
          {!loading && health.data?.lastScanAt && (
            <p className="eyebrow">
              {health.data.sessionCount} sessions · {health.data.usageEventCount} usage records ·
              scanned {health.data.lastScanAt.replace("T", " ").replace("Z", " UTC")} ·
              rows marked live came from the extension, not a scan
            </p>
          )}
        </div>
        <span className="spacer" />
        <span className="controls">
          <label title="Bucket days by your browser's timezone instead of UTC">
            <input type="checkbox" checked={localDays} onChange={(event) => setLocalDays(event.target.checked)} />
            Local days
          </label>
          <button type="button" className="ghost" onClick={reloadAll}>
            Refresh
          </button>
        </span>
      </header>

      {firstError && (
        <ErrorState
          message={firstError.error}
          hint="Start the server with `npm run dev:server` from the dashboard folder, then reload this page. If it runs on another port, set PI_COST_PROXY_TARGET in dashboard/.env."
        />
      )}

      {!firstError && (
        <>
          <SummaryCards summary={summary.data} loading={summary.loading} />

          <Panel
            title="Daily spend"
            actions={
              <div className="controls">
                <span className="range-set" role="group" aria-label="Date range">
                  {RANGES.map((option, index) => (
                    <button
                      type="button"
                      key={option.label}
                      aria-pressed={index === rangeIndex}
                      onClick={() => changeRange(index)}
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
                <label>
                  Project
                  <select value={project} onChange={(event) => changeProject(event.target.value)}>
                    <option value="">All projects</option>
                    {(filters.data?.projects ?? []).map((cwd) => (
                      <option key={cwd} value={cwd}>
                        {cwd}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Provider
                  <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                    <option value="">All providers</option>
                    {(filters.data?.providers ?? []).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            }
          >
            {chart.loading && <div className="state">Loading chart…</div>}
            {!chart.loading && chart.data?.points?.length > 0 && (
              <CostChart points={chart.data.points} range={chart.data.range} />
            )}
            {!chart.loading && chart.data?.points?.length === 0 && (
              <div className="state">
                No sessions match these filters in this range. Widen the range, or choose
                “All projects”.
              </div>
            )}
          </Panel>

          <div className="grid-two">
            <Panel title="Spend by model">
              {models.loading && <div className="state">Loading models…</div>}
              {!models.loading && (models.data?.length ?? 0) === 0 && (
                <div className="state">No usage recorded yet. Run the backfill to load past sessions.</div>
              )}
              {!models.loading && (models.data?.length ?? 0) > 0 && <ModelBreakdown models={models.data} />}
            </Panel>

            <Panel
              title="Sessions"
              actions={
                <span className="eyebrow">
                  {sessions.data
                    ? `${sessions.data.total} shown of ${sessions.data.totalMatches} sessions · newest activity first`
                    : "newest activity first"}
                </span>
              }
            >
              {sessions.loading && <div className="state">Loading sessions…</div>}
              {!sessions.loading && (
                <SessionTable
                  result={sessions.data}
                  onPrev={() => setPage((current) => Math.max(0, current - 1))}
                  onNext={() => setPage((current) => current + 1)}
                />
              )}
            </Panel>
          </div>
        </>
      )}
    </main>
  );
};
