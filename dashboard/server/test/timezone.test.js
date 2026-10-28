/**
 * Unit tests for timezone bucketing.
 *
 * The point of these tests is daylight time: a fixed minute offset gets the same
 * timestamps wrong before and after a transition, so the tests straddle the 2026 US
 * transitions (March 8 and November 1).
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isSupportedTimeZone,
  localDay,
  localDayStart,
  nextDayString,
  localHour,
  offsetLabel,
  todayInZone,
  utcOffsetMinutes,
  windowStartDay,
} from "../timezone.js";

test("an unsupported zone name is rejected, not guessed", () => {
  assert.equal(isSupportedTimeZone("America/Denver"), true);
  assert.equal(isSupportedTimeZone("UTC"), true);
  assert.equal(isSupportedTimeZone("Asia/Kolkata"), true);
  assert.equal(isSupportedTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isSupportedTimeZone(""), false);
  assert.equal(isSupportedTimeZone(undefined), false);
});

test("localDay moves a timestamp across a day boundary the way a wall clock does", () => {
  // 06:00Z is 23:00 the previous day in Denver (UTC-7).
  assert.equal(localDay("2026-01-15T06:00:00.000Z", "America/Denver"), "2026-01-14");
  assert.equal(localDay("2026-01-15T06:00:00.000Z", "UTC"), "2026-01-15");
  // No zone means the stored UTC day.
  assert.equal(localDay("2026-01-15T06:00:00.000Z", null), "2026-01-15");
  // Half-hour and 45-minute offsets resolve too.
  assert.equal(localDay("2026-01-15T19:00:00.000Z", "Asia/Kolkata"), "2026-01-16");
  assert.equal(localDay("2026-01-15T09:00:00.000Z", "Asia/Kathmandu"), "2026-01-15");
});

test("a day boundary lands on the local side of a DST transition", () => {
  // Denver is UTC-7 up to 2026-03-08 09:00Z, then UTC-6.
  assert.equal(utcOffsetMinutes("America/Denver", new Date("2026-03-08T08:00:00.000Z")), -420);
  assert.equal(utcOffsetMinutes("America/Denver", new Date("2026-03-08T10:00:00.000Z")), -360);

  // A fixed -420 offset would call 2026-03-09T05:30Z "23:30 on Mar 8" only after the
  // transition, and a fixed -420 applied to 2026-03-08T06:00Z would say Mar 7 23:00 too.
  // Both timestamps are read at their own instant here: Mar 7 in MST, Mar 8 in MDT.
  assert.equal(localDay("2026-03-08T06:00:00.000Z", "America/Denver"), "2026-03-07");
  assert.equal(localDay("2026-03-08T06:00:00.000Z", "Etc/GMT+6"), "2026-03-08");
  assert.equal(localDay("2026-03-09T05:30:00.000Z", "America/Denver"), "2026-03-08");
  assert.equal(localHour("2026-03-09T05:30:00.000Z", "America/Denver"), "2026-03-08 23:00");
});

test("localHour labels the hour a reader would write down", () => {
  assert.equal(localHour("2026-07-04T01:30:00.000Z", "America/Denver"), "2026-07-03 19:00");
  assert.equal(localHour("2026-07-04T01:30:00.000Z", "UTC"), "2026-07-04 01:00");
  assert.equal(localHour("2026-07-04T01:30:00.000Z", "Asia/Kolkata"), "2026-07-04 07:00");
});

test("offset labels read the way people name their zone", () => {
  assert.equal(offsetLabel(null), "UTC");
  assert.equal(offsetLabel("UTC"), "UTC");
  assert.equal(offsetLabel("America/Denver", new Date("2026-01-15T00:00:00.000Z")), "UTC-7");
  assert.equal(offsetLabel("America/Denver", new Date("2026-07-15T00:00:00.000Z")), "UTC-6");
  assert.equal(offsetLabel("Asia/Kolkata", new Date("2026-07-15T00:00:00.000Z")), "UTC+5:30");
  assert.equal(offsetLabel("Australia/Eucla", new Date("2026-07-15T00:00:00.000Z")), "UTC+8:45");
});

test("summary windows start on a local day, not a UTC day", () => {
  const atNoonUTC = new Date("2026-01-15T12:00:00.000Z");

  // In Denver it is 05:00 on the 15th, so "today" is the 15th and a 7-day window starts on the 9th.
  assert.equal(todayInZone("America/Denver", atNoonUTC), "2026-01-15");
  assert.equal(windowStartDay(7, "America/Denver", atNoonUTC), "2026-01-09");

  // At 04:00Z it is still the 14th in Denver: today is the 14th.
  const atFourUTC = new Date("2026-01-15T04:00:00.000Z");
  assert.equal(todayInZone("America/Denver", atFourUTC), "2026-01-14");
  assert.equal(todayInZone("UTC", atFourUTC), "2026-01-15");

  // A one-day window is today, and UTC keeps the ISO date it already has.
  assert.equal(windowStartDay(1, "America/Denver", atNoonUTC), "2026-01-15");
  assert.equal(windowStartDay(30, null, atNoonUTC), "2025-12-17");
});

test("localDayStart finds the first instant of a local day, DST included", () => {
  // Denver midnight on the 15th is 07:00Z in winter (UTC-7) and 06:00Z in summer (UTC-6).
  assert.equal(localDayStart("2026-01-15", "America/Denver"), "2026-01-15T07:00:00.000Z");
  assert.equal(localDayStart("2026-07-15", "America/Denver"), "2026-07-15T06:00:00.000Z");
  assert.equal(localDayStart("2026-01-15", "UTC"), "2026-01-15T00:00:00.000Z");
  assert.equal(localDayStart("2026-01-15", null), "2026-01-15T00:00:00.000Z");
  // Half-hour and 45-minute zones land on their own boundaries.
  assert.equal(localDayStart("2026-01-15", "Asia/Kolkata"), "2026-01-14T18:30:00.000Z");
  assert.equal(localDayStart("2026-01-15", "Asia/Kathmandu"), "2026-01-14T18:15:00.000Z");
  // The boundary is exactly the instant the local day begins.
  assert.equal(localDay(localDayStart("2026-03-08", "America/Denver"), "America/Denver"), "2026-03-08");
});

test("nextDayString walks the calendar", () => {
  assert.equal(nextDayString("2026-01-15"), "2026-01-16");
  assert.equal(nextDayString("2026-12-31"), "2027-01-01");
  assert.equal(nextDayString("2024-02-28"), "2024-02-29");
});
