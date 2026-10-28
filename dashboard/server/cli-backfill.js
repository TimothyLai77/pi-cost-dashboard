#!/usr/bin/env node
/**
 * CLI: scan every Pi session file into the database and print a summary.
 *
 * Idempotent. The `scan_state` cache means a second run re-parses nothing that has not
 * changed, so re-running is cheap and safe.
 *
 * Usage:
 *   node server/cli-backfill.js [--sessions-dir <dir>] [--force] [--top <n>]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, migrateUp } from "./db.js";
import { resolveSessionsDir, scanSessions } from "./scanner/scan.js";
import { formatUsd } from "./scanner/aggregate.js";

/**
 * Read the `sessionDir` value from Pi's settings.json, when that file exists.
 * @param {string} agentDir Absolute path to ~/.pi/agent
 * @returns {string | undefined}
 */
const readSessionDirSetting = (agentDir) => {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return typeof settings.sessionDir === "string" ? settings.sessionDir : undefined;
  } catch {
    return undefined;
  }
};

const args = process.argv.slice(2);
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const sessionsDir = resolveSessionsDir(
  flagValue("--sessions-dir"),
  readSessionDirSetting(join(home, ".pi", "agent")),
);
const topCount = Number(flagValue("--top") ?? 10);

const db = openDatabase();
migrateUp(db);

console.log(`sessions dir  ${sessionsDir}`);
const result = scanSessions(sessionsDir, db, { force: args.includes("--force") });

console.log(
  `scan          ${result.scanned} parsed, ${result.skipped} unchanged, ${result.updated} written, ` +
    `${result.deleted} deleted, ${result.rejected} rejected, ${result.ms} ms`,
);
if (result.skippedLines > 0) console.log(`notice        ${result.skippedLines} unparseable line(s) skipped`);
if (result.rejected > 0) console.log(`notice        ${result.rejected} file(s) had no session header`);

const totals = db
  .prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(cost_micros), 0) AS cost_micros,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM sessions`,
  )
  .get();

console.log(`database      ${totals.sessions} session(s), ${formatUsd(totals.cost_micros)} ` +
  `(${totals.cost_micros} micros), ${totals.total_tokens.toLocaleString("en-US")} tokens`);

const topProjects = db
  .prepare(
    `SELECT cwd, SUM(cost_micros) AS cost_micros, COUNT(*) AS sessions
     FROM sessions GROUP BY cwd ORDER BY cost_micros DESC LIMIT ?`,
  )
  .all(topCount);

console.log(`\ntop ${topCount} projects by cost:`);
for (const project of topProjects) {
  console.log(
    `  ${formatUsd(project.cost_micros).padStart(9)}  ${String(project.sessions).padStart(4)} sessions  ${project.cwd}`,
  );
}

const recent = db
  .prepare(
    `SELECT session_id, name, cwd, last_activity_at, cost_micros, total_tokens, last_source
     FROM sessions ORDER BY last_activity_at DESC LIMIT ?`,
  )
  .all(10);

console.log(`\nlast 10 sessions:`);
for (const session of recent) {
  const label = session.name ?? session.session_id.slice(0, 8);
  console.log(
    `  ${formatUsd(session.cost_micros).padStart(9)}  ${session.last_activity_at}  ` +
      `${label}  [${session.last_source}]`,
  );
}

db.close();
