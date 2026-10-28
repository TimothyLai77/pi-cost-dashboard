/**
 * API access for the dashboard.
 *
 * All paths are relative so the same code works behind the vite dev proxy and when
 * Express serves the built app from the same origin.
 */

import { useCallback, useEffect, useState } from "react";

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
 * Returns a null data value while loading, so callers render an explicit loading state
 * instead of an empty chart. Pass a null path to skip fetching.
 *
 * @param {string | null} path Relative API path, or null to fetch nothing
 * @param {object} [params] Query parameters; changes re-run the request
 * @returns {{ data: any | null, loading: boolean, error: string | null, reload: () => void }}
 */
export const useApi = (path, params = {}) => {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ data: null, loading: Boolean(path), error: null });

  const load = useCallback(async () => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await getJson(path, JSON.parse(key));
      setState({ data, loading: false, error: null });
    } catch (error) {
      setState({ data: null, loading: false, error: error.message });
    }
  }, [path, key]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
};

/**
 * Format an integer token count compactly, matching how the footer reports it.
 * @param {number} tokens
 * @returns {string}
 */
export const formatTokens = (tokens) => {
  const value = Number(tokens) || 0;
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
 * Shorten a project path to its last segment, which is what identifies it to a person.
 * @param {string | null} cwd
 * @returns {string}
 */
export const shortProject = (cwd) => {
  if (!cwd) return "unknown project";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
};
