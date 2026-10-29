/**
 * Theme preference for the dashboard.
 *
 * Three settings, not two: "auto" follows the operating system and keeps following it,
 * "light" and "dark" pin the page. The setting is stored in localStorage; the effective
 * mode is written to `<html data-theme>`, which is the hook `styles.css` hangs its two
 * palettes on.
 *
 * The same logic runs as a small inline script in index.html before React loads, so
 * reloading in dark mode does not flash the light palette first.
 */

import { useCallback, useEffect, useState } from "react";

/** localStorage key holding the user's setting. @type {string} */
export const STORAGE_KEY = "pi-cost-theme";

/** Valid settings. `auto` is the default and means "follow the operating system". @type {string[]} */
export const PREFERENCES = ["auto", "light", "dark"];

/**
 * Whether the operating system currently asks for a dark appearance.
 * @returns {boolean}
 */
export const systemPrefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * Turn a setting into the palette to apply.
 * @param {string} preference One of PREFERENCES
 * @returns {"light" | "dark"}
 */
export const resolveMode = (preference) =>
  preference === "auto" ? (systemPrefersDark() ? "dark" : "light") : preference;

/**
 * Read the stored setting, falling back to auto when it is absent or unreadable
 * (private browsing blocks localStorage, which is not a reason to break the page).
 * @returns {string}
 */
export const readPreference = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.includes(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
};

/**
 * Persist the setting. Failures are ignored: a blocked localStorage means the choice
 * lasts for this page load only.
 * @param {string} preference
 * @returns {void}
 */
export const writePreference = (preference) => {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Nothing to do, and nothing worth showing the user.
  }
};

/**
 * Apply a setting to the document.
 *
 * `color-scheme` is set alongside the attribute so native form controls — the day,
 * project, and provider selects — render with the right palette instead of
 * borrowing the operating system's.
 *
 * @param {string} preference
 * @returns {"light" | "dark"} the mode that was applied
 */
export const applyTheme = (preference) => {
  const mode = resolveMode(preference);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  return mode;
};

/**
 * React-side theme state: the setting, the effective mode, and a setter that writes the
 * document and remembers the choice.
 *
 * While the setting is "auto", the operating system's changes are followed live, so
 * switching the OS to dark mode updates the dashboard without a reload.
 *
 * @returns {{ preference: string, mode: "light" | "dark", choose: (preference: string) => void }}
 */
export const useTheme = () => {
  const [preference, setPreference] = useState(readPreference);
  const [mode, setMode] = useState(() => applyTheme(readPreference()));

  useEffect(() => {
    setMode(applyTheme(preference));

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
      if (preference === "auto") setMode(applyTheme("auto"));
    };

    media.addEventListener("change", followSystem);
    return () => media.removeEventListener("change", followSystem);
  }, [preference]);

  const choose = useCallback((next) => {
    writePreference(next);
    setPreference(PREFERENCES.includes(next) ? next : "auto");
  }, []);

  return { preference, mode, choose };
};
