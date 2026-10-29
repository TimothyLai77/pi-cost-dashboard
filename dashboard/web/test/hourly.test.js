/**
 * Unit tests for the hourly drill-down cache.
 *
 * The cache is what makes the drill-down swap instant, and its failure modes are the ones a
 * reader feels as wrong data: serving a day that was fetched under a different filter set,
 * replaying a failed request forever, re-fetching a day on every hover, and evicting the day
 * currently on screen.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHourlyCache } from "../src/hourly.js";

/**
 * A fetcher that counts calls per day and resolves with a payload.
 * @param {{ fail?: string[] }} [options] Days whose request should reject
 * @returns {{ fetchDay: (day: string) => Promise<any>, calls: Map<string, number>, settled: Promise<void>[] }}
 */
const recorder = ({ fail = [] } = {}) => {
  /** @type {Map<string, number>} */
  const calls = new Map();
  /** @type {Promise<void>[]} */
  const settled = [];

  const fetchDay = (day) => {
    calls.set(day, (calls.get(day) ?? 0) + 1);
    const work = Promise.resolve().then(() => {
      if (fail.includes(day)) throw new Error(`500: ${day} exploded`);
      return { day, points: [{ day, costMicros: day.length * 1000 }] };
    });
    settled.push(work.catch(() => {}));
    return work;
  };

  return { fetchDay, calls, settled };
};

test("a day is fetched once and reused for every later call", async () => {
  const { fetchDay, calls, settled } = recorder();
  const cache = createHourlyCache(fetchDay);

  const first = await cache.load("2026-10-28");
  const second = await cache.load("2026-10-28");

  assert.deepEqual(first, second);
  assert.equal(calls.get("2026-10-28"), 1);
  assert.equal(cache.size(), 1);
  await Promise.all(settled);
});

test("peek returns the resolved payload without awaiting", async () => {
  const cache = createHourlyCache(recorder().fetchDay);

  assert.equal(cache.peek("2026-10-27"), null);
  await cache.load("2026-10-27");
  assert.equal(cache.peek("2026-10-27").day, "2026-10-27");
  // An in-flight request has no value yet, so a click still shows the loading state.
  assert.equal(cache.peek("2026-10-26"), null);
  cache.load("2026-10-26");
  assert.equal(cache.peek("2026-10-26"), null);
  await cache.load("2026-10-26");
  assert.equal(cache.peek("2026-10-26").day, "2026-10-26");
});

test("a failed day is dropped, so the next attempt asks again", async () => {
  const { fetchDay, calls, settled } = recorder({ fail: ["2026-10-28"] });
  const cache = createHourlyCache(fetchDay);

  await assert.rejects(() => cache.load("2026-10-28"), /exploded/);
  assert.equal(cache.has("2026-10-28"), false);

  const retry = await cache.load("2026-10-28").catch(() => "failed again");
  assert.equal(calls.get("2026-10-28"), 2);
  if (retry !== "failed again") assert.equal(retry.day, "2026-10-28");
  await Promise.all(settled);
});

test("eviction drops the least recently used day and never the one in use", async () => {
  const cache = createHourlyCache(recorder().fetchDay, { limit: 3 });

  for (const day of ["2026-10-21", "2026-10-22", "2026-10-23"]) {
    await cache.load(day);
  }
  assert.equal(cache.size(), 3);

  // Touching the oldest day makes the next insertion drop a different one.
  await cache.load("2026-10-21");
  await cache.load("2026-10-24");

  assert.equal(cache.size(), 3);
  assert.equal(cache.has("2026-10-21"), true, "the day just read must survive eviction");
  assert.equal(cache.has("2026-10-22"), false, "the least recently used day is the one dropped");
  assert.equal(cache.has("2026-10-24"), true);
});

test("clear drops everything, which is what a filter change needs", async () => {
  const cache = createHourlyCache(recorder().fetchDay);

  await cache.load("2026-10-27");
  assert.equal(cache.size(), 1);

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.peek("2026-10-27"), null);
  assert.equal(cache.has("2026-10-27"), false);
});
