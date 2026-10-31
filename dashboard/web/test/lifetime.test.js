/**
 * Unit tests for the lifetime page's drawings: streaks, level, heatmap, comparisons.
 *
 * These are the parts of the lifetime page that make an assertion about your history — a
 * streak length, a level, a square's darkness, "0.2 novels" — so the calendar maths, the
 * streak grace rule for a day in progress, and the rounding of a comparison are all pinned
 * here rather than eyeballed in a browser.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHeatmap,
  comparisons,
  computeStreaks,
  daysBetween,
  groupNumber,
  hourLabel,
  intensityFor,
  levelFromXp,
  peakOf,
  rankForLevel,
  RANKS,
  shiftDay,
  weekTotals,
  weekdayOf,
  xpForLevel,
  xpFromTotals,
} from "../src/lifetime.js";

test("shiftDay, daysBetween, and weekdayOf do calendar maths on plain day strings", () => {
  assert.equal(shiftDay("2026-01-31", 1), "2026-02-01", "across a month edge");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01", "across a year edge");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28", "backwards across a month edge");
  assert.equal(shiftDay("2026-03-01", 0), "2026-03-01");

  assert.equal(daysBetween("2026-01-01", "2026-01-01"), 0);
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  assert.equal(daysBetween("2026-01-31", "2026-01-01"), -30, "the sign says which way the gap runs");

  // 2026-01-01 is a Thursday; 2026-01-04 is a Sunday.
  assert.equal(weekdayOf("2026-01-01"), 4);
  assert.equal(weekdayOf("2026-01-04"), 0);

  assert.equal(groupNumber(17868), "17,868");
  assert.equal(hourLabel(9), "09:00");
  assert.equal(hourLabel(18), "18:00");
});

/**
 * A tiny day series for the streak tests.
 * @param {string[]} days Days that recorded tokens
 * @returns {{ day: string, totalTokens: number, costMicros: number }[]}
 */
const seriesOf = (days) => days.map((day) => ({ day, totalTokens: 1000, costMicros: 10_000 }));

test("computeStreaks counts consecutive working days and remembers the best run", () => {
  const daily = seriesOf([
    "2026-01-01",
    "2026-01-02",
    "2026-01-03", // 3-day run
    "2026-01-06",
    "2026-01-07", // 2-day run
    "2026-01-10",
    "2026-01-11",
    "2026-01-12",
    "2026-01-13", // 4-day run, the record
  ]);

  const streaks = computeStreaks(daily, "2026-01-13");

  assert.equal(streaks.current, 4);
  assert.equal(streaks.currentStartDay, "2026-01-10");
  assert.equal(streaks.currentEndsDay, "2026-01-13", "the run ends today, so today is its last day");
  assert.equal(streaks.longest, 4);
  assert.equal(streaks.longestFrom, "2026-01-10");
  assert.equal(streaks.longestTo, "2026-01-13");
  assert.equal(streaks.activeDays, 9);
  assert.equal(streaks.alive, true);
  assert.equal(streaks.nudge, "4 days — your best on record. This week's sessions extend it.");
});

test("computeStreaks gives today grace and breaks on a finished empty day", () => {
  const daily = seriesOf(["2026-01-10", "2026-01-11", "2026-01-12"]);

  // Nothing recorded today: the day is not over, so the streak is measured as of yesterday.
  const grace = computeStreaks(daily, "2026-01-13");
  assert.equal(grace.current, 3, "the run is still standing on a day that has not finished");
  assert.equal(grace.currentEndsDay, "2026-01-12", "the run's last recorded day, not the empty day in progress");
  assert.equal(grace.alive, true);
  assert.equal(grace.daysSinceLastActive, 1);

  // One full day with nothing in it ends it.
  const broken = computeStreaks(daily, "2026-01-14");
  assert.equal(broken.current, 0);
  assert.equal(broken.alive, false);
  assert.equal(broken.longest, 3, "the record survives its own streak ending");
  assert.equal(broken.daysSinceLastActive, 2);
  assert.equal(broken.nudge, "Dormant for 2 days. One session restarts it.");

  const empty = computeStreaks([], "2026-01-14");
  assert.equal(empty.current, 0);
  assert.equal(empty.longest, 0);
  assert.equal(empty.lastActiveDay, null);
  assert.equal(empty.nudge, "No recorded usage yet. Run a session to start the streak.");
});

test("computeStreaks treats a zero-cost day as a working day", () => {
  // 2026-01-12 spent nothing on local models. Money-based streaks would break here.
  const daily = [
    { day: "2026-01-10", totalTokens: 5_000_000, costMicros: 250_000 },
    { day: "2026-01-11", totalTokens: 9_000_000, costMicros: 0 },
    { day: "2026-01-12", totalTokens: 41_000_000, costMicros: 0 },
  ];

  const streaks = computeStreaks(daily, "2026-01-12");
  assert.equal(streaks.current, 3, "free local-model work keeps the streak alive");
  assert.equal(streaks.activeDays, 3);
});

test("xpFromTotals weights tokens and tops up with money", () => {
  // 1k tokens is one XP, ten cents is one XP.
  assert.equal(xpFromTotals({ totalTokens: 1_000, costMicros: 0 }), 1);
  assert.equal(xpFromTotals({ totalTokens: 0, costMicros: 100_000 }), 1, "$0.10 is one XP");
  assert.equal(xpFromTotals({ totalTokens: 0, costMicros: 10_000 }), 0, "$0.01 is a tenth of an XP, and XP is whole");
  assert.equal(xpFromTotals({ totalTokens: 1_000, costMicros: 100_000 }), 2);
  assert.equal(xpFromTotals({ totalTokens: 1_327_966_557, costMicros: 105_801_508 }), 1_329_025);
  assert.equal(xpFromTotals({}), 0);
});

test("levelFromXp walks a power curve and reports the gap to the next level", () => {
  assert.equal(xpForLevel(1), 0, "level 1 is free");
  assert.equal(xpForLevel(2), 25_000);
  assert.equal(xpForLevel(3), 75_786, "level 3 costs twice what level 2 cost");
  assert.equal(xpForLevel(4) > xpForLevel(3), true, "and each step is bigger than the last");

  const atLevelOne = levelFromXp(0);
  assert.equal(atLevelOne.level, 1);
  assert.equal(atLevelOne.rank, "Prompt Tinkerer");
  assert.equal(atLevelOne.nextLevelXp, 25_000);
  assert.equal(atLevelOne.percent, 0);

  const midLevel = levelFromXp(40_000);
  assert.equal(midLevel.level, 2);
  assert.equal(midLevel.levelFloorXp, 25_000);
  assert.equal(midLevel.nextLevelXp, 75_786);
  assert.equal(midLevel.xpIntoLevel, 15_000);
  assert.equal(midLevel.xpToNext, 35_786);
  assert.equal(midLevel.percent, 30, "15k of a 50.8k span");

  // The exact level boundary belongs to the new level, not the old one.
  assert.equal(levelFromXp(25_000).level, 2);
  assert.equal(levelFromXp(24_999).level, 1);
  assert.equal(levelFromXp(1_329_025).level, 12, "this machine's real total");
  assert.equal(levelFromXp(1_329_025).rank, "Cache Glutton");
});

test("the rank bands are five levels wide, so a rank change lands on a round level", () => {
  assert.deepEqual(
    RANKS.map((entry) => entry.minLevel),
    [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
  );
  assert.equal(
    RANKS.map((entry, index) => entry.minLevel - (RANKS[index - 1]?.minLevel ?? 0)).join(","),
    "1,4,5,5,5,5,5,5,5,5,5",
    "the first band is level 1, every band after it is five levels",
  );

  // A band covers the levels before the next breakpoint, so the bar can name what is coming.
  assert.equal(rankForLevel(1), "Prompt Tinkerer");
  assert.equal(rankForLevel(4), "Prompt Tinkerer");
  assert.equal(rankForLevel(5), "Context Hoarder");
  assert.equal(rankForLevel(9), "Context Hoarder");
  assert.equal(rankForLevel(10), "Cache Glutton");
  assert.equal(rankForLevel(15), "Token Incinerator");
  assert.equal(rankForLevel(49), "Total Token Catastrophe");
  assert.equal(rankForLevel(50), "Ledger Legend");
  assert.equal(rankForLevel(999), "Ledger Legend", "the top rank keeps going");

  assert.equal(
    RANKS.every((entry) => entry.rank.length > 0),
    true,
    "no band is unnamed",
  );
});

test("intensityFor spreads the mid-range so a record day cannot flatten the grid", () => {
  assert.equal(intensityFor(0, 100), 0, "an empty square is 0");
  assert.equal(intensityFor(100, 100), 4, "the biggest day in the window tops out");
  assert.equal(intensityFor(1, 100), 1, "a token-counting day of nothing is a faint square, not empty");
  assert.equal(intensityFor(25, 100), 2, "a quarter of the max is a mid-tone, not the top band");
  assert.equal(intensityFor(50, 100), 3);
  assert.equal(intensityFor(9_000, 100), 4, "a value past the max is clamped");
  assert.equal(intensityFor(10, 0), 0, "a window with no usage has no dark squares");
});

test("buildHeatmap draws whole week columns from Sunday to Saturday", () => {
  const daily = [
    { day: "2026-01-04", totalTokens: 10_000_000, costMicros: 500_000 }, // Sunday
    { day: "2026-01-05", totalTokens: 1_000_000, costMicros: 0 }, // Monday
    { day: "2026-01-07", totalTokens: 40_000_000, costMicros: 4_000_000 }, // Wednesday
  ];

  const grid = buildHeatmap(daily, { endDay: "2026-01-11", weeks: 2 });

  assert.equal(grid.startDay, "2026-01-04", "two weeks back from Jan 11 lands on the Sunday Jan 4");
  assert.equal(grid.endDay, "2026-01-11");
  assert.equal(grid.columns.length, 2);
  assert.equal(grid.columns[0].cells.length, 7);
  assert.equal(grid.columns[0].cells.map((cell) => cell.day).at(-1), "2026-01-10", "a column is a full week");
  assert.equal(grid.columns[1].cells.length, 1, "the in-progress week holds only the days that have arrived");

  const byDay = new Map(grid.columns.flatMap((column) => column.cells).map((cell) => [cell.day, cell]));
  assert.equal(byDay.get("2026-01-04").value, 10_000_000);
  assert.equal(byDay.get("2026-01-06").value, 0, "a day with no usage is a zero square, not a missing one");
  assert.equal(byDay.get("2026-01-07").level, 4, "the window's biggest day is the darkest square");
  assert.equal(byDay.get("2026-01-05").level, 1);
  assert.equal(grid.activeDays, 3);
  assert.equal(grid.max, 40_000_000, "intensity is scaled inside the window, not by all history");

  const money = buildHeatmap(daily, { endDay: "2026-01-11", weeks: 2, metric: "cost" });
  assert.equal(money.metric, "cost");
  assert.equal(money.max, 4_000_000, "the same grid sized in money");
  assert.equal(
    money.columns.flatMap((column) => column.cells).find((cell) => cell.day === "2026-01-05").level,
    0,
    "a zero-dollar day is an empty square when the grid is sized in money, and a lit one in tokens",
  );

  const empty = buildHeatmap([], { endDay: null });
  assert.equal(empty.columns.length, 0);
  assert.equal(empty.endDay, null);
});

test("weekTotals reports the Sunday-to-today part of the current week", () => {
  const daily = [
    { day: "2026-01-03", totalTokens: 100, costMicros: 100, sessions: 1 }, // Saturday, last week
    { day: "2026-01-04", totalTokens: 5_000, costMicros: 250_000, sessions: 2 }, // Sunday
    { day: "2026-01-06", totalTokens: 7_000, costMicros: 0, sessions: 3 }, // Tuesday
  ];

  const week = weekTotals(daily, { endDay: "2026-01-07" });
  assert.equal(week.startDay, "2026-01-04", "the week starts on Sunday");
  assert.equal(week.endDay, "2026-01-07");
  assert.equal(week.activeDays, 2, "last Saturday is not in this week");
  assert.equal(week.totalTokens, 12_000);
  assert.equal(week.costMicros, 250_000);
  assert.equal(week.sessions, 5);

  assert.equal(weekTotals([], { endDay: "2026-01-07" }).totalTokens, 0, "a week with no history is a zero week");
  assert.equal(weekTotals([], {}), null, "with no history there is no week to name");
});

test("comparisons translate the ledger and drop the lines that round away", () => {
  const stats = {
    totals: {
      costMicros: 450_000,
      costUsd: "$0.45",
      totalTokens: 1_000_000,
      inputTokens: 10_000,
      outputTokens: 10_000,
      cacheReadTokens: 980_000,
      cacheWriteTokens: 0,
      events: 50,
    },
    counts: { toolCalls: 120, userMessages: 12 },
  };

  const lines = new Map(comparisons(stats).map((line) => [line.key, line]));

  assert.equal(lines.get("coffee").display, "0.1", "a tenth of a latte is worth naming at one decimal");
  assert.equal(lines.has("pizza"), false, "three-hundredths of a pizza is not a comparison");
  assert.equal(lines.has("music"), false);
  assert.equal(lines.get("typing").display, "6", "120 tool calls at 3 minutes each is 6 hours");
  assert.equal(lines.get("pages").display, "50", "20k fresh tokens at 0.75 words is 15k words at 300 a page");
  assert.equal(lines.get("novels").display, "0.2");
  assert.equal(lines.get("echoes").display, "49", "980k cache reads against 20k fresh tokens");
  assert.equal(lines.get("perDollar").display, "2,222,222");
  assert.equal(lines.get("calls").display, "50");
  assert.equal(lines.get("messages").display, "12");

  // Cache reads are deliberately out of the prose lines: they are re-read context, not text.
  assert.equal(lines.get("pages").detail.includes("fresh tokens"), true);

  const broke = comparisons({ totals: { totalTokens: 5_000, inputTokens: 100, outputTokens: 100 }, counts: {} });
  assert.equal(broke.some((line) => line.key === "coffee"), false, "no money, no coffee line");
  assert.equal(broke.some((line) => line.key === "perDollar"), false, "a $0 ledger has no tokens-per-dollar");
  assert.equal(broke.some((line) => line.key === "echoes"), false, "no cache reads, no ratio");
});

test("peakOf takes the biggest row by a field and keeps the first to set the record", () => {
  const days = [
    { day: "2026-01-01", costMicros: 100 },
    { day: "2026-01-02", costMicros: 300 },
    { day: "2026-01-03", costMicros: 300 },
  ];

  assert.equal(peakOf(days, "costMicros").day, "2026-01-02", "a tie goes to the day that got there first");
  assert.equal(peakOf([], "costMicros"), null);
  assert.equal(peakOf(null, "costMicros"), null);
});
