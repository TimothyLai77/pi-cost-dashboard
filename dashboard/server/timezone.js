/**
 * Timezone handling for bucketing usage facts.
 *
 * Everything in the database is UTC. Bucketing by day or hour is a display decision, and
 * doing it in SQL with a fixed minute offset is only correct while daylight time does not
 * change inside the requested range - a year-long chart with a fixed -420 offset puts every
 * Arizona day and half of every Denver day in the wrong bucket.
 *
 * So bucketing happens here, per timestamp, using the ICU data Node ships: `Intl` resolves
 * an IANA zone (America/Denver, Europe/Berlin, Asia/Kolkata, a half-hour and 45-minute
 * offset included) with the right offset for that instant, DST included.
 */

/** Cached formatters, keyed by zone. @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * Formatter for a zone, created once per zone and reused (they are not cheap to build).
 * @param {string} timeZone IANA zone name
 * @returns {Intl.DateTimeFormat}
 */
const formatterFor = (timeZone) => {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const built = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, built);
  return built;
};

/**
 * Is this a zone this Node can resolve?
 * @param {unknown} value Candidate zone name
 * @returns {boolean} true when Intl accepts it
 */
export const isSupportedTimeZone = (value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Read the calendar fields of a timestamp as it reads on a wall clock in a zone.
 * @param {string | Date | number} timestamp ISO-8601 UTC string, or anything Date accepts
 * @param {string} timeZone IANA zone name
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
const wallClock = (timestamp, timeZone) => {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const parts = formatterFor(timeZone).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
};

/**
 * Normalize a timestamp to the fixed-width ISO string the database stores.
 * @param {string | Date | number} timestamp ISO-8601 string, Date, or epoch milliseconds
 * @returns {string} ISO-8601 UTC string
 */
const utcStamp = (timestamp) =>
  timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);

/**
 * The calendar day a timestamp falls in, in a zone.
 * @param {string | Date | number} timestamp ISO-8601 UTC string
 * @param {string | null | undefined} timeZone IANA zone name; null or empty means UTC
 * @returns {string} `YYYY-MM-DD`
 */
export const localDay = (timestamp, timeZone) => {
  if (!timeZone) return utcStamp(timestamp).slice(0, 10);
  const wall = wallClock(timestamp, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
};

/**
 * The clock hour a timestamp falls in, in a zone.
 * @param {string | Date | number} timestamp ISO-8601 UTC string
 * @param {string | null | undefined} timeZone IANA zone name; null or empty means UTC
 * @returns {string} `YYYY-MM-DD HH:00`
 */
export const localHour = (timestamp, timeZone) => {
  if (!timeZone) return `${utcStamp(timestamp).slice(0, 13).replace("T", " ")}:00`;
  const wall = wallClock(timestamp, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(
    2,
    "0",
  )} ${String(wall.hour).padStart(2, "0")}:00`;
};

/**
 * The first UTC instant that counts as a given local day, in a zone.
 *
 * Range filters and zero-fill need a start boundary. Binary search, not a lookup table:
 * a zone's offset at a given instant is what `Intl` answers, and the search only asks
 * "which local day is this instant in", which is monotonic in time. This also lands
 * correctly on zones where daylight time deletes midnight - the first instant of the day
 * is the first instant that exists.
 *
 * @param {string} dayString `YYYY-MM-DD` in the local zone
 * @param {string | null | undefined} timeZone IANA zone name; null means UTC
 * @returns {string} ISO-8601 UTC instant starting that local day
 */
export const localDayStart = (dayString, timeZone) => {
  if (!timeZone) return `${dayString}T00:00:00.000Z`;

  const guess = Date.parse(`${dayString}T00:00:00.000Z`);
  let low = guess - 15 * 86_400_000;
  let high = guess + 15 * 86_400_000;

  // Earliest minute where the local day is the requested one or later.
  while (low < high) {
    const mid = Math.floor((low + high) / 2 / 60_000) * 60_000;
    if (localDay(new Date(mid), timeZone) >= dayString) {
      high = mid;
    } else {
      low = mid + 60_000;
    }
  }

  return new Date(low).toISOString();
};

/**
 * The day after a `YYYY-MM-DD` string, as a calendar string.
 * @param {string} dayString `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`
 */
export const nextDayString = (dayString) => {
  const date = new Date(`${dayString}T12:00:00.000Z`);
  return new Date(date.getTime() + 86_400_000).toISOString().slice(0, 10);
};

/**
 * Offset from UTC at an instant, in minutes, the way a zone names it.
 *
 * `2026-10-28T22:00:00.000Z` in America/Denver during daylight time is 18:00 local, so the
 * offset is -240. In November it is -360.
 *
 * @param {string} timeZone IANA zone name
 * @param {Date} [when] Instant to measure, defaults to now
 * @returns {number} Minutes east of UTC, negative west of it
 */
export const utcOffsetMinutes = (timeZone, when = new Date()) => {
  const wall = wallClock(when, timeZone);
  const asUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const utcSeconds = Math.floor(when.getTime() / 1000) * 1000;
  return Math.round((asUTC - utcSeconds) / 60000);
};

/**
 * A zone's offset as the label a reader expects next to a chart.
 * @param {string | null | undefined} timeZone IANA zone name; null means UTC
 * @param {Date} [when] Instant to measure, defaults to now
 * @returns {string} "UTC", "UTC-6", "UTC-4:30", or "UTC+5:30"
 */
export const offsetLabel = (timeZone, when = new Date()) => {
  if (!timeZone) return "UTC";
  const minutes = utcOffsetMinutes(timeZone, when);
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hours = Math.trunc(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest > 0 ? `:${String(rest).padStart(2, "0")}` : ""}`;
};

/**
 * The calendar day count back from today, in a zone.
 *
 * Summary windows are "today, last 7 days, last 30 days". In a zone, today starts at
 * local midnight, not UTC midnight, so the window floor is a local day string.
 *
 * @param {number} dayCount Window length in days, 1 meaning today
 * @param {string | null | undefined} timeZone IANA zone name; null means UTC
 * @param {Date} [when] Instant to anchor "today", defaults to now
 * @returns {string} `YYYY-MM-DD`, the first day included in the window
 */
export const windowStartDay = (dayCount, timeZone, when = new Date()) => {
  const back = Math.trunc(dayCount) - 1;
  if (!timeZone) {
    const shifted = new Date(when.getTime() - back * 86_400_000);
    return shifted.toISOString().slice(0, 10);
  }
  // Step whole days back on the wall clock, so a 7-day window covers 7 local days.
  const anchor = new Date(when.getTime() - back * 86_400_000);
  return localDay(anchor, timeZone);
};

/**
 * Today's date in a zone.
 * @param {string | null | undefined} timeZone IANA zone name; null means UTC
 * @param {Date} [when] Instant to anchor "today", defaults to now
 * @returns {string} `YYYY-MM-DD`
 */
export const todayInZone = (timeZone, when = new Date()) => windowStartDay(1, timeZone, when);
