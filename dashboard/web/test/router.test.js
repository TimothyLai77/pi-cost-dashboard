/**
 * Unit tests for the router's path mapping.
 *
 * `useRoute` is a `popstate` listener and needs a window, so the testable part is
 * `normalizePath`: the function that decides which page a URL means, including the URLs a
 * person can type, bookmark, or end up with after a trailing slash.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROUTES, normalizePath } from "../src/router.js";

test("ROUTES lists the ledger first and names both pages", () => {
  assert.deepEqual(
    ROUTES.map((route) => route.path),
    ["/", "/lifetime"],
  );
  assert.deepEqual(
    ROUTES.map((route) => route.label),
    ["Ledger", "Lifetime"],
  );
  assert.equal(ROUTES.every((route) => route.blurb.length > 0), true, "every tab says what it is");
});

test("normalizePath maps a pathname onto one of the pages", () => {
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("/lifetime"), "/lifetime");
  assert.equal(normalizePath("/lifetime/"), "/lifetime", "a trailing slash is the same page");
  assert.equal(normalizePath(""), "/", "an empty pathname is the ledger");
  assert.equal(normalizePath(null), "/");
});

test("normalizePath falls back to the ledger for paths the app does not have", () => {
  // The server answers every non-/api path with index.html, so these land in the app and the
  // router has to pick a page for them. The ledger is the page that exists at any URL.
  assert.equal(normalizePath("/nope"), "/");
  assert.equal(normalizePath("/lifetime/extra"), "/", "the page is /lifetime, not a tree under it");
  assert.equal(normalizePath("/index.html"), "/");
});
