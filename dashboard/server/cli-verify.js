#!/usr/bin/env node
/**
 * CLI: check the database against the session files it was built from.
 *
 * Three checks, each comparing the database against values recomputed straight from the
 * files, so a scanner bug shows up as a mismatch instead of quietly changing the
 * dashboard numbers.
 *
 *   1. session row count equals the number of session files
 *   2. grand total cost in the database equals the sum of freshly aggregated files
 *   3. stored rollup per session equals that session's stored facts
 *
 * It rescans first, from the same file state it measures against. A running Pi session
 * is appended to continuously, so a check that measured the database from an older scan
 * against a newer file read would report a difference that is only growth, not a bug.
 *
 * Usage:
 *   node server/cli-verify.js [--sessions-dir <dir>] [--no-rescan]
 */

import { openDatabase, migrateUp } from "./db.js";
import { aggregateSession, formatUsd } from "./scanner/aggregate.js";
import { listSessionFiles, resolveSessionsDir, scanSessions } from "./scanner/scan.js";

const args = process.argv.slice(2);
const flagIndex = args.indexOf("--sessions-dir");
const sessionsDir = resolveSessionsDir(
  flagIndex >= 0 ? args[flagIndex + 1] : process.env.PI_COST_SESSIONS_DIR,
);

const db = openDatabase();
migrateUp(db);

if (!args.includes("--no-rescan")) {
  const result = scanSessions(sessionsDir, db, { force: true });
  console.log(
    `rescan           ${result.scanned} parsed, ${result.updated} written, ${result.deleted} deleted, ${result.ms} ms`,
  );
}

const files = listSessionFiles(sessionsDir);
const freshTotals = files
  .map((filePath) => aggregateSession(filePath).session)
  .filter((session) => session.sessionId);

const stored = db
  .prepare("SELECT session_id, session_file, cost_micros, total_tokens FROM sessions")
  .all();
const storedById = new Map(stored.map((row) => [row.session_id, row]));

console.log(`files found      ${files.length}`);
console.log(`files parsed     ${freshTotals.length}  (files without a session header are not sessions)`);
console.log(`database rows    ${stored.length}`);
const countOk = freshTotals.length === stored.length;
console.log(`count check      ${countOk ? "OK" : "MISMATCH"}`);

const freshMicros = freshTotals.reduce((sum, session) => sum + session.costMicros, 0);
const storedMicros = stored.reduce((sum, row) => sum + row.cost_micros, 0);
console.log(`cost from files  ${formatUsd(freshMicros)} (${freshMicros} micros)`);
console.log(`cost in database ${formatUsd(storedMicros)} (${storedMicros} micros)`);
const costOk = freshMicros === storedMicros;
console.log(`cost check       ${costOk ? "OK" : "MISMATCH"}`);

/**
 * Sum of stored facts for one session. A session with no usage facts has no row from
 * GROUP BY, which means zero, not missing data.
 * @type {Map<string, {cost_micros: number, total_tokens: number}>}
 */
const factById = new Map(
  db
    .prepare(
      `SELECT session_id, COALESCE(SUM(cost_micros), 0) AS cost_micros,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM usage_events GROUP BY session_id`,
    )
    .all()
    .map((row) => [row.session_id, row]),
);

const zeroFactSessions = db
  .prepare("SELECT COUNT(*) AS n FROM sessions WHERE session_id NOT IN (SELECT session_id FROM usage_events)")
  .get().n;

let factsMismatched = 0;
const examples = [];
for (const session of freshTotals) {
  const facts = factById.get(session.sessionId) ?? { cost_micros: 0, total_tokens: 0 };
  const rollup = storedById.get(session.sessionId);

  const problems = [];
  if (!rollup) problems.push("no session row");
  if (rollup && rollup.cost_micros !== facts.cost_micros) {
    problems.push(`rollup cost ${rollup.cost_micros} vs facts cost ${facts.cost_micros}`);
  }
  if (rollup && rollup.total_tokens !== facts.total_tokens) {
    problems.push(`rollup tokens ${rollup.total_tokens} vs facts tokens ${facts.total_tokens}`);
  }
  if (session.costMicros !== (rollup?.cost_micros ?? 0)) {
    problems.push(`file cost ${session.costMicros} vs stored cost ${rollup?.cost_micros ?? 0}`);
  }

  if (problems.length > 0) {
    factsMismatched += 1;
    if (examples.length < 8) examples.push(`${session.sessionId}: ${problems.join("; ")}`);
  }
}

console.log(`sessions with no usage facts  ${zeroFactSessions}  (counted as zero, not as missing)`);
console.log(`facts check    ${factsMismatched === 0 ? "OK" : `MISMATCH in ${factsMismatched} session(s)`}`);
for (const example of examples) console.log(`               ${example}`);

const dailyDays = db.prepare("SELECT COUNT(DISTINCT day) AS days FROM daily_cost").get().days;
const modelRows = db.prepare("SELECT COUNT(*) AS rows FROM model_cost").get().rows;
console.log(`views          daily_cost ${dailyDays} day bucket(s), model_cost ${modelRows} model(s)`);

const allOk = countOk && costOk && factsMismatched === 0;
db.close();
process.exit(allOk ? 0 : 1);
