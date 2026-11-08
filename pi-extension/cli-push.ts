#!/usr/bin/env node
/**
 * CLI: send a Pi box's own session files to the dashboard over HTTP.
 *
 * This is the manual repair path for what the live reports cannot cover: a box that was
 * offline while the dashboard was down, a home directory that predates the extension, or a
 * queue that already gave up. It reads the same files the server's scanner reads and sends
 * them to the same endpoint, so the server still decides what to keep — its entry-count and
 * incognito guards mean a full re-push cannot overwrite newer numbers or resurrect a session
 * the user asked to forget.
 *
 * Run it on the Pi box, from a checkout of this repo. It is not an extension: do not copy it
 * into `~/.pi/agent/extensions/`, where Pi would load it as one.
 *
 * Usage (on the Pi box):
 *   node --experimental-strip-types pi-extension/cli-push.ts [flags]
 *
 * Each flag takes its value as a separate word — `--limit 50`, not `--limit=50`, which is
 * rejected rather than ignored, because an ignored bound here means sending everything:
 *   --sessions-dir <dir>  default: PI_COST_SESSIONS_DIR, then Pi's settings.json, then ~/.pi/agent/sessions
 *   --url <url>           default: saved settings, then PI_COST_URL
 *   --token <token>       default: saved settings, then PI_COST_TOKEN
 *   --since <YYYY-MM-DD>  only sessions with activity on or after this date
 *   --limit <n>           send at most n sessions, newest activity first (default: all)
 *   --dry-run             aggregate and report; send nothing
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { aggregateSession, formatUsd } from "../dashboard/server/scanner/aggregate.js";
import { listSessionFiles, resolveSessionsDir } from "../dashboard/server/scanner/scan.js";
import { buildPayload, effectiveConfig, postBackground, readSettings } from "./pi-cost.ts";

/** Flags that take a value, and flags that do not. Anything else is refused. */
const VALUE_FLAGS = ["--sessions-dir", "--url", "--token", "--since", "--limit"];
const BARE_FLAGS = ["--dry-run"];

const args = process.argv.slice(2);

// An argument this command does not know is not a harmless typo: `--limit=50` would leave the
// limit unset, and unset means "send the whole directory". Refuse the spelling instead.
for (const arg of args) {
  if (!arg.startsWith("--")) continue;
  const [name, inlineValue] = [arg.split("=")[0], arg.includes("=")];
  if (inlineValue || (!VALUE_FLAGS.includes(name) && !BARE_FLAGS.includes(name))) {
    console.error(
      `I do not understand "${arg}". Known flags: ${[...VALUE_FLAGS, ...BARE_FLAGS].join(", ")}. ` +
        "Each takes its value as a separate word.",
    );
    process.exit(1);
  }
}

const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

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

const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const sessionsDir = resolveSessionsDir(
  flagValue("--sessions-dir") ?? process.env.PI_COST_SESSIONS_DIR,
  readSessionDirSetting(join(home, ".pi", "agent")),
);

const saved = readSettings();
const config = effectiveConfig(
  {
    ...saved,
    url: flagValue("--url") ?? saved?.url,
    token: flagValue("--token") ?? saved?.token,
  },
  process.env,
);

if (!config?.url) {
  console.error("No endpoint configured. Run /pi-cost-settings in Pi, set PI_COST_URL, or pass --url.");
  process.exit(1);
}

const since = flagValue("--since");
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error(`--since wants YYYY-MM-DD, got "${since}".`);
  process.exit(1);
}
const limitRaw = flagValue("--limit");
const limit = limitRaw === undefined ? Infinity : Number(limitRaw);
if (limitRaw !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`--limit wants a positive whole number, got "${limitRaw}".`);
  process.exit(1);
}

const files = listSessionFiles(sessionsDir);
console.log(`sessions dir  ${sessionsDir}`);
console.log(`endpoint      ${config.url}${config.token ? " (with token)" : ""}`);
console.log(`found         ${files.length} session file(s)`);

/**
 * Aggregate one session file into the payload the ingest endpoint expects.
 *
 * The scanner's rollup and the extension's snapshot are the same numbers from the same file —
 * `buildPayload` derives the totals from the facts either way — so a pushed session and a live
 * reported one are indistinguishable to the server apart from `reportedBy`.
 *
 * @param {string} filePath
 * @returns {object | null} the payload, null when the file cannot be identified
 */
const payloadFor = (filePath) => {
  const aggregated = aggregateSession(filePath);
  const { session, events } = aggregated;

  // Without a header there is no session id to key on, and without timestamps the daily
  // charts would place the whole session on the wrong day. Same rejection the scanner makes.
  if (!session.sessionId || !session.startedAt || !session.lastActivityAt) return null;
  if (since && String(session.lastActivityAt).slice(0, 10) < since) return null;

  return buildPayload({ ...session, facts: events }, "command");
};

// postBackground unrefs its sockets so Pi never waits on a report. A CLI is the opposite case:
// these sends are the only reason it is running, so hold the loop open until the last one ends.
const keepLoopAlive = setInterval(() => {}, 1000);

let sent = 0;
let alreadyNewer = 0;
let refused = 0;
let failed = 0;
let unusable = 0;
let costMicros = 0;

for (const filePath of files) {
  if (sent >= limit) break;

  const payload = payloadFor(filePath);
  if (!payload) {
    unusable += 1;
    continue;
  }

  sent += 1;
  costMicros += payload.totals.costMicros;

  if (args.includes("--dry-run")) continue;

  const outcome = await postBackground(config, payload);
  if (!outcome.ok) {
    const reason = outcome.error ?? `HTTP ${outcome.status}`;
    if (outcome.status !== null && outcome.status < 500) {
      // The server read this payload and said no: an incognito tombstone, or a stored row
      // keyed under a different file path. Re-sending the same bytes gets the same answer, so
      // this is not a delivery failure and must not fail the run — it is the server doing its
      // job, which is the whole reason this CLI pushes through the endpoint.
      refused += 1;
      console.log(`  refused     ${payload.sessionId}  HTTP ${outcome.status}  ${reason}`);
    } else {
      failed += 1;
      console.log(`  failed      ${payload.sessionId}  ${reason}`);
    }
    continue;
  }

  if (!outcome.applied) {
    // 200 with applied: false — the dashboard already holds a newer snapshot of this session
    // and kept its own numbers, which is the right outcome for a re-push.
    alreadyNewer += 1;
  }
}

clearInterval(keepLoopAlive);

console.log(
  `sent          ${sent} session(s), ${formatUsd(costMicros)} of spend` +
    (Number.isFinite(limit) && sent >= limit ? ` (--limit ${limit} stopped it there)` : ""),
);
if (unusable > 0) console.log(`notice        ${unusable} file(s) had no session header, or fell before --since`);
if (alreadyNewer > 0) console.log(`notice        ${alreadyNewer} already newer on the server, so left alone`);
if (refused > 0) console.log(`notice        ${refused} refused by the server above and left as they are`);
if (failed > 0) console.log(`notice        ${failed} never reached the server — check the endpoint and try again`);
if (args.includes("--dry-run")) console.log(`dry run       nothing was sent`);

process.exit(failed > 0 ? 1 : 0);
