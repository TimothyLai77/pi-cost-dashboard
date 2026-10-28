/**
 * Unit tests for the theme preference logic.
 *
 * The theme module touches three browser globals, so each test installs the smallest
 * stub that answers them: matchMedia, localStorage, and documentElement. React is
 * imported by the module for the hook, which these tests never call.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Install stubs for the globals the theme module reads.
 * @param {{ prefersDark?: boolean, stored?: string | null, storageThrows?: boolean }} options
 * @returns {{ html: object, applied: string[] }} The stubbed <html> element and applied modes
 */
const installEnvironment = ({ prefersDark = false, stored = null, storageThrows = false }) => {
  const html = { dataset: {}, style: {} };
  const store = new Map(stored === null ? [] : [["pi-cost-theme", stored]]);

  globalThis.window = {
    matchMedia: (query) => ({
      matches: query.includes("dark") ? prefersDark : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  };

  globalThis.localStorage = {
    getItem: (key) => {
      if (storageThrows) throw new Error("blocked");
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (storageThrows) throw new Error("blocked");
      store.set(key, value);
    },
  };

  globalThis.document = { documentElement: html };
  return { html };
};

/**
 * Load a fresh copy of the module against the installed stubs.
 * @returns {Promise<object>}
 */
const loadTheme = async () => {
  const query = `../src/theme.js?case=${Math.random().toString(36).slice(2)}`;
  return import(query);
};

test("auto follows the operating system, in both directions", async () => {
  installEnvironment({ prefersDark: false });
  let theme = await loadTheme();
  assert.equal(theme.resolveMode("auto"), "light");

  installEnvironment({ prefersDark: true });
  theme = await loadTheme();
  assert.equal(theme.resolveMode("auto"), "dark");
});

test("light and dark are pinned and ignore the operating system", async () => {
  installEnvironment({ prefersDark: true });
  const theme = await loadTheme();

  assert.equal(theme.resolveMode("light"), "light");
  assert.equal(theme.resolveMode("dark"), "dark");
});

test("a missing or unusable stored value falls back to auto", async () => {
  installEnvironment({ stored: null });
  let theme = await loadTheme();
  assert.equal(theme.readPreference(), "auto");

  installEnvironment({ stored: "nonsense" });
  theme = await loadTheme();
  assert.equal(theme.readPreference(), "auto", "an unknown value is not a theme");

  installEnvironment({ stored: "dark", storageThrows: true });
  theme = await loadTheme();
  assert.equal(theme.readPreference(), "auto", "blocked storage is not a crash");
});

test("applying a preference writes the attribute and the native color scheme", async () => {
  const { html } = installEnvironment({ prefersDark: false, stored: "auto" });
  const theme = await loadTheme();

  assert.equal(theme.applyTheme("dark"), "dark");
  assert.equal(html.dataset.theme, "dark");
  assert.equal(html.style.colorScheme, "dark");

  assert.equal(theme.applyTheme("auto"), "light");
  assert.equal(html.dataset.theme, "light");
});

test("a stored choice survives a page load", async () => {
  installEnvironment({ prefersDark: false, stored: "dark" });
  const theme = await loadTheme();

  const { html } = installEnvironment({ prefersDark: false, stored: "dark" });
  assert.equal(theme.readPreference(), "dark");
  assert.equal(theme.applyTheme(theme.readPreference()), "dark");
  assert.equal(html.dataset.theme, "dark");
});

test("a stored choice is kept, and an unrecognizable one falls back to auto on read", async () => {
  installEnvironment({ prefersDark: false });
  const theme = await loadTheme();

  theme.writePreference("dark");
  assert.equal(globalThis.localStorage.getItem("pi-cost-theme"), "dark");

  theme.writePreference("garbage");
  assert.equal(globalThis.localStorage.getItem("pi-cost-theme"), "garbage");
  assert.equal(theme.readPreference(), "auto", "the reader refuses it, so the page falls back");
});
