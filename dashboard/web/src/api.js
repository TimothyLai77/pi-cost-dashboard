/**
 * API access for the dashboard.
 *
 * All paths are relative so the same code works behind the vite dev proxy and when
 * Express serves the built app from the same origin.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * GET a JSON path, throwing a readable error when the server reports one.
 * @param {string} path Relative API path
 * @param {object} [params] Query parameters; null and undefined values are dropped
 * @returns {Promise<any>} Parsed JSON body
 */
export const getJson = async (path, params = {}) => {
  const query = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  const url = query.length > 0 ? `${path}?${query}` : path;

  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = body.detail ?? body.error ?? response.statusText;
    const problem = body.parameter ? `${detail} (${body.parameter})` : detail;
    throw new Error(`${response.status}: ${problem}`);
  }
  return body;
};

/**
 * Fetch an endpoint and keep its result in state.
 *
 * Stale-while-revalidate: a refetch keeps the previous result on screen and reports
 * `refreshing` rather than clearing `data`. Auto-refresh runs every 30s, and clearing the
 * data made the chart, model list, and table swap out for one-line loading messages and
 * swap back when the response landed — the whole page collapsed and re-expanded twice a
 * minute. `loading` is now true only when there is nothing to show yet, so a loading state
 * means first paint, not a refresh.
 *
 * A failed refresh keeps the last good data and reports the error the same way, so a
 * transient network blip does not blank a working page.
 *
 * @param {string | null} path Relative API path, or null to fetch nothing
 * @param {object} [params] Query parameters; changes re-run the request
 * @returns {{ data: any | null, loading: boolean, refreshing: boolean, error: string | null, reload: () => void }}
 */
export const useApi = (path, params = {}) => {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ data: null, fetching: Boolean(path), error: null });
  // Responses can arrive out of order. Only the newest request may write to state.
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    if (!path) {
      setState({ data: null, fetching: false, error: null });
      return;
    }
    setState((current) => ({ ...current, fetching: true }));
    try {
      const data = await getJson(path, JSON.parse(key));
      if (id !== requestId.current) return;
      setState({ data, fetching: false, error: null });
    } catch (error) {
      if (id !== requestId.current) return;
      setState((current) => ({ ...current, fetching: false, error: error.message }));
    }
  }, [path, key]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    data: state.data,
    loading: state.fetching && state.data === null,
    refreshing: state.fetching && state.data !== null,
    error: state.error,
    reload: load,
  };
};

/**
 * Format an integer token count compactly, matching how the footer reports it.
 *
 * Cache reads make token totals large: a month of heavy agent use runs into hundreds of
 * millions and all-time passes a billion, so the scale runs k → M → B. Without the billions
 * branch a 1.2 billion-token total rendered as "1228M".
 *
 * @param {number} tokens
 * @returns {string} e.g. "812", "1.5k", "466k", "117M", "1.2B"
 */
export const formatTokens = (tokens) => {
  const value = Number(tokens) || 0;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
};

/**
 * Format a micro-dollar amount as dollars.
 * @param {number} costMicros Integer micro-US dollars
 * @param {number} [digits] Fraction digits; small amounts need more to stay readable
 * @returns {string}
 */
export const formatCost = (costMicros, digits = 2) =>
  `$${(Number(costMicros || 0) / 1e6).toFixed(digits)}`;

/**
 * Format a micro-dollar amount with the precision that amount needs.
 *
 * A call billed under a cent reads as "$0.00" at two digits, which is indistinguishable
 * from a call that billed nothing, so anything under 10 000 micro-dollars ($0.01) is
 * written with four. Zero keeps two digits: a locally hosted model priced at zero should
 * say "$0.00", not "$0.0000".
 *
 * Every place on the page that shows a cost figure goes through here, so a chart tooltip,
 * a ledger row and a table cell cannot drift apart on the rounding rule.
 *
 * @param {number} costMicros Integer micro-US dollars
 * @returns {string} e.g. "$13.73", "$0.0042", "$0.00"
 */
export const formatCostSmart = (costMicros) => {
  const micros = Number(costMicros) || 0;
  return formatCost(micros, micros > 0 && micros < 10_000 ? 4 : 2);
};

/**
 * The four token kinds behind a total, in the order they dominate a bill.
 *
 * `totalTokens` is the sum of these four, and cache reads are the overwhelming majority of
 * it: every model call re-reports the cached prefix it read. A session that cost $13.73 can
 * show 113M tokens of which 112M are cache reads, so the bare total is not comparable to the
 * cost and the split is what makes the number readable.
 *
 * Cache write is left out when it is zero, which is the common case, so the line stays short
 * for the rows people actually read.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number } | null | undefined} row
 *   Anything carrying the four token counts; missing ones read as zero
 * @returns {string} e.g. "cache read 112M · in 415k · out 466k"
 */
export const tokenKinds = (row) =>
  [
    `cache read ${formatTokens(row?.cacheReadTokens ?? 0)}`,
    `in ${formatTokens(row?.inputTokens ?? 0)}`,
    `out ${formatTokens(row?.outputTokens ?? 0)}`,
    ...(row?.cacheWriteTokens > 0 ? [`cache write ${formatTokens(row.cacheWriteTokens)}`] : []),
  ].join(" · ");

/**
 * Shorten a project path to its last segment, which is what identifies it to a person.
 * @param {string | null} cwd
 * @returns {string}
 */
export const shortProject = (cwd) => {
  if (!cwd) return "unknown project";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
};
