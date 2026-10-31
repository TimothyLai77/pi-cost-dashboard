/**
 * The app rail: the page switcher and the theme control, in a column that stays on screen.
 *
 * The two pages used to carry a Ledger / Lifetime tab strip in their mastheads. With a rail,
 * the control is in one place for both pages, and the mastheads are left with their own title
 * and status line.
 *
 * Two widths. Expanded (>= 90rem of viewport, i.e. 1440px) the rail is 12rem and shows words.
 * Narrower, or after the reader collapses it, the rail is 3.5rem and shows only the glyphs -
 * which is why the glyphs are the ledger table and the cumulative line, not decoration: the
 * collapsed rail says the same thing the expanded one does.
 *
 * Below the 40rem breakpoint the rail is off screen until the menu button opens it as a
 * drawer (see `App.jsx`, which owns the media queries and the open state).
 */

import { ROUTES } from "../router.js";
import { PREFERENCES } from "../theme.js";
import { ThemeControls } from "./ThemeControls.jsx";
import { IconAuto, IconChevron, IconClose, IconDark, IconLedger, IconLight, IconLifetime } from "./icons.jsx";

/**
 * The glyph for a theme setting.
 * @param {{ preference: "auto" | "light" | "dark" }} props
 * @returns {JSX.Element}
 */
const ThemeGlyph = ({ preference }) =>
  preference === "light" ? <IconLight /> : preference === "dark" ? <IconDark /> : <IconAuto />;

/** Words for the collapsed theme control, which has no label of its own. */
const THEME_NAMES = { auto: "Auto", light: "Light", dark: "Dark" };

/**
 * The theme control as one cycling button, for the collapsed rail where three buttons stacked
 * vertically do not fit. Activating it moves to the next setting in the same order the expanded
 * control lists them.
 * @param {{ theme: { preference: string, choose: (preference: string) => void } }} props
 * @returns {JSX.Element}
 */
const ThemeCycle = ({ theme }) => {
  const index = PREFERENCES.indexOf(theme.preference);
  const next = PREFERENCES[(index + 1) % PREFERENCES.length];
  const label = `Color theme: ${THEME_NAMES[theme.preference]}. Activate for ${THEME_NAMES[next]}.`;
  return (
    <button
      type="button"
      className="rail-theme-cycle"
      aria-label={label}
      title={label}
      onClick={() => theme.choose(next)}
    >
      <span className="rail-icon">
        <ThemeGlyph preference={theme.preference} />
      </span>
    </button>
  );
};

/**
 * @param {{
 *   path: string,
 *   navigate: (path: string) => void,
 *   theme: { preference: string, choose: (preference: string) => void },
 *   collapsed: boolean,
 *   onToggleCollapse: () => void,
 *   isPhone: boolean,
 *   onCloseDrawer?: () => void,
 * }} props
 * @returns {JSX.Element}
 */
export const AppRail = ({ path, navigate, theme, collapsed, onToggleCollapse, isPhone, onCloseDrawer }) => (
  <aside className="rail" data-collapsed={collapsed ? "true" : "false"}>
    <div className="rail-top">
      <span className="rail-brand">
        <span className="rail-mark" aria-hidden="true">
          π
        </span>
        <span className="rail-label">Pi spend</span>
      </span>
      {isPhone && (
        <button
          type="button"
          className="rail-close"
          aria-label="Close the menu"
          title="Close the menu"
          onClick={onCloseDrawer}
        >
          <span className="rail-icon">
            <IconClose />
          </span>
        </button>
      )}
    </div>

    <nav className="rail-nav" aria-label="Pages">
      {ROUTES.map((route) => (
        <button
          key={route.path}
          type="button"
          className="rail-link"
          aria-current={route.path === path ? "page" : undefined}
          aria-label={route.label}
          title={`${route.label} — ${route.blurb}`}
          onClick={() => {
            navigate(route.path);
            if (onCloseDrawer) onCloseDrawer();
          }}
        >
          <span className="rail-icon">
            {route.path === "/lifetime" ? <IconLifetime /> : <IconLedger />}
          </span>
          <span className="rail-label">{route.label}</span>
        </button>
      ))}
    </nav>

    <div className="rail-theme">{collapsed ? <ThemeCycle theme={theme} /> : <ThemeControls theme={theme} />}</div>

    <button
      type="button"
      className="rail-toggle"
      aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
      onClick={onToggleCollapse}
    >
      <span className="rail-icon">
        <IconChevron direction={collapsed ? "right" : "left"} />
      </span>
      <span className="rail-label">{collapsed ? "Expand" : "Collapse"}</span>
    </button>
  </aside>
);
