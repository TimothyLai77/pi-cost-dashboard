/**
 * Unit tests for the summary strip's money split.
 *
 * The strip draws a 100% stacked bar per window, so a share is a slice of that window's own
 * spend. Two failure modes these tests pin: shares that do not add up to the whole draw a
 * bar whose segments do not fill the track, and a window with no spend drawing four phantom
 * slivers instead of the empty track.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { COST_PARTS, costSplit, moneyBreakdown, partDollars } from "../src/components/costParts.js";

/** A breakdown shaped like the API sends it: four parts, micro-dollars plus a display string. */
const breakdown = ({ output = 0, input = 0, cacheRead = 0, cacheWrite = 0 }) => ({
  costBreakdown: {
    output: { costMicros: output, costUsd: `$${(output / 1e6).toFixed(2)}` },
    input: { costMicros: input, costUsd: `$${(input / 1e6).toFixed(2)}` },
    cacheRead: { costMicros: cacheRead, costUsd: `$${(cacheRead / 1e6).toFixed(2)}` },
    cacheWrite: { costMicros: cacheWrite, costUsd: `$${(cacheWrite / 1e6).toFixed(2)}` },
  },
});

test("the four shares add up to the whole window", () => {
  const split = costSplit(breakdown({ output: 1_000_000, input: 500_000, cacheRead: 500_000 }));
  const sum = split.parts.reduce((total, part) => total + part.share, 0);

  assert.equal(split.totalMicros, 2_000_000);
  assert.ok(Math.abs(sum - 100) < 1e-9, `shares summed to ${sum}`);
  assert.deepEqual(
    split.parts.map((part) => Math.round(part.share)),
    [50, 25, 25, 0],
  );
});

test("parts come back in bar order, each carrying its own hue", () => {
  const split = costSplit(breakdown({ output: 1, input: 2, cacheRead: 3, cacheWrite: 4 }));

  assert.deepEqual(
    split.parts.map((part) => part.key),
    COST_PARTS.map((part) => part.key),
  );
  for (const part of split.parts) {
    assert.match(part.color, /^var\(--cost-[a-z-]+\)$/);
  }
});

test("a window that spent nothing has four zero shares and says so plainly", () => {
  const split = costSplit(breakdown({}));

  assert.equal(split.totalMicros, 0);
  assert.deepEqual(
    split.parts.map((part) => part.share),
    [0, 0, 0, 0],
  );
  assert.equal(split.ariaLabel, "no spend");
});

test("the spoken label names only the parts that cost something", () => {
  const split = costSplit(breakdown({ output: 7_000_000, cacheRead: 3_000_000 }));

  assert.equal(split.ariaLabel, "out 70%, cache read 30%");
});

test("a missing display string is filled from micro-dollars, and a server without a split yields null", () => {
  const partial = costSplit({ costBreakdown: { output: { costMicros: 4_200 } } });
  assert.equal(partial.parts[0].costUsd, "$0.0042");
  assert.equal(partial.totalMicros, 4_200);

  assert.equal(costSplit({}), null, "a pre-v2 server sends no breakdown");
  assert.equal(costSplit(undefined), null);
});

test("the tooltip line and bar value agree with the split", () => {
  const point = breakdown({ output: 1_000_000, input: 250_000, cacheRead: 250_000 });

  assert.equal(moneyBreakdown(point), "out $1.00 · in $0.25 · cache read $0.25 · cache write $0.00");
  assert.equal(partDollars(point, "output"), 1);
  assert.equal(partDollars(point, "cacheWrite"), 0);
  assert.equal(partDollars({ costBreakdown: { output: { costMicros: 12_345_678 } } }, "output"), 12.3457);
});
