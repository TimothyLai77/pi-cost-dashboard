/**
 * The lifetime page: the whole ledger as totals, streaks, records, and level.
 *
 * The ledger page answers "what did this week cost". This page answers the other question —
 * "what has this added up to" — and is built to be looked at after a backfill, not watched
 * while a session runs: everything is all-time, there are no project, provider, or range
 * filters, and the numbers only move when a session settles or a scan lands.
 *
 * One request (`/api/lifetime`) carries every fact on the page. The drawings over those
 * facts — streaks, level, square darkness, the fun comparisons — come from `lifetime.js`,
 * which is pure and tested, so the page itself is only layout.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { formatCostSmart, formatTokens, shortProject, tokenKinds } from "../api.js";
import {
  buildHeatmap,
  comparisons,
  computeStreaks,
  groupNumber,
  HEATMAP_WEEKS,
  HEATMAP_WEEKS_NARROW,
  hourLabel,
  peakOf,
  pickQuip,
  QUIPS,
  QUIP_ROTATION_MS,
  QUIP_TYPE_MS,
  quipSeedFor,
  weekTotals,
  xpFromTotals,
  levelFromXp,
  XP_PER_TOKEN,
} from "../lifetime.js";
import { useApi } from "../api.js";
import { useTheme } from "../theme.js";
import { PageNav } from "../components/PageNav.jsx";
import { moneyBreakdown } from "../components/costParts.js";
import { ThemeControls } from "../components/ThemeControls.jsx";

/**
 * Seconds between refreshes. Longer than the ledger's: these are all-time totals, and the
 * page's own note says a session has to settle before they move.
 */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * A CSS media query, as a live value.
 *
 * Two drawings on this page depend on a stylesheet breakpoint, and CSS cannot hand a value to
 * JavaScript: the activity grid has to pick a window before it draws, and the commentary strip has
 * to know whether it is allowed to move at all. Subscribing to the same query the stylesheet uses
 * keeps them flipping at the same moment the layout does.
 *
 * @param {string} query A CSS media query, e.g. `(max-width: 40rem)`
 * @returns {boolean} true while the query matches
 */
const useMediaQuery = (query) => {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
};

/** The stylesheet's narrow-layout breakpoint, shared by the CSS and the grid's week count. */
const NARROW_LAYOUT_QUERY = "(max-width: 40rem)";

/** The OS setting that says no unnecessary animation, honoured by the commentary strip. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The phone-width layout, as a live value.
 *
 * The activity grid has to pick a window before it draws, and the window depends on the width
 * the strip will get: 26 weeks is 361px of squares, a phone card is 312px. The same 40rem the
 * stylesheet uses for its narrow layout is the trigger, so the page and the CSS flip together.
 *
 * @returns {boolean} true while the viewport is at the phone-width layout
 */
const useNarrowViewport = () => useMediaQuery(NARROW_LAYOUT_QUERY);

/**
 * Today's calendar day in the browser's own zone, as `YYYY-MM-DD`.
 *
 * `toLocaleDateString("en-CA")` is the ISO-shaped locale: it yields `2026-10-29` and is not
 * translated, which is what a `YYYY-MM-DD` comparison needs. The day series is drawn in the
 * server's zone, so on a dashboard reading another machine's zone today can be off by one;
 * streak counting treats that as the grace day it already is.
 *
 * @returns {string} `YYYY-MM-DD`
 */
const localToday = () => new Date().toLocaleDateString("en-CA");

/**
 * Format a span of seconds the way a session length reads.
 * @param {number} seconds
 * @returns {string} e.g. "42m", "3h 12m", "2d 4h"
 */
const formatSpan = (seconds) => {
  const total = Math.max(0, Math.trunc(Number(seconds) || 0));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

/**
 * A headline figure with a label and context under it.
 *
 * `note` is the one line of context every cell has. `foot` is a second line, used by the hero
 * cell, whose card stretches to the height of the level card next to it and needs the extra line
 * to read as a filled box rather than a label floating above an empty one.
 *
 * @param {{ label: string, value: string, note?: string, foot?: string, tone?: "money" | "volume", title?: string }} props
 * @returns {JSX.Element}
 */
const StatCell = ({ label, value, note, foot, tone = "volume", title }) => (
  <div className="stat-cell" data-tone={tone} title={title}>
    <span className="eyebrow">{label}</span>
    <span className="value">{value}</span>
    {note && <span className="sub numeral">{note}</span>}
    {foot && <span className="stat-cell__foot numeral">{foot}</span>}
  </div>
);

/**
 * Panel wrapper, same shape as the ledger's, local here so the two pages stay independent.
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
 * The commentary strip under the level bar: one line at a time from `QUIPS`.
 *
 * Four things this has to get right, because a rotating line of text is the kind of decoration
 * that ruins a page:
 *
 * - It walks the list from a start point picked by the day, so a day opens on the same line, and
 *   it never repeats a line back to back (`pickQuip`).
 * - The timer is JavaScript, so CSS cannot stop it: hovering or focusing the line clears the
 *   interval, which is the keyboard-visible way to stop reading it mid-joke.
 * - `prefers-reduced-motion` means no timer at all, so the line is chosen and stays put.
 * - The box is two lines tall whatever the line says, so the panels under the card do not jump
 *   every nine seconds, and a line over the budget (`QUIP_MAX_CHARS`) clamps with an ellipsis.
 * - The line types itself out, one character at a time, and the caret keeps blinking after it.
 *   Hovering finishes the line in one go: stopping the animation should mean "let me read this",
 *   not "freeze it mid-word", and moving the pointer away resumes from where it stopped rather
 *   than restarting the line. A pure-CSS typewriter is not on the table - the line wraps to two
 *   lines, and a `steps()` width animation can only reveal one.
 *
 * `aria-live="off"` because the text is commentary: a live region that changes every nine seconds
 * is a screen reader reading the page out loud forever.
 *
 * @param {{ seed: number }} props `seed` is the day's offset into the list, from `quipSeedFor`
 * @returns {JSX.Element | null} the strip, or nothing when there are no lines to show
 */
const QuipStrip = ({ seed }) => {
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [rotation, setRotation] = useState(0);
  const [paused, setPaused] = useState(false);
  const [typedCount, setTypedCount] = useState(0);

  const index = pickQuip(QUIPS, seed, rotation);
  const text = index === null ? "" : QUIPS[index];

  useEffect(() => {
    if (reducedMotion || paused || QUIPS.length < 2) return undefined;
    const timer = setInterval(() => setRotation((step) => step + 1), QUIP_ROTATION_MS);
    return () => clearInterval(timer);
  }, [reducedMotion, paused]);

  // A new line starts empty; the same line keeps whatever it had already revealed.
  useEffect(() => {
    setTypedCount(0);
  }, [text]);

  useEffect(() => {
    if (text.length === 0) return undefined;
    if (reducedMotion || paused) {
      setTypedCount(text.length);
      return undefined;
    }
    if (typedCount >= text.length) return undefined;
    const timer = setInterval(() => setTypedCount((count) => Math.min(count + 1, text.length)), QUIP_TYPE_MS);
    return () => clearInterval(timer);
  }, [text, typedCount, reducedMotion, paused]);

  if (index === null) return null;

  return (
    <span
      className="quip"
      role="note"
      aria-live="off"
      tabIndex={0}
      title={text}
      data-typing={typedCount < text.length ? "true" : "false"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {text.slice(0, typedCount)}
    </span>
  );
};

/**
 * Level banner: the level, its rank, and the bar toward the next one.
 *
 * The gap is also translated into tokens, because XP is mostly tokens: "3,361 XP to go" is
 * abstract, "≈3.4M tokens" is one short session on a local model.
 *
 * @param {{
 *   level: { level: number, rank: string, percent: number, xpToNext: number, xp: number },
 *   quipSeed: number,
 * }} props
 * @returns {JSX.Element}
 */
const LevelBanner = ({ level, quipSeed }) => {
  const tokensToNext = Math.round(level.xpToNext / XP_PER_TOKEN);
  const ariaLabel = `Level ${level.level}, ${level.rank}, ${level.percent}% of the way to level ${
    level.level + 1
  }`;

  return (
    <div className="level-card">
      <div className="level-head">
        <span className="eyebrow">Level {level.level}</span>
        <span className="level-rank">{level.rank}</span>
      </div>
      <span
        className="level-bar"
        role="img"
        aria-label={ariaLabel}
        title={`${level.percent}% of the way to level ${level.level + 1}`}
      >
        <span className="level-bar-fill" style={{ width: `${level.percent}%` }} />
      </span>
      <span className="level-note numeral">
        {level.percent}% to level {level.level + 1} · {groupNumber(level.xpToNext)} XP to go
        {tokensToNext > 0 ? ` · about ${formatTokens(tokensToNext)} more tokens` : ""}
      </span>
      <span className="level-legend eyebrow">
        1 XP per 1k tokens · 1 XP per $0.10 · {groupNumber(level.xp)} XP banked
      </span>
      <QuipStrip seed={quipSeed} />
    </div>
  );
};

/**
 * Streak panel: the run that is standing, the best run on record, and this week so far.
 * @param {{
 *   streaks: object,
 *   week: object | null,
 *   calendarDays: number,
 * }} props
 * @returns {JSX.Element}
 */
const StreakPanel = ({ streaks, week, calendarDays }) => (
  <div className="streak-grid">
    <StatCell
      label="Current streak"
      value={`${streaks.current}`}
      tone={streaks.current > 0 ? "live" : "volume"}
      note={
        streaks.current > 0
          ? `days · ${streaks.currentStartDay} → ${streaks.currentEndsDay}`
          : "days · not running"
      }
      title="Consecutive days that recorded tokens. Today counts as soon as a session settles."
    />
    <StatCell
      label="Longest streak"
      value={`${streaks.longest}`}
      note={streaks.longestFrom ? `days · ${streaks.longestFrom} → ${streaks.longestTo}` : "days"}
    />
    <StatCell
      label="Active days"
      value={`${streaks.activeDays}`}
      note={`of ${calendarDays} days on record`}
      title="Days that recorded at least one token. A day of zero-priced local-model work counts."
    />
    <StatCell
      label="This week"
      value={`${week?.activeDays ?? 0}`}
      note={`${formatTokens(week?.totalTokens ?? 0)} tokens · ${formatCostSmart(week?.costMicros ?? 0)}`}
      title={`Sunday ${week?.startDay ?? ""} through today`}
    />
    <p className="streak-nudge" role="status">
      {streaks.nudge}
    </p>
  </div>
);

/**
 * The record board: one cell per "best day / best call / best run" the ledger holds.
 * @param {{ stats: object }} props Payload from `/api/lifetime`
 * @returns {JSX.Element}
 */
const RecordBoard = ({ stats }) => {
  const records = stats.records ?? {};
  const peakHour = peakOf(stats.hoursOfDay ?? [], "totalTokens");
  const peakWeekday = peakOf(stats.weekdays ?? [], "totalTokens");
  const activeDays = stats.totals?.activeDays ?? 0;
  const perActiveDay =
    activeDays > 0
      ? {
          cost: Math.round((stats.totals?.costMicros ?? 0) / activeDays),
          tokens: Math.round((stats.totals?.totalTokens ?? 0) / activeDays),
        }
      : null;

  const cells = [
    {
      label: "Most expensive day",
      value: records.mostExpensiveDay?.costUsd ?? "—",
      note: records.mostExpensiveDay?.day,
      tone: "money",
      title: `${formatTokens(records.mostExpensiveDay?.totalTokens ?? 0)} tokens on that day`,
    },
    {
      label: "Biggest token day",
      value: `${formatTokens(records.busiestTokenDay?.totalTokens ?? 0)}`,
      note: `${records.busiestTokenDay?.day ?? ""} · ${records.busiestTokenDay?.costUsd ?? ""}`,
      title: "The day the models moved the most tokens, paid or free",
    },
    {
      label: "Most sessions in a day",
      value: `${records.mostSessionsDay?.sessions ?? 0}`,
      note: records.mostSessionsDay?.day,
    },
    {
      label: "Priciest single call",
      value: records.biggestCall?.costUsd ?? "—",
      note: `${records.biggestCall?.modelId ?? ""} · ${records.biggestCall?.occurredAt?.slice(0, 10) ?? ""}`,
      tone: "money",
      title: `A ${records.biggestCall?.kind ?? ""} entry, billed in one shot`,
    },
    {
      label: "Priciest session",
      value: records.biggestSession?.costUsd ?? "—",
      note: shortProject(records.biggestSession?.cwd),
      tone: "money",
      title: `${formatTokens(records.biggestSession?.totalTokens ?? 0)} tokens · ${
        records.biggestSession?.toolCalls ?? 0
      } tool calls`,
    },
    {
      label: "Longest session",
      value: formatSpan(records.longestSession?.spanSeconds),
      note: shortProject(records.longestSession?.cwd),
      title: "First entry to last activity. Includes the hours the terminal sat open.",
    },
    {
      label: "Peak hour",
      value: peakHour ? hourLabel(peakHour.hour) : "—",
      note: peakHour ? `${formatTokens(peakHour.totalTokens)} tokens all time` : "",
      title: "The hour of the day this machine burns the most tokens in",
    },
    {
      label: "Peak day of week",
      value: peakWeekday?.name ?? "—",
      note: peakWeekday ? `${formatTokens(peakWeekday.totalTokens)} tokens on ${peakWeekday.days} days` : "",
    },
    {
      label: "Top project by cost",
      value: records.topProjectByCost?.costUsd ?? "—",
      note: shortProject(records.topProjectByCost?.cwd),
      tone: "money",
      title: records.topProjectByCost?.cwd,
    },
    {
      label: "Busiest model",
      value: `${formatTokens(records.topModelByTokens?.totalTokens ?? 0)}`,
      note: records.topModelByTokens?.modelId ?? "",
      title: `${records.topModelByTokens?.provider ?? ""} · ${records.topModelByCost?.costUsd ?? ""} of the money went elsewhere`,
    },
    {
      label: "Per active day",
      value: perActiveDay ? formatCostSmart(perActiveDay.cost) : "—",
      note: perActiveDay ? `${formatTokens(perActiveDay.tokens)} tokens a day` : "",
      title: "All-time totals divided by the days that recorded tokens",
    },
    {
      label: "On record since",
      value: stats.range?.from ?? "—",
      note: `${stats.totals?.calendarDays ?? 0} days · ${stats.counts?.projects ?? 0} projects · ${
        stats.counts?.models ?? 0
      } models`,
    },
  ];

  return (
    <div className="record-grid">
      {cells.map((cell) => (
        <StatCell key={cell.label} {...cell} />
      ))}
    </div>
  );
};

/**
 * The activity grid: week columns, Sunday at the top, one square per day.
 *
 * The window is 26 weeks on a desktop and 13 on the phone layout, picked so the squares fit the
 * card they are drawn in rather than scrolling inside it.
 *
 * The squares are sized in tokens by default because most usage here is priced at zero, so a
 * money-sized grid has holes in the days that did the most work. The toggle is the same
 * Money / Tokens control the flow panel uses.
 *
 * The square shows one number and the tooltip shows the other: sized in tokens, it says
 * "40.0M tokens · $0.62 · 24 sessions", because the whole point of the toggle is that the two
 * units tell different stories about the same day.
 *
 * @param {{
 *   grid: object,
 *   metric: string,
 *   onMetric: (metric: string) => void,
 *   dayIndex: Map<string, object>,
 * }} props
 * @returns {JSX.Element}
 */
const ActivityGrid = ({ grid, metric, onMetric, dayIndex }) => {
  const monthLabel = (dayString) =>
    new Date(`${dayString}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

  const months = grid.columns.map((column, index) => {
    const name = monthLabel(column.weekStart);
    const previous = index > 0 ? monthLabel(grid.columns[index - 1].weekStart) : null;
    return name === previous ? "" : name;
  });

  return (
    <div
    className="heatmap"
    data-metric={metric}
    role="img"
    /* The month ticks are positioned as a share of the strip, so they need the column count. */
    style={{ "--weeks": grid.columns.length }}
    aria-label={`${grid.activeDays} active days in the last ${grid.columns.length} weeks, squares sized in ${
      metric === "cost" ? "money" : "tokens"
    }`}
  >
      <div className="heatmap-body">
        <span className="heatmap-weeks eyebrow" aria-hidden="true">
          {["S", "M", "T", "W", "T", "F", "S"].map((letter, index) => (
            <span key={index}>{letter}</span>
          ))}
        </span>
        <div className="heatmap-main">
          <div className="heatmap-months eyebrow" aria-hidden="true">
            {months.map((name, index) => (
              <span key={index} style={{ "--week": index }}>
                {name}
              </span>
            ))}
          </div>
          <div className="heatmap-grid">
            {grid.columns.map((column) =>
              column.cells.map((cell) => {
                const point = dayIndex.get(cell.day);
                const tooltip = point
                  ? `${cell.day} · ${formatTokens(point.totalTokens)} tokens · ${formatCostSmart(
                      point.costMicros,
                    )} · ${point.sessions} session${point.sessions === 1 ? "" : "s"}`
                  : `${cell.day} · nothing recorded`;
                return (
                  <span
                    key={cell.day}
                    className="heat-cell"
                    data-level={cell.level}
                    title={`${tooltip}${metric === "cost" ? " · squares sized in money" : ""}`}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
      <div className="heatmap-foot">
        <span className="heat-legend" aria-hidden="true">
          <span>less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="heat-cell" data-level={level} />
          ))}
          <span>more</span>
        </span>
        <span className="spacer" />
        <span className="range-set" role="group" aria-label="Square unit">
          {[
            ["tokens", "Tokens"],
            ["cost", "Money"],
          ].map(([value, label]) => (
            <button type="button" key={value} aria-pressed={metric === value} onClick={() => onMetric(value)}>
              {label}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
};

/**
 * The fun translations, with the rate behind each one in its tooltip.
 * @param {{ lines: { key: string, label: string, display: string, detail: string }[] }} props
 * @returns {JSX.Element}
 */
const ComparisonList = ({ lines }) => (
  <ul className="comparisons">
    {lines.map((line) => (
      <li key={line.key} title={line.detail}>
        <span className="numeral value">{line.display}</span>
        <span className="label">{line.label}</span>
      </li>
    ))}
  </ul>
);

/**
 * @param {{ navigate: (path: string) => void }} props
 * @returns {JSX.Element}
 */
export const LifetimePage = ({ navigate }) => {
  const theme = useTheme();
  const narrow = useNarrowViewport();
  const [refreshKey, setRefreshKey] = useState(0);
  const [metric, setMetric] = useState("tokens");

  const lifetime = useApi("/api/lifetime", { _k: refreshKey });
  const config = useApi("/api/config", { _k: refreshKey });

  const reloadAll = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    const timer = setInterval(reloadAll, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reloadAll]);

  const stats = lifetime.data;
  const daily = stats?.daily ?? [];
  const today = localToday();

  const streaks = useMemo(() => computeStreaks(daily, today), [daily, today]);
  const level = useMemo(() => levelFromXp(xpFromTotals(stats?.totals)), [stats]);
  const grid = useMemo(
    () => buildHeatmap(daily, { endDay: today, weeks: narrow ? HEATMAP_WEEKS_NARROW : HEATMAP_WEEKS, metric }),
    [daily, today, metric, narrow],
  );
  const week = useMemo(() => weekTotals(daily, { endDay: today }), [daily, today]);
  const lines = useMemo(() => comparisons(stats), [stats]);
  // Square tooltips read both units for a day, so the grid needs the points by day, not the
  // single number it is sized by.
  const dayIndex = useMemo(() => new Map(daily.map((point) => [point.day, point])), [daily]);

  const totals = stats?.totals;

  return (
    <main className="page">
      <header className="masthead">
        <div className="masthead-copy">
          <h1>Lifetime</h1>
          <p>Every session on record, as totals, streaks, and records.</p>
          {lifetime.loading && <p className="eyebrow">Loading…</p>}
          {!lifetime.loading && stats && (
            <p className="eyebrow">
              {stats.counts.sessions} sessions · {formatTokens(totals.totalTokens)} tokens ·{" "}
              {totals.costUsd} · {stats.range.from} → {stats.range.to} · days drawn in{" "}
              {config.data?.timezone ?? "UTC"} ({config.data?.offsetLabel ?? "UTC"})
            </p>
          )}
        </div>
        <span className="spacer" />
        <span className="controls">
          <span
            className="refresh-dot"
            data-active={lifetime.refreshing ? "true" : "false"}
            role="status"
            aria-label={lifetime.refreshing ? "Updating" : "Up to date"}
            title={lifetime.refreshing ? "Updating…" : "Re-reads the whole ledger every 60s"}
          >
            <span className="sr-only">{lifetime.refreshing ? "Updating" : "Up to date"}</span>
          </span>
          <PageNav path="/lifetime" navigate={navigate} />
          <ThemeControls theme={theme} />
          <button type="button" className="ghost" onClick={reloadAll}>
            Refresh
          </button>
        </span>
      </header>

      {lifetime.error && (
        <div className="state-error state" role="alert">
          <h3>Could not load the lifetime totals</h3>
          <p>
            <code>{lifetime.error}</code>
          </p>
          <p>Start the server with `npm run dev:server` from the dashboard folder, then reload.</p>
        </div>
      )}

      {lifetime.loading && <div className="state">Loading the whole ledger…</div>}

      {!lifetime.loading && stats && (
        <>
          <section className="lifetime-hero">
            <div className="hero-totals">
              <StatCell
                label="All-time spend"
                value={totals.costUsd}
                tone="money"
                note={`${formatTokens(totals.totalTokens)} tokens · ${groupNumber(totals.sessions)} sessions · ${
                  groupNumber(totals.events)
                } model calls`}
                foot={moneyBreakdown(totals)}
                title={tokenKinds(totals)}
              />
              <LevelBanner level={level} quipSeed={quipSeedFor(today)} />
            </div>
          </section>

          <Panel title="Streaks">
            <StreakPanel streaks={streaks} week={week} calendarDays={totals.calendarDays} />
          </Panel>

          <Panel
            title="Records"
            actions={
              <span className="eyebrow">
                {totals.activeDays} active days · a day counts when it records tokens, not money
              </span>
            }
          >
            <RecordBoard stats={stats} />
          </Panel>

          <Panel
            title="Activity"
            actions={
              <span className="eyebrow">
                {grid.activeDays} active days in {grid.columns.length} weeks
              </span>
            }
          >
            <ActivityGrid
              grid={grid}
              metric={metric}
              onMetric={setMetric}
              dayIndex={dayIndex}
            />
          </Panel>

          <Panel
            title="In other words"
            actions={<span className="eyebrow">estimates, not receipts</span>}
          >
            <ComparisonList lines={lines} />
            <p className="panel-note">
              Money lines use the ledger's own exact totals. The rest are translations at fixed
              rates — a latte at $4.50, three minutes of typing per tool call, 0.75 words per
              fresh token — hover a line to see the rate behind it.
            </p>
          </Panel>
        </>
      )}
    </main>
  );
};
