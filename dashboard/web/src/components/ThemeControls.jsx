/**
 * The light / dark / auto control, shared by both pages.
 *
 * It sits in the masthead of the ledger and of the lifetime page alike, so the control is
 * written once here rather than twice in two mastheads. The theme state itself lives in
 * `theme.js`; this is only its three buttons.
 */

import { PREFERENCES } from "../theme.js";

/** What each theme setting does, in the words shown on the control. @type {Record<string, string>} */
const THEME_LABELS = { auto: "Auto", light: "Light", dark: "Dark" };

/** Why each theme setting exists, as the hover and accessibility description. */
const THEME_HINTS = {
  auto: "Follow the operating system's light or dark appearance, and keep following it",
  light: "Always use the light ledger palette",
  dark: "Always use the dark slate palette",
};

/**
 * @param {{ theme: { preference: string, choose: (preference: string) => void } }} props
 *   `theme` is the value `useTheme()` returns
 * @returns {JSX.Element}
 */
export const ThemeControls = ({ theme }) => (
  <span className="theme-set" role="group" aria-label="Color theme">
    {PREFERENCES.map((option) => (
      <button
        key={option}
        type="button"
        title={THEME_HINTS[option]}
        aria-pressed={theme.preference === option}
        onClick={() => theme.choose(option)}
      >
        {THEME_LABELS[option]}
      </button>
    ))}
  </span>
);
