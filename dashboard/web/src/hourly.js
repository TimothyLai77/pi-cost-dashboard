/**
 * Hourly drill-down data with prefetch.
 *
 * Clicking a day in the daily chart asks for that day's 24 hours. Waiting for that request
 * is what made the chart swap flash: the daily chart had to leave the screen to make room for
 * a "Loading hours…" line. With a cache, the request can start while the pointer is still over
 * the bar (or before, for the recent days), so the click is served from memory and the chart
 * can stay put and cross-fade.
 *
 * The cache is keyed by day plus every filter that changes the answer, and it is rebuilt
 * whenever those filters change, so a cached day can never be served under a different
 * project, provider, subagent setting, or refresh tick.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getJson } from "./api.js";

/** Days kept warm in the cache. Beyond that the oldest entries are dropped. */
const CACHE_LIMIT = 64;

/**
 * A small promise cache with a size cap.
 *
 * Map insertion order is used as the eviction order, so the day you looked at longest ago is
 * the first one dropped. An entry whose request fails is removed, which lets the next attempt
 * try again instead of replaying the same failure.
 *
 * @param {(day: string) => Promise<any>} fetchDay Loads one day of hourly data
 * @param {{ limit?: number }} [options]
 * @returns {{ load: (day: string) => Promise<any>, peek: (day: string) => any | null, has: (day: string) => boolean, clear: () => void, size: () => number }}
 */
export const createHourlyCache = (fetchDay, { limit = CACHE_LIMIT } = {}) => {
  /** @type {Map<string, { promise: Promise<any>, value: any | null }>} */
  const entries = new Map();

  /**
   * @param {string} day
   * @returns {{ promise: Promise<any>, value: any | null }}
   */
  const entryFor = (day) => {
    const existing = entries.get(day);
    if (existing) {
      // Touch the entry so a day in use is not the next one evicted.
      entries.delete(day);
      entries.set(day, existing);
      return existing;
    }

    const entry = { value: null, promise: null };
    entry.promise = fetchDay(day)
      .then((value) => {
        entry.value = value;
        return value;
      })
      .catch((error) => {
        entries.delete(day);
        throw error;
      });
    entries.set(day, entry);

    while (entries.size > limit) {
      entries.delete(entries.keys().next().value);
    }
    return entry;
  };

  return {
    load: (day) => entryFor(day).promise,
    peek: (day) => entries.get(day)?.value ?? null,
    has: (day) => entries.has(day),
    clear: () => entries.clear(),
    size: () => entries.size,
  };
};

/**
 * Hourly data for the drilled day, plus a prefetch you can call ahead of the click.
 *
 * `data` is the drilled day's payload, or the last one you were shown while a new one is on
 * its way, which is what lets the chart cross-fade instead of disappearing. `loading` is true
 * only when there is nothing to draw yet.
 *
 * @param {string | null} day Day to drill into, or null for the daily view
 * @param {object} params Filters for the request; changes rebuild the cache
 * @returns {{ data: any | null, loading: boolean, refreshing: boolean, error: string | null, prefetch: (day: string) => void, prefetchMany: (days: string[]) => void }}
 */
export const useHourlyDrill = (day, params = {}) => {
  const key = JSON.stringify(params);
  // A new filters/refresh key means a new cache: the old answers do not apply to them.
  const cache = useMemo(
    () => createHourlyCache((target) => getJson("/api/hourly", { day: target, ...JSON.parse(key) })),
    [key],
  );

  const [state, setState] = useState({ day: null, data: null, error: null, fetching: false });
  // The day currently displayed, so a click on a new day can keep showing the old bars
  // while the new ones arrive.
  const shownDay = useRef(null);

  useEffect(() => {
    if (!day) {
      shownDay.current = null;
      setState({ day: null, data: null, error: null, fetching: false });
      return undefined;
    }

    const cached = cache.peek(day);
    if (cached) {
      shownDay.current = day;
      setState({ day, data: cached, error: null, fetching: false });
      return undefined;
    }

    let active = true;
    setState((current) => ({
      day,
      data: current.data,
      error: null,
      fetching: shownDay.current !== day,
    }));

    cache
      .load(day)
      .then((data) => {
        if (!active) return;
        shownDay.current = day;
        setState({ day, data, error: null, fetching: false });
      })
      .catch((error) => {
        if (!active) return;
        setState({ day, data: null, error: error.message, fetching: false });
      });

    return () => {
      active = false;
    };
  }, [day, cache]);

  const prefetch = useCallback(
    (target) => {
      if (!target || cache.has(target)) return;
      // Prefetch is best effort: a failure just means the click will fetch for real.
      cache.load(target).catch(() => {});
    },
    [cache],
  );

  const prefetchMany = useCallback(
    (days) => {
      (days ?? []).slice(0, CACHE_LIMIT).forEach(prefetch);
    },
    [prefetch],
  );

  return {
    data: state.data,
    // Nothing on screen for this day yet, so the panel should say a request is running.
    loading: state.fetching && state.data === null,
    // Bars are already on screen and a newer answer for the same day is on its way.
    refreshing: state.fetching && state.data !== null,
    error: state.error,
    prefetch,
    prefetchMany,
  };
};
