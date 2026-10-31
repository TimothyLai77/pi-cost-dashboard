/**
 * Lifetime statistics drawings: streaks, level, heatmap, and the fun comparisons.
 *
 * `/api/lifetime` returns facts — totals, one point per day, an hour-of-day series, a
 * weekday series, and the record rows. Everything in this file is a *drawing over* those
 * facts: which days form a streak, what level that many tokens earns, how dark a square is,
 * and what a billion tokens is worth in coffees. They live here, next to the page that draws
 * them, for the same reason `costParts.js` and `flowGraph.js` exist: the server answers
 * questions about the ledger, and the page decides what is worth comparing.
 *
 * No React and no fetching, so `npm test` can exercise all of it.
 *
 * A day counts as active when it recorded any token at all. Most usage on this machine runs
 * on local models priced at zero, so a streak measured in money breaks on exactly the days
 * that did the most work.
 */

/** Tokens that earn one XP. 1k tokens is one XP: a busy day is tens of thousands. @type {number} */
export const XP_PER_TOKEN = 1 / 1000;

/** Money that earns one XP. Ten cents is one XP, so paid usage counts without dominating. @type {number} */
export const XP_PER_DOLLAR = 1 / 0.1;

/** XP needed to leave level 1. Levels grow on top of that by a power, so each one takes longer. @type {number} */
const LEVEL_BASE_XP = 25_000;

/** Growth of the level curve: level n costs `LEVEL_BASE_XP * (n - 1) ^ LEVEL_EXPONENT`. @type {number} */
const LEVEL_EXPONENT = 1.6;

/**
 * What each band of levels is called. `minLevel` is the lowest level carrying that rank, and
 * the list is read in order, so the last rank that fits wins.
 *
 * The bands are five levels wide, so a rank change lands on a round level the level banner can
 * count down to: level 15 is Token Incinerator, and the bar says how far off it is the whole way
 * there.
 *
 * The names escalate in the same order the ledger does. The low bands are about volume (tokens
 * re-read, tokens burned) because that is what the first million XP is. The high bands are about
 * money, because a level that takes 12.6M XP is not a volume story any more: at that point the
 * joke is the invoice, the vendor's shareholder register, and the national scale of it. Read in
 * order, the ladder goes "you use a lot" → "you enable an industry" → "nobody is supervising
 * this spending" → "this is a fiscal event".
 *
 * @type {{ minLevel: number, rank: string }[]}
 */
export const RANKS = [
  { minLevel: 1, rank: "Prompt Tinkerer" },
  { minLevel: 5, rank: "Context Hoarder" },
  { minLevel: 10, rank: "Cache Glutton" },
  { minLevel: 15, rank: "Token Incinerator" },
  { minLevel: 20, rank: "Hallucination Enabler" },
  { minLevel: 25, rank: "Inference Arsonist" },
  { minLevel: 30, rank: "Financially Unsupervised" },
  { minLevel: 35, rank: "Circular Revenue Champion" },
  { minLevel: 40, rank: "OpenAI Shareholder" },
  { minLevel: 45, rank: "Bankruptcy Speedrunner" },
  { minLevel: 50, rank: "The National Debt Simulator" },
];

/** Weekday names, indexed by the 0-6 number a calendar day resolves to. @type {string[]} */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Prices and rates behind the comparisons, so the numbers are quotable and not vibes. */
export const RATES = {
  coffeeUsd: 4.5,
  pizzaUsd: 15,
  musicUsd: 11,
  minutesPerToolCall: 3,
  wordsPerToken: 0.75,
  wordsPerNovel: 80_000,
};

/**
 * Shift a `YYYY-MM-DD` calendar string by whole days.
 * @param {string} day `YYYY-MM-DD`
 * @param {number} days Days to move; negative moves back
 * @returns {string} `YYYY-MM-DD`
 */
export const shiftDay = (day, days) => {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return shifted.toISOString().slice(0, 10);
};

/**
 * Whole days from one calendar day to another.
 * @param {string} fromDay `YYYY-MM-DD`
 * @param {string} toDay `YYYY-MM-DD`
 * @returns {number} 0 for the same day, positive when `toDay` is later, negative when earlier
 */
export const daysBetween = (fromDay, toDay) => {
  const [fromYear, fromMonth, fromDate] = fromDay.split("-").map(Number);
  const [toYear, toMonth, toDate] = toDay.split("-").map(Number);
  return Math.round(
    (Date.UTC(toYear, toMonth - 1, toDate) - Date.UTC(fromYear, fromMonth - 1, fromDate)) / 86_400_000,
  );
};

/**
 * Weekday index of a calendar day.
 * @param {string} day `YYYY-MM-DD`
 * @returns {number} 0 for Sunday through 6 for Saturday
 */
export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/**
 * Format a whole number with thousands separators.
 *
 * `toLocaleString` is deliberately avoided: the separators depend on the reader's locale, and
 * these figures sit inside sentences and tests that name them exactly.
 *
 * @param {number} value
 * @returns {string} e.g. "1,328", "17,868"
 */
export const groupNumber = (value) => {
  const rounded = Math.round(Number(value) || 0);
  const sign = rounded < 0 ? "-" : "";
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

/**
 * Is a daily point a day that worked?
 * @param {{ totalTokens?: number }} point One day from `/api/lifetime`
 * @returns {boolean} true when the day recorded any token at all
 */
const isWorkingDay = (point) => (point?.totalTokens ?? 0) > 0;

/**
 * Current and longest streaks of working days.
 *
 * A streak is a run of consecutive days that recorded tokens. Today is a grace day: on a day
 * with no usage yet, the streak is measured as of yesterday, because the day is not over.
 * Once a full day passes with nothing in it, the streak is broken, and `daysSinceLastActive`
 * says how long ago that was.
 *
 * `nudge` is the sentence under the streak. It is the page's one attempt at encouragement, so
 * it always names a specific, reachable next step rather than a generic "keep it up".
 *
 * @param {{ day: string, totalTokens?: number, costMicros?: number }[]} daily Day series from `/api/lifetime`
 * @param {string} today `YYYY-MM-DD` in the zone the series was drawn in
 * @returns {{
 *   current: number,
 *   currentStartDay: string | null,
 *   currentEndsDay: string | null,
 *   longest: number,
 *   longestFrom: string | null,
 *   longestTo: string | null,
 *   activeDays: number,
 *   lastActiveDay: string | null,
 *   daysSinceLastActive: number | null,
 *   alive: boolean,
 *   nudge: string
 * }}
 */
export const computeStreaks = (daily, today) => {
  const points = (daily ?? []).filter((point) => point?.day);
  const working = points.filter(isWorkingDay);
  const activeDays = new Set(working.map((point) => point.day));

  // Longest run anywhere in the record, remembered with the days it spans so the page can
  // name the streak instead of only counting it.
  let longest = 0;
  let longestFrom = null;
  let longestTo = null;
  let runStart = null;
  let runLength = 0;
  let previous = null;
  for (const point of [...working].sort((a, b) => (a.day < b.day ? -1 : 1))) {
    runLength = previous && daysBetween(previous, point.day) === 1 ? runLength + 1 : 1;
    if (runLength === 1) runStart = point.day;
    previous = point.day;
    if (runLength > longest) {
      longest = runLength;
      longestFrom = runStart;
      longestTo = point.day;
    }
  }

  // Today counts if it worked; if it has not recorded anything yet, start from yesterday and
  // let the day finish before anything is called broken. `startFrom` is the newest day the run
  // is allowed to end on, so a run that reaches it is a streak that is still standing.
  const lastActiveDay =
    working.length > 0 ? working.reduce((best, p) => (p.day > best.day ? p : best)).day : null;
  const startFrom = activeDays.has(today) ? today : shiftDay(today, -1);
  let current = 0;
  let cursor = startFrom;
  while (activeDays.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }

  const currentEndsDay = startFrom;
  const currentStartDay = shiftDay(startFrom, -(current - 1));
  const daysSinceLastActive = lastActiveDay ? daysBetween(lastActiveDay, today) : null;

  return {
    current,
    currentStartDay: current > 0 ? currentStartDay : null,
    currentEndsDay: current > 0 ? currentEndsDay : null,
    longest,
    longestFrom,
    longestTo,
    activeDays: activeDays.size,
    lastActiveDay,
    daysSinceLastActive,
    alive: current > 0,
    nudge: streakNudge({ current, longest, daysSinceLastActive }),
  };
};

/**
 * The one line of encouragement under the streak.
 *
 * It always names a specific next step, because "keep it up" is not a reason to open a
 * terminal: how many days tie the record, and how many have passed since the last session.
 *
 * @param {{ current: number, longest: number, daysSinceLastActive: number | null }} streaks
 * @returns {string}
 */
const streakNudge = ({ current, longest, daysSinceLastActive }) => {
  if (current === 0) {
    if (daysSinceLastActive === null) return "No recorded usage yet. Run a session to start the streak.";
    return `Dormant for ${daysSinceLastActive} day${daysSinceLastActive === 1 ? "" : "s"}. One session restarts it.`;
  }
  if (current === 1) return "Day one. Come back tomorrow and it becomes a streak.";
  if (current === longest) return `${current} days — your best on record. This week's sessions extend it.`;
  const gap = longest - current;
  return `${gap} more day${gap === 1 ? "" : "s"} ties your longest streak.`;
};

/**
 * XP earned from a ledger: tokens dominate, money tops it up.
 *
 * Tokens are the volume knob (1k tokens is one XP) and money is the premium knob (ten cents is
 * one XP), which is the order the page wants: a day of zero-priced local-model work earns
 * almost the same XP as the same day on a paid model, so the level tracks work done, not money
 * burned.
 *
 * @param {{ totalTokens?: number, costMicros?: number }} totals The `totals` block from `/api/lifetime`
 * @returns {number} Whole XP
 */
export const xpFromTotals = (totals) =>
  Math.round((totals?.totalTokens ?? 0) * XP_PER_TOKEN + (totals?.costMicros ?? 0) / 1e6 * XP_PER_DOLLAR);

/**
 * Total XP needed to reach a level.
 * @param {number} level 1-based level
 * @returns {number} XP at which that level begins; 0 for level 1
 */
export const xpForLevel = (level) =>
  level <= 1 ? 0 : Math.round(LEVEL_BASE_XP * (level - 1) ** LEVEL_EXPONENT);

/**
 * Rank name for a level.
 * @param {number} level
 * @returns {string} The rank whose band contains the level
 */
export const rankForLevel = (level) =>
  [...RANKS].reverse().find((entry) => level >= entry.minLevel)?.rank ?? RANKS[0].rank;

/**
 * Level, rank, and progress toward the next level.
 *
 * The curve is a power, so each level takes longer than the last and the bar is always worth
 * filling: `percent` is how far into the current level you are, `xpToNext` the exact gap.
 *
 * @param {number} xp
 * @returns {{
 *   xp: number,
 *   level: number,
 *   rank: string,
 *   levelFloorXp: number,
 *   nextLevelXp: number,
 *   xpIntoLevel: number,
 *   xpToNext: number,
 *   percent: number
 * }}
 */
export const levelFromXp = (xp) => {
  const total = Math.max(0, Math.round(Number(xp) || 0));

  let level = 1;
  while (xpForLevel(level + 1) <= total && level < 10_000) level += 1;

  const levelFloorXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const span = nextLevelXp - levelFloorXp;
  const xpIntoLevel = total - levelFloorXp;

  return {
    xp: total,
    level,
    rank: rankForLevel(level),
    levelFloorXp,
    nextLevelXp,
    xpIntoLevel,
    xpToNext: nextLevelXp - total,
    percent: span > 0 ? Math.min(100, Math.round((xpIntoLevel / span) * 100)) : 100,
  };
};

/**
 * The biggest entry in a series, by one field.
 *
 * Ties go to the earlier entry, which is the conservative choice for a record board: the first
 * day to set a record keeps it.
 *
 * @param {object[]} series
 * @param {string} field Field to compare
 * @returns {object | null} The row with the largest value, null for an empty series
 */
export const peakOf = (series, field) =>
  (series ?? []).reduce((best, row) => (best === null || row[field] > best[field] ? row : best), null);

/**
 * Square darkness for one day's value.
 *
 * A straight share of the maximum would put every ordinary day in the lightest band, because
 * one record day dwarfs them all. A square-root scale spreads the mid-range, so a normal busy
 * day reads as a mid-tone and only the genuine outliers top out.
 *
 * @param {number} value The day's value
 * @param {number} max The largest value in the window
 * @returns {number} 0 for nothing, 1-4 for the four bands
 */
export const intensityFor = (value, max) => {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil(4 * Math.sqrt(value / max))));
};

/**
 * How many week columns the activity grid draws.
 *
 * The squares are `minmax(11px, 1fr)` columns with a 3px gap, so a window needs
 * `weeks × 14px` of content width before the columns can shrink any further. 26 weeks is 361px,
 * which is comfortable on a desktop and wider than a phone's card (312px inside a 390px screen,
 * after the page gutter, the card padding and the weekday letters), so the phone window is 13
 * weeks: 182px of content, 21px squares, and the strip fits its box instead of scrolling inside
 * it. The pair is tested so the narrow window cannot quietly outgrow a phone.
 */
export const HEATMAP_WEEKS = 26;

/** Week columns on the phone-width layout. @type {number} */
export const HEATMAP_WEEKS_NARROW = 13;

/**
 * Commentary lines the level card cycles through.
 *
 * Plain strings, no placeholders: a joke that quotes the ledger has to be written by someone
 * who has seen the ledger, and a string that cannot resolve is a string the page has to hide.
 * Two lines is the budget (~110 characters), which is what the card's fixed-height box clamps.
 *
 * Filled in by hand, so the list is the feature: an empty list renders no strip at all.
 *
 * @type {string[]}
 */
export const QUIPS = [
  "A penny saved is a GPU hour wasted.",
  "Why solve it in 100 tokens when you can solve it in 100,000?",
  "Your agent is thinking very hard about being wrong.",
  "Congratulations on automating a task that took 11 seconds.",
  "You gotta keep the AI bubble inflated somehow...",
  "Context window looking a little empty. Are you even trying to warm the planet?",
  "Spending $0.40 in API fees to save $0.02 of human effort.",
  "A 40-step agent loop just to return null.",
  "Burning carbon so you don't have to write a Regex.",
  "Cooking the planet to avoid reading the documentation.",
  "Spend money to save money. Eventually.",
  "A dollar of inference to save a penny of labour.",
  "Another day, another subsidized hallucination.",
  "The business model is somewhere in the context window.",
  "Have you considered using more electricity to think less?",
  "Every token is a small contribution to climate change.",
  "The planet isn't going to warm itself.",
  "Generating 4,000 tokens to avoid a Google search. Sustainable.",
  "Mother Nature would like you to switch to Haiku.",
  "Four agents, two dozen tool calls, zero useful outcomes.",
  "Who is JSON?",
  "Somewhere, a GPU is collateralizing another GPU.",
  "Nobody has read this output. Nobody.",
  "The agent has read your file eleven times. It is not learning.",
  "Six tool calls to find out what your shell history already knew.",
  "The plan was good. The plan was also 9,000 tokens.",
  "Every compaction is a small amnesia you paid for.",
  "This session cost more than the feature is worth. Ship it.",
];

/**
 * Milliseconds a commentary line stays up before the strip walks to the next one.
 *
 * Exported from the pure module rather than kept in the page because the typing budget is
 * measured against it: a line that takes longer to type than the window it is shown in is a bug
 * the tests can see, and they cannot see into a component.
 *
 * @type {number}
 */
export const QUIP_ROTATION_MS = 9_000;

/**
 * Milliseconds per character of the commentary strip's typing animation.
 *
 * The budget is the rotation: the longest line in the list has to finish typing with time left to
 * read it, and `lifetime.test.js` enforces that (110 characters at this speed is 2.9s of a 9s
 * window, so more than two thirds of the time is spent on a finished, readable line).
 *
 * @type {number}
 */
export const QUIP_TYPE_MS = 26;

/**
 * Which commentary line to show.
 *
 * The rotation walks the list in order from a start point picked by the day, so a day opens on
 * the same line, a visit walks the whole list before it repeats, and the line never repeats
 * immediately. A shuffle would repeat by accident; walking a list cannot.
 *
 * @param {string[]} list The commentary lines
 * @param {number} seed The day's start offset, from `quipSeedFor`
 * @param {number} rotation How many steps this visit has already taken
 * @returns {number | null} The index to show, null when there is nothing to show
 */
export const pickQuip = (list, seed, rotation) => {
  const count = list?.length ?? 0;
  if (count === 0) return null;
  const start = Math.abs(Math.trunc(seed)) % count;
  return (start + Math.abs(Math.trunc(rotation))) % count;
};

/**
 * The day's starting offset into the commentary list.
 *
 * A cheap sum of the date's characters: it is not a hash that needs to be strong, it needs to
 * be stable for a day and different day to day, and a sum of character codes over ten characters
 * does that without a dependency.
 *
 * @param {string} day A `YYYY-MM-DD` day string
 * @returns {number} A non-negative integer to seed `pickQuip`
 */
export const quipSeedFor = (day) => {
  if (typeof day !== "string") return 0;
  return [...day].reduce((sum, character) => sum + character.charCodeAt(0), 0);
};

/**
 * The activity grid: weeks as columns, Sunday to Saturday as rows.
 *
 * The window is `weeks` whole columns ending with the column that contains `endDay`, each
 * column starting on a Sunday. Days with no recorded usage are included as zero squares — an
 * empty square is the point of a heatmap.
 *
 * @param {{ day: string, totalTokens?: number, costMicros?: number }[]} daily Day series from `/api/lifetime`
 * @param {{ endDay?: string, weeks?: number, metric?: "tokens" | "cost" }} [options]
 *   `endDay` defaults to the newest day in the series; `weeks` is the window width
 * @returns {{
 *   metric: string,
 *   startDay: string,
 *   endDay: string | null,
 *   max: number,
 *   activeDays: number,
 *   columns: { weekStart: string, cells: { day: string, value: number, level: number }[] }[]
 * }}
 */
export const buildHeatmap = (daily, options = {}) => {
  const metric = options.metric === "cost" ? "cost" : "tokens";
  const weeks = Math.max(1, Math.trunc(options.weeks ?? 26));
  const points = daily ?? [];

  const endDay =
    options.endDay ?? (points.length > 0 ? points.reduce((best, p) => (p.day > best.day ? p : best)).day : null);

  if (!endDay) {
    return { metric, startDay: null, endDay: null, max: 0, activeDays: 0, columns: [] };
  }

  // Whole columns, ending with the week `endDay` falls in: take that week's Sunday, then walk
  // back whole weeks. A window measured from a Sunday always has exactly `weeks` columns.
  const startSunday = shiftDay(endDay, -weekdayOf(endDay));
  const startDay = shiftDay(startSunday, -(weeks - 1) * 7);

  const valueFor = (point) =>
    metric === "cost" ? (point?.costMicros ?? 0) : (point?.totalTokens ?? 0);

  /** @type {Map<string, number>} */
  const valueByDay = new Map(points.map((point) => [point.day, valueFor(point)]));
  const max = Math.max(0, ...points.filter((point) => point.day >= startDay).map(valueFor));

  const columns = [];
  let day = startDay;
  while (day <= endDay) {
    const cells = [];
    for (let index = 0; index < 7 && day <= endDay; index += 1) {
      const value = valueByDay.get(day) ?? 0;
      cells.push({ day, value, level: intensityFor(value, max) });
      day = shiftDay(day, 1);
    }
    columns.push({ weekStart: cells[0].day, cells });
  }

  const activeDays = columns
    .flatMap((column) => column.cells)
    .filter((cell) => cell.value > 0).length;

  return { metric, startDay, endDay, max, activeDays, columns };
};

/**
 * One week's totals, for "this week" next to the lifetime numbers.
 *
 * The week is the caller's `endDay` week, Sunday to Saturday, and a week in progress is
 * reported as it stands, which is what makes it comparable to the average week beside it.
 *
 * @param {{ day: string, totalTokens?: number, costMicros?: number, sessions?: number }[]} daily
 * @param {{ endDay?: string }} [options]
 * @returns {{ startDay: string, endDay: string, activeDays: number, costMicros: number, totalTokens: number, sessions: number } | null}
 */
export const weekTotals = (daily, options = {}) => {
  const points = daily ?? [];
  const endDay =
    options.endDay ?? (points.length > 0 ? points.reduce((best, p) => (p.day > best.day ? p : best)).day : null);
  if (!endDay) return null;

  const startDay = shiftDay(endDay, -weekdayOf(endDay));
  const inWeek = points.filter((point) => point.day >= startDay && point.day <= endDay);

  return {
    startDay,
    endDay,
    activeDays: inWeek.filter(isWorkingDay).length,
    costMicros: inWeek.reduce((sum, point) => sum + (point.costMicros ?? 0), 0),
    totalTokens: inWeek.reduce((sum, point) => sum + (point.totalTokens ?? 0), 0),
    sessions: inWeek.reduce((sum, point) => sum + (point.sessions ?? 0), 0),
  };
};

/**
 * A display number for a comparison, chosen for the size of the value.
 *
 * Below ten the decimals are the interesting part ("2.1 novels"), above a thousand thousands
 * separators read better than a scale suffix ("12,450 pages"). Nothing is rounded to zero when
 * it is not zero: a comparison that rounds away is a comparison the page should not show.
 *
 * @param {number} value
 * @returns {string | null} null when the value rounds away to nothing
 */
const displayNumber = (value) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 10) return groupNumber(value);
  const rounded = Math.round(value * 10) / 10;
  // A value that rounds away is not a comparison worth showing: "0 lattes" is noise.
  return rounded > 0 ? String(rounded) : null;
};

/**
 * The fun translations of the ledger.
 *
 * These are the numbers a person can actually picture: what the spend would have bought, how
 * much typing the tool calls replace, how many pages of text the models wrote. They are
 * estimates from `RATES` and are labelled as such in the tooltip — the ledger's own figures are
 * the exact ones, and every line names the rate behind it.
 *
 * Fresh tokens are input + output + cache write. Cache reads are excluded from the word-based
 * lines because they are the same context re-read on every call, not text anyone wrote.
 *
 * @param {object} stats Payload from `/api/lifetime`
 * @returns {{ key: string, label: string, display: string, detail: string }[]}
 */
export const comparisons = (stats) => {
  const totals = stats?.totals ?? {};
  const counts = stats?.counts ?? {};

  const costUsd = (totals.costMicros ?? 0) / 1e6;
  const freshTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0) + (totals.cacheWriteTokens ?? 0);
  const words = freshTokens * RATES.wordsPerToken;

  /**
   * @param {string} key
   * @param {string} label
   * @param {number} value
   * @param {string} detail
   * @returns {{ key: string, label: string, display: string, detail: string } | null}
   */
  const line = (key, label, value, detail) => {
    const display = displayNumber(value);
    return display ? { key, label, display, detail } : null;
  };

  return [
    line("coffee", "lattes", costUsd / RATES.coffeeUsd, `${totals.costUsd ?? "$0.00"} at $${RATES.coffeeUsd} a latte`),
    line("pizza", "large pizzas", costUsd / RATES.pizzaUsd, `${totals.costUsd ?? "$0.00"} at $${RATES.pizzaUsd} a pizza`),
    line("music", "months of music", costUsd / RATES.musicUsd, `at $${RATES.musicUsd} a month`),
    line(
      "typing",
      "hours of typing it replaced",
      (counts.toolCalls ?? 0) * (RATES.minutesPerToolCall / 60),
      `${groupNumber(counts.toolCalls ?? 0)} tool calls at ${RATES.minutesPerToolCall} minutes each`,
    ),
    line("pages", "pages of prose", words / 300, `${groupNumber(freshTokens)} fresh tokens at ${RATES.wordsPerToken} words each, 300 words a page`),
    line(
      "novels",
      "novels of prose",
      words / RATES.wordsPerNovel,
      `input, output, and cache-write tokens only — cache re-reads are not prose`,
    ),
    freshTokens > 0 && (totals.cacheReadTokens ?? 0) > 0
      ? line(
          "echoes",
          "tokens re-read per token written",
          (totals.cacheReadTokens ?? 0) / freshTokens,
          `${groupNumber(totals.cacheReadTokens ?? 0)} cache reads against ${groupNumber(freshTokens)} fresh tokens`,
        )
      : null,
    costUsd > 0
      ? line(
          "perDollar",
          "tokens per dollar",
          (totals.totalTokens ?? 0) / costUsd,
          `every dollar bought ${groupNumber((totals.totalTokens ?? 0) / costUsd)} tokens of throughput`,
        )
      : null,
    line("calls", "model calls", totals.events, `${groupNumber(totals.events ?? 0)} billed model calls, all time`),
    line("messages", "messages you sent", counts.userMessages, `${groupNumber(counts.userMessages ?? 0)} prompts, all time`),
  ].filter(Boolean);
};

/**
 * A wall-clock hour label for an hour index.
 * @param {number} hour 0-23
 * @returns {string} e.g. "09:00", "18:00"
 */
export const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;
