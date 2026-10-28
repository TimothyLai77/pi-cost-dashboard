/** localStorage key holding the subagent-spend choice. @type {string} */
const SUBAGENTS_STORAGE_KEY = "pi-cost-subagents";

/**
 * Dashboard root: owns the filter state the chart, model list, and session table share.
 *
 * Range is expressed as a day count so the chart can ask for a window; "all" sends no
 * bounds and the server returns the full recorded history.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useApi } from "./api.js";
import { PREFERENCES, useTheme } from "./theme.js";
import { CostChart } from "./components/CostChart.jsx";
import { HourChart } from "./components/HourChart.jsx";
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

/** What each theme setting does, in the words shown on the control. @type {Record<string, string>} */
const THEME_LABELS = { auto: "Auto", light: "Light", dark: "Dark" };

/** Why each theme setting exists, as the hover and accessibility description. */
const THEME_HINTS = {
  auto: "Follow the operating system's light or dark appearance, and keep following it",
  light: "Always use the light ledger palette",
  dark: "Always use the dark slate palette",
};

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
    <div className="panel-body">{children}</div>
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
  // Pi bills a subagent as its own session and again inside its parent's toolResult usage.
  // Counting both is the honest total, so it is the default; you can drop the nested ones.
  const [includeSubagents, setIncludeSubagents] = useState(
    () => localStorage.getItem(SUBAGENTS_STORAGE_KEY) !== "off",
  );
  const setSubagents = (checked) => {
    setIncludeSubagents(checked);
    try {
      localStorage.setItem(SUBAGENTS_STORAGE_KEY, checked ? "on" : "off");
    } catch {
      // A blocked localStorage means the choice just does not persist. Not a reason to break the page.
    }
  };
  // The day whose hours are showing, set by clicking a bar. Null means the daily view.
  const [drillDay, setDrillDay] = useState(null);
  const theme = useTheme();

  const range = RANGES[rangeIndex];
  // Sent as 1/0 on every aggregate so the whole page answers the same question.
  const subagents = includeSubagents ? 1 : 0;

  // The zone the server buckets in comes from the server (PI_COST_TZ), so there is no
  // per-viewer control: the page reads the zone off the API and labels itself with it.
  const config = useApi("/api/config", { _k: refreshKey });

  const summary = useApi("/api/summary", { days: range.days ?? 7, subagents, _k: refreshKey });
  const filters = useApi("/api/filters", { _k: refreshKey });
  const models = useApi("/api/models", { subagents, _k: refreshKey });

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
    subagents,
    _k: refreshKey,
  });

  const sessions = useApi("/api/sessions", {
    limit: 15,
    offset: page * 15,
    cwd: project,
    subagents,
    _k: refreshKey,
  });

  // Null path means the hook fetches nothing, so the hourly request costs nothing while
  // the daily view is up.
  const hourly = useApi(drillDay ? "/api/hourly" : null, {
    day: drillDay ?? "",
    cwd: project,
    provider,
    subagents,
    _k: refreshKey,
  });

  const health = useApi("/api/health", { _k: refreshKey });

  const reloadAll = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  // Wall clock of the newest successful summary fetch, shown in the footer so a refresh is
  // something you can read rather than a page that visibly jumps.
  const [updatedAt, setUpdatedAt] = useState(null);
  useEffect(() => {
    if (summary.data) setUpdatedAt(new Date());
  }, [summary.data]);

  // A running session pushes a provisional snapshot, and the server rescans every 60s.
  // Refreshing on the same cadence means you do not have to press anything to watch a
  // session's cost climb.
  useEffect(() => {
    const timer = setInterval(reloadAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reloadAll]);

  // An error with data behind it is a failed refresh, not a broken page: keep the numbers,
  // say the update failed, and let the next tick try again.
  const staleError = [summary, chart, models, sessions, filters].find(
    (request) => request.error && request.data,
  );
  const firstError = [summary, chart, models, sessions].find(
    (request) => request.error && !request.data,
  );
  const refreshing = [summary, chart, models, sessions, filters].some((request) => request.refreshing);
  const loading = [summary, chart, models, sessions].some((request) => request.loading);

  const changeRange = (index) => {
    setRangeIndex(index);
    setPage(0);
    // The drill-down is a day inside the current window, so a new window drops out of it.
    setDrillDay(null);
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
          {loading && <p className="eyebrow">Loading…</p>}
          {!loading && health.data && (
            <p className="eyebrow">
              {health.data.sessionCount} sessions · {health.data.usageEventCount} usage records
              {health.data.lastScanAt
                ? ` · last scan ${health.data.lastScanAt.replace("T", " ").replace("Z", " UTC")}`
                : " · fed by session reports, nothing scanned from disk"}
              {" · "}
              rows marked live are self-reported by a session active in the last 15 minutes
              {config.data
                ? ` · days and hours are ${config.data.timezone} (${config.data.offsetLabel})`
                : ""}
            </p>
          )}
        </div>
        <span className="spacer" />
        <span className="controls">
          {/* Refresh status is a fixed-size dot, never a swap of the sentence above it. Two
              lines of status text becoming one line of "Updating…" shortened the masthead by
              a line, and every panel below jumped up and back down on each refresh. */}
          <span
            className="refresh-dot"
            data-active={refreshing ? "true" : "false"}
            role="status"
            aria-label={refreshing ? "Updating" : "Up to date"}
            title={refreshing ? "Updating…" : updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ""}
          >
            <span className="sr-only">{refreshing ? "Updating" : "Up to date"}</span>
          </span>
          <span className="theme-set" role="group" aria-label="Color theme">
            {PREFERENCES.map((option) => (
              <button
                key={option}
                type="button"
                title={THEME_HINTS[option]}
                aria-pressed={theme.preference === option}
                onClick={() => theme.choose(option)}
              >
                {THEME_LABELS[option]}
              </button>
            ))}
          </span>
          <label
            title="A subagent is billed as its own session and again inside its parent's tool-result usage. Counting both is the full spend; turning this off shows only what each session paid directly."
          >
            <input
              type="checkbox"
              checked={includeSubagents}
              onChange={(event) => setSubagents(event.target.checked)}
            />
            Subagent spend
          </label>
          <button type="button" className="ghost" onClick={reloadAll}>
            Refresh
          </button>
        </span>
      </header>

      {staleError && (
        <p className="eyebrow update-failed" role="status">
          Last update failed · showing data from {updatedAt ? updatedAt.toLocaleTimeString() : "earlier"} ·{" "}
          {staleError.error}
        </p>
      )}

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
            title={drillDay ? `Spend by hour · ${drillDay}` : "Daily spend"}
            actions={
              <div className="controls">
                {drillDay ? (
                  <button type="button" className="ghost" onClick={() => setDrillDay(null)}>
                    ← Daily view
                  </button>
                ) : (
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
                )}
                <label>
                  {drillDay ? "Day" : "Hours for"}
                  <select
                    // A select, not only the clickable bar: chart bars cannot be tabbed to.
                    value={drillDay ?? ""}
                    onChange={(event) => setDrillDay(event.target.value || null)}
                  >
                    <option value="">{drillDay ? "Choose a day" : "All days (daily view)"}</option>
                    {(chart.data?.points ?? [])
                      .map((point) => point.day)
                      .reverse()
                      .slice(0, 30)
                      .map((day) => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    {drillDay && !chart.data?.points?.some((point) => point.day === drillDay) && (
                      <option value={drillDay}>{drillDay}</option>
                    )}
                  </select>
                </label>
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
            {!drillDay && chart.loading && <div className="state">Loading chart…</div>}
            {!drillDay && !chart.loading && chart.data?.points?.length > 0 && (
              <CostChart points={chart.data.points} range={chart.data.range} onSelectDay={setDrillDay} />
            )}
            {!drillDay && !chart.loading && chart.data?.points?.length === 0 && (
              <div className="state">
                No sessions match these filters in this range. Widen the range, or choose
                “All projects”.
              </div>
            )}

            {drillDay && hourly.loading && <div className="state">Loading hours…</div>}
            {drillDay && !hourly.loading && hourly.error && (
              <div className="state state-error">{hourly.error}</div>
            )}
            {drillDay && !hourly.loading && hourly.data && (
              <HourChart
                points={hourly.data.points}
                day={hourly.data.day}
                timeZone={hourly.data.range?.timeZone}
                offsetLabel={hourly.data.range?.offsetLabel}
              />
            )}
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

          <Panel title="Spend by model">
            {models.loading && <div className="state">Loading models…</div>}
            {!models.loading && (models.data?.length ?? 0) === 0 && (
              <div className="state">No usage recorded yet. Run the backfill to load past sessions.</div>
            )}
            {!models.loading && (models.data?.length ?? 0) > 0 && <ModelBreakdown models={models.data} />}
          </Panel>

          <footer className="footer">
            <span>
              {updatedAt
                ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "Not updated yet"}{" · "}
              refreshes every {Math.round(REFRESH_INTERVAL_MS / 1000)}s
            </span>
            <span>
              Running sessions self-report; the rest is read from session files. A row marked{" "}
              <span className="live-tag">live</span> is a session still writing its file.
            </span>
          </footer>
        </>
      )}
    </main>
  );
};
