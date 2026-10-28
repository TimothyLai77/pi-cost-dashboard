/**
 * Unit tests for the compact number formatters in web/src/api.js.
 *
 * Cache reads make token totals huge: a day of agent use is hundreds of millions, and
 * all-time on this machine is past a billion. The scale therefore has to keep going past
 * millions — an all-time total was rendering as "1228M", which is what these tests pin.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatCost, formatTokens } from "../src/api.js";

test("formatTokens runs k → M → B and keeps about three significant digits", () => {
  const cases = [
    [0, "0"],
    [812, "812"],
    [1_000, "1.0k"],
    [1_500, "1.5k"],
    [9_999, "10.0k"],
    [12_300, "12k"],
    [466_226, "466k"],
    [999_999, "1000k"],
    [1_200_000, "1.2M"],
    [4_300_000, "4.3M"],
    [117_478_347, "117M"],
    [1_228_000_000, "1.2B"],
    [12_400_000_000, "12B"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(formatTokens(input), expected, `${input} renders as ${expected}`);
  }
});

test("formatTokens treats anything unreadable as zero", () => {
  // The API always sends integers; this guards the places that render a missing field.
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens(null), "0");
  assert.equal(formatTokens("not a number"), "0");
});

test("formatCost keeps micro-dollar integers readable at both scales", () => {
  assert.equal(formatCost(13_729_975), "$13.73");
  assert.equal(formatCost(0), "$0.00");
  // Sub-cent amounts round to nothing at two digits, which is why the UI asks for four.
  assert.equal(formatCost(600), "$0.00");
  assert.equal(formatCost(600, 4), "$0.0006");
});
