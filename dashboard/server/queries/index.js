/**
 * The read side of the dashboard API.
 *
 * One module per kind of answer, with `shared.js` underneath them all for the pieces no
 * single query owns: money shaping, the WHERE terms a request turns into SQL, the column
 * list every aggregate reads, and the bucket sums. The rules those helpers assume — UTC
 * timestamps, buckets resolved at each instant, money as integer micro-dollars next to a
 * display string — are written out there once.
 *
 * This file adds nothing. It is the one entry point the API layer and its tests import, so
 * a query can move between modules without either of them having to move.
 */

export { getSummary } from "./summary.js";
export { getDailyCost, getHourlyCost } from "./timeseries.js";
export { getSessions, getSessionById } from "./sessions.js";
export { getModelCost } from "./models.js";
export { getFlows } from "./flows.js";
export { getLifetimeStats } from "./lifetime.js";
export { getFilters, getHealth } from "./meta.js";

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./shared.js";
