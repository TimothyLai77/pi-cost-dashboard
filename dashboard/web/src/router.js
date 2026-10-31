/**
 * A two-page router for the dashboard.
 *
 * The app has two pages — the ledger and the lifetime board — and they are served by one
 * Express process, so a router is mostly the browser's own history API:
 *
 * - `pushState` changes the URL and the rendered page without a reload.
 * - Back and forward fire `popstate`, which re-renders for the URL the history landed on.
 * - A deep link (`/lifetime` typed in, or a bookmark) is a real request. Express answers every
 *   non-`/api/` path with `index.html` (see `server/index.js`), and Vite's dev server does the
 *   same for the dev workflow, so the URL survives a reload without any server-side route.
 *
 * Two routes do not justify a routing library, and a dependency would have to be approved
 * first, so this is a `popstate` listener plus one state value.
 */

import { useCallback, useEffect, useState } from "react";

/**
 * The pages, in the order they appear in the nav.
 * `label` is the word on the tab; `blurb` is what the masthead says about the page.
 * @type {{ path: string, label: string, blurb: string }[]}
 */
export const ROUTES = [
  { path: "/", label: "Ledger", blurb: "What the agents cost, by day, project, and model." },
  { path: "/lifetime", label: "Lifetime", blurb: "The whole ledger as totals, streaks, and records." },
];

/**
 * Which page a pathname means.
 *
 * A trailing slash is the same page, and anything the router does not know renders the ledger,
 * which is the same thing the server's catch-all does for an unknown path.
 *
 * @param {string} pathname e.g. "/lifetime", "/lifetime/", "/"
 * @returns {string} One of the ROUTES paths
 */
export const normalizePath = (pathname) => {
  const trimmed = (pathname ?? "/").replace(/\/+$/, "") || "/";
  const lastSegment = `/${trimmed.split("/").filter(Boolean).pop() ?? ""}`;
  return ROUTES.some((route) => route.path === lastSegment) ? lastSegment : "/";
};

/**
 * The current page, and a navigate that keeps the history API honest.
 *
 * @returns {{ path: string, navigate: (path: string) => void, routes: typeof ROUTES }}
 */
export const useRoute = () => {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));

  // Back and forward change the URL on their own, so the page has to follow them.
  useEffect(() => {
    const onPopState = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((target) => {
    const next = normalizePath(target);
    if (next === normalizePath(window.location.pathname)) return;
    window.history.pushState({ path: next }, "", next);
    // Two pages have very different heights. Leaving a page at its scroll position lands the
    // new page in its middle, which is what a tab click should never do.
    window.scrollTo(0, 0);
    setPath(next);
  }, []);

  return { path, navigate, routes: ROUTES };
};
