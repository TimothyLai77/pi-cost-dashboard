/**
 * Dashboard root: the app shell, its two pages, and the filter state the ledger's panels share.
 *
 * The route comes from the browser's history (see router.js): `/` is the ledger, `/lifetime` is
 * the lifetime board. Both are the same Express origin, so switching pages is a `pushState` and
 * a re-render, and a deep link to `/lifetime` is answered by the server's own catch-all.
 *
 * Both pages render inside `AppShell`: a rail on the left holding the page switcher and the
 * theme control, and the page itself in the column beside it. The rail is sticky, so the control
 * is on screen while the ledger scrolls; below the phone breakpoint it comes back on screen as a
 * drawer opened from a menu button.
 *
 * Range is expressed as a day count so the chart can ask for a window; "all" sends no
 * bounds and the server returns the full recorded history.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useApi } from "./api.js";
import { useHourlyDrill } from "./hourly.js";
import { useTheme } from "./theme.js";
import { useRoute } from "./router.js";
import { AppRail } from "./components/AppRail.jsx";
import { CostChart } from "./components/CostChart.jsx";
import { FlowsChart } from "./components/FlowsChart.jsx";
import { HourChart } from "./components/HourChart.jsx";
import { ModelBreakdown } from "./components/ModelBreakdown.jsx";
import { PageNav } from "./components/PageNav.jsx";
import { SessionTable } from "./components/SessionTable.jsx";
import { SummaryCards } from "./components/SummaryCards.jsx";
import { ThemeControls } from "./components/ThemeControls.jsx";
import { LifetimePage } from "./pages/LifetimePage.jsx";

const RANGES = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "all", days: null },
];

/** Seconds between automatic refreshes, so a running session's numbers move on their own. */
const REFRESH_INTERVAL_MS = 30_000;

/** At this viewport width (1440px) the rail expands by default. */
const RAIL_EXPANDED_QUERY = "(min-width: 90rem)";

/** Below this viewport width (640px) the page is the phone layout. */
const PHONE_QUERY = "(max-width: 40rem)";

/**
 * A CSS media query as a piece of React state.
 *
 * `matchMedia` is the only way to know which layout the viewport is asking for, and a resize
 * listener on every consumer is the same work with more bookkeeping. `useSyncExternalStore` is
 * the harness's own pattern for an external value: React resubscribes on its own schedule, and
 * the server snapshot (`false`) keeps the first render consistent.
 * @param {string} query e.g. "(min-width: 90rem)"
 * @returns {boolean} whether the viewport matches now
 */
const useMediaQuery = (query) => {
  const subscribe = useCallback(
    (onStoreChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => media.removeEventListener("change", onStoreChange);
    },
    [query],
  );
  const snapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
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

/**
 * The ledger page: summary strip, daily chart with the hour drill-down, sessions, flows,
 * models. `theme` and the phone-only masthead controls come from `AppShell`, which owns them so
 * there is one theme state in the app rather than one per page.
 * @param {{
 *   navigate: (path: string) => void,
 *   theme: { preference: string, choose: (preference: string) => void },
 *   compactNav: boolean,
 * }} props
 * @returns {JSX.Element}
 */
const LedgerPage = ({ navigate, theme, compactNav }) => {
  const [rangeIndex, setRangeIndex] = useState(1);
  const [project, setProject] = useState("");
  const [provider, setProvider] = useState("");
  const [page, setPage] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  // The day whose hours are showing, set by clicking a bar. Null means the daily view.
  const [drillDay, setDrillDay] = useState(null);
  const range = RANGES[rangeIndex];

  const summary = useApi("/api/summary", { days: range.days ?? 7, _k: refreshKey });
  const filters = useApi("/api/filters", { _k: refreshKey });
  const models = useApi("/api/models", { _k: refreshKey });

  // Which unit the flow bands are sized in. Money is the page's subject; tokens is the view
  // where the models priced at zero appear at all.
  const [flowMetric, setFlowMetric] = useState("cost");

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
    _k: refreshKey,
  });

  // The flow diagram answers the question the ledger panels cannot: which model's money
  // landed in which project. It reads the same range, project, and provider filters.
  const flows = useApi("/api/flows", {
    metric: flowMetric,
    ...rangeParams,
    cwd: project,
    provider,
    _k: refreshKey,
  });

  const sessions = useApi("/api/sessions", {
    limit: 15,
    offset: page * 15,
    cwd: project,
    _k: refreshKey,
  });

  // Hourly data for the drilled day, with prefetch so a click is usually served from the
  // cache. The daily chart stays on screen while an uncached day arrives, so nothing has to
  // leave the panel to make room for a loading line.
  const hourly = useHourlyDrill(drillDay, {
    cwd: project,
    provider,
    _k: refreshKey,
  });

  // Warm the most recent days as soon as the daily series is known. They are the days a
  // reader is most likely to click, and the cache is rebuilt with the filters, so this is
  // a handful of indexed queries per refresh, not a growing backlog.
  useEffect(() => {
    const points = chart.data?.points ?? [];
    if (points.length === 0) return;
    hourly.prefetchMany(points.slice(-5).map((point) => point.day));
  }, [chart.data, hourly.prefetchMany]);

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

  // Which chart sits on top of the stack. It follows the data actually on screen, not the
  // clicked day: while a new day is on its way, the daily chart stays where it is with the
  // loading pill over it, and a stale day's bars are never shown under the other day's title.
  const showHours = Boolean(hourly.data) && hourly.data.day === drillDay;
  const view = showHours ? "hour" : "day";
  const waitingForHours = Boolean(drillDay) && !showHours && (hourly.loading || hourly.refreshing);

  // Bars animate when a series is new to the panel and stay still when the 30s refresh
  // returns the same series with newer numbers. Re-animating on every refresh is the kind of
  // flashing this panel is meant to get rid of.
  const dailySeriesKey = `${range.days}|${project}|${provider}`;
  const lastDailyKey = useRef(null);
  const dailyAnimate = lastDailyKey.current !== dailySeriesKey;
  useEffect(() => {
    lastDailyKey.current = dailySeriesKey;
  }, [dailySeriesKey]);

  const lastHourDay = useRef(null);
  const hourlyAnimate = Boolean(hourly.data) && lastHourDay.current !== hourly.data.day;
  useEffect(() => {
    if (hourly.data) lastHourDay.current = hourly.data.day;
  }, [hourly.data]);

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
          {compactNav && <PageNav path="/" navigate={navigate} />}
          {compactNav && <ThemeControls theme={theme} />}
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
            {/* One frame, both charts stacked in the same grid cell. The chart that is not on
                top stays mounted and fades, so the panel keeps one height: the height change
                was the flash. */}
            <div className="chart-stack" data-view={view}>
              {chart.data?.points?.length > 0 && (
                <div className="chart-layer" data-layer="day" aria-hidden={view !== "day"}>
                  <CostChart
                    points={chart.data.points}
                    range={chart.data.range}
                    onSelectDay={setDrillDay}
                    onHoverDay={hourly.prefetch}
                    animateBars={dailyAnimate}
                  />
                </div>
              )}

              {hourly.data && (
                <div className="chart-layer" data-layer="hour" aria-hidden={view !== "hour"}>
                  <HourChart
                    points={hourly.data.points}
                    day={hourly.data.day}
                    timeZone={hourly.data.range?.timeZone}
                    offsetLabel={hourly.data.range?.offsetLabel}
                    animateBars={hourlyAnimate}
                  />
                </div>
              )}

              {!drillDay && chart.loading && (
                <div className="chart-layer" data-layer="state">
                  <div className="state">Loading chart…</div>
                </div>
              )}

              {!chart.loading && chart.data?.points?.length === 0 && (
                <div className="chart-layer" data-layer="state">
                  <div className="state">
                    No sessions match these filters in this range. Widen the range, or choose
                    “All projects”.
                  </div>
                </div>
              )}

              {drillDay && hourly.error && (
                <div className="chart-layer" data-layer="state">
                  <div className="state state-error">{hourly.error}</div>
                </div>
              )}

              {/* The pill sits over the chart already on screen; it replaces nothing. */}
              {waitingForHours && (
                <span className="chart-loading-pill" role="status">
                  <span className="refresh-dot" data-active="true" aria-hidden="true" />
                  hours…
                </span>
              )}
            </div>
          </Panel>

          <Panel
            title="Sessions"
            actions={
              <span className="eyebrow">
                {sessions.data
                  ? `${sessions.data.total} session${sessions.data.total === 1 ? "" : "s"} match · newest activity first`
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

          <Panel
            title="Money from model to project"
            actions={
              <span className="range-set" role="group" aria-label="Band unit">
                {[
                  ["cost", "Money"],
                  ["tokens", "Tokens"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={flowMetric === value}
                    onClick={() => setFlowMetric(value)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            }
          >
            {flows.loading && <div className="state">Loading flows…</div>}
            {!flows.loading && flows.error && <div className="state state-error">{flows.error}</div>}
            {!flows.loading && !flows.error && flows.data && <FlowsChart flows={flows.data} />}
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
          </footer>
        </>
      )}
    </main>
  );
};

/**
 * The app shell: the rail, the theme state, the phone layout flag, and the page the route selects.
 *
 * `theme` is owned here because the rail carries the control, and both pages take it as a prop.
 * One owner means one localStorage write per change and no second copy of the setting going
 * stale in a page that is not on screen.
 *
 * The rail's width follows the viewport (expanded from 90rem / 1440px), and a click pins the
 * reader's choice until the window crosses that breakpoint again - dragging the window narrow
 * collapses the rail without asking.
 * @returns {JSX.Element}
 */
const AppShell = () => {
  const { path, navigate } = useRoute();
  const theme = useTheme();
  const wideViewport = useMediaQuery(RAIL_EXPANDED_QUERY);
  const isPhone = useMediaQuery(PHONE_QUERY);
  // `null` means "follow the viewport"; a click on the rail's control pins the opposite.
  const [pinnedCollapse, setPinnedCollapse] = useState(null);
  const collapsed = pinnedCollapse ?? !wideViewport;

  useEffect(() => setPinnedCollapse(null), [wideViewport]);

  const page =
    path === "/lifetime" ? (
      <LifetimePage navigate={navigate} theme={theme} compactNav={isPhone} />
    ) : (
      <LedgerPage navigate={navigate} theme={theme} compactNav={isPhone} />
    );

  return (
    <div className="shell">
      <AppRail
        path={path}
        navigate={navigate}
        theme={theme}
        collapsed={collapsed}
        onToggleCollapse={() => setPinnedCollapse(!collapsed)}
        isPhone={isPhone}
      />
      <div className="shell-body">{page}</div>
    </div>
  );
};

/**
 * The app: one route in, one page out, inside the shell.
 * @returns {JSX.Element}
 */
export const App = () => <AppShell />;
