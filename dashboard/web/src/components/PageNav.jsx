/**
 * The tab strip that switches between the app's pages: the phone layout's copy of the nav.
 *
 * On a desktop the page switcher is in the app rail (`AppRail.jsx`), which stays on screen while
 * the ledger scrolls. Below the 40rem breakpoint the rail is off screen, so the masthead keeps
 * this strip; a `compactNav` flag in `App.jsx` decides which one renders, and only one is ever
 * on screen at a time.
 *
 * It is a group of buttons, not links: the pages swap in place, and a link would advertise a
 * navigation a keyboard or touch-typing user cannot take (there is no href to copy). The
 * buttons reuse the segmented-control styling the range and metric toggles already use, so
 * "Ledger / Lifetime" reads as the same kind of control as "30d / 90d / 1y / all".
 */

import { ROUTES } from "../router.js";

/**
 * @param {{ path: string, navigate: (path: string) => void }} props
 *   `path` is the active route, `navigate` switches to one
 * @returns {JSX.Element}
 */
export const PageNav = ({ path, navigate }) => (
  <nav className="range-set page-nav" aria-label="Page">
    {ROUTES.map((route) => (
      <button
        key={route.path}
        type="button"
        aria-pressed={route.path === path}
        title={route.blurb}
        onClick={() => navigate(route.path)}
      >
        {route.label}
      </button>
    ))}
  </nav>
);
