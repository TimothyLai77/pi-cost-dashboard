/**
 * Directory scanner: reads Pi session files into the database.
 *
 * This is the source of truth. It backfills every session that has ever run, and it
 * rewrites rows the extension reported provisionally.
 *
 * Warm scans are cheap because `scan_state` records `(mtime, size)` per file: an
 * unchanged pair skips the parse entirely.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { aggregateSession } from "./aggregate.js";
import { upsertSession } from "../upsert.js";
import { isExcluded } from "../incognito.js";

/**
 * Directory names that hold JSONL which is not a Pi session.
 *
 * Pi writes subagent transcripts into a `subagent-artifacts` folder inside a project's
 * session directory. Those files have no session header and must not become dashboard
 * rows, so the walk does not descend into them.
 *
 * @type {ReadonlySet<string>}
 */
export const NON_SESSION_DIRECTORIES = new Set(["subagent-artifacts"]);

/**
 * Collect every `*.jsonl` file under a directory, recursively.
 *
 * Skips directories in NON_SESSION_DIRECTORIES. Pi also writes `*.jsonl` session
 * exports and scratch files into ordinary working directories, so a header check in the
 * aggregator remains the final gate.
 *
 * @param {string} sessionsDir Absolute path to the Pi sessions directory
 * @returns {string[]} Absolute file paths
 */
export const listSessionFiles = (sessionsDir) => {
  const files = [];

  // A deployment fed only by extension pushes has no scanned directory. Treating a
  // missing one as "nothing to scan" keeps the periodic scan from throwing, and the
  // sweep below leaves pushed rows alone because they are not tracked in scan_state.
  if (!existsSync(sessionsDir)) return files;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (NON_SESSION_DIRECTORIES.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  };
  // One unreadable subdirectory (a permission bit flipped by hand) must not cost the
  // whole pass: keep what the walk found and carry on.
  try {
    walk(sessionsDir);
  } catch (error) {
    console.warn(`scan: could not read ${sessionsDir} fully: ${error?.message ?? error}`);
  }
  return files;
};

/**
 * Describe what the directory scanner can actually see, for `/api/health`.
 *
 * A push-fed deployment points `PI_COST_SESSIONS_DIR` at a directory that does not exist, and
 * that is a scanner with nothing to read, not a broken one. Every scanner field used to answer
 * `null` either way, so an operator could not tell the two apart; now the response says which
 * world it is in, and counts files whenever counting is possible.
 *
 * @param {string} sessionsDir Absolute directory path the scanner was told to read
 * @returns {{ enabled: boolean, reason: string | null, fileCount: number | null }}
 */
export const scannerStatus = (sessionsDir) => {
  if (!existsSync(sessionsDir)) {
    return { enabled: false, reason: "sessions directory not found", fileCount: null };
  }
  return { enabled: true, reason: null, fileCount: listSessionFiles(sessionsDir).length };
};

/**
 * Decide whether a file needs re-parsing.
 * @param {import("better-sqlite3").Database} db
 * @param {string} filePath
 * @returns {boolean} true when the file is new or its (mtime, size) pair changed
 */
const needsRescan = (db, filePath) => {
  const cached = db
    .prepare("SELECT mtime_ms, size_bytes FROM scan_state WHERE session_file = ?")
    .get(filePath);
  if (!cached) return true;

  const stats = statSync(filePath);
  return cached.mtime_ms !== Math.round(stats.mtimeMs) || cached.size_bytes !== stats.size;
};

/**
 * Record a file's (mtime, size) pair so the next warm scan skips it.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} filePath
 * @param {string} sessionId
 * @returns {void}
 */
const markScanned = (db, filePath, sessionId) => {
  const stats = statSync(filePath);
  db.prepare(`
    INSERT INTO scan_state (session_file, session_id, mtime_ms, size_bytes, scanned_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT (session_file) DO UPDATE SET
      session_id = excluded.session_id,
      mtime_ms   = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      scanned_at = excluded.scanned_at
  `).run(filePath, sessionId, Math.round(stats.mtimeMs), stats.size);
};

/**
 * Scan the sessions directory and write changes to the database.
 *
 * Files Pi has deleted are removed from the database, cascading to their facts, so the
 * dashboard mirrors the files rather than accumulating ghosts.
 *
 * Incognito tombstones are skipped: nothing is stored for the file, but its (mtime, size)
 * pair is recorded, so warm scans keep skipping it instead of re-parsing every pass.
 *
 * One file can never take the scan down with it. Aggregation, the upsert, and the state
 * write run inside a per-file transaction and any throw is counted as `failed` and
 * logged, because one colliding or unreadable file — the same session stored under two
 * paths, a directory remount, a file deleted mid-read — used to abort the whole pass and
 * roll back every file already written in it.
 *
 * @param {string} sessionsDir Absolute path to the Pi sessions directory
 * @param {import("better-sqlite3").Database} db
 * @param {{ force?: boolean }} [options] force rescans every file, ignoring the cache
 * @returns {{ scanned: number, skipped: number, updated: number, deleted: number,
 *             rejected: number, tombstoned: number, failed: number, files: number,
 *             ms: number, skippedLines: number }}
 */
export const scanSessions = (sessionsDir, db, options = {}) => {
  const startedAt = performance.now();
  const files = listSessionFiles(sessionsDir);

  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let rejected = 0;
  let tombstoned = 0;
  let failed = 0;
  let skippedLines = 0;

  for (const filePath of files) {
    if (options.force !== true && !needsRescan(db, filePath)) {
      skipped += 1;
      continue;
    }

    scanned += 1;
    try {
      // better-sqlite3 transactions must be function bodies, so the reading and the
      // writing are collected here and the whole file lands or rolls back as one unit.
      const writeFile = db.transaction(() => {
        const { session, events, skippedLines: skippedInFile } = aggregateSession(filePath);
        skippedLines += skippedInFile;

        // A file with no header is not a session we can key, so record it and move on.
        if (!session.sessionId) {
          rejected += 1;
          return;
        }

        // Incognito: mark the file scanned so warm passes skip it, and store nothing.
        if (isExcluded(db, session.sessionId)) {
          tombstoned += 1;
          markScanned(db, filePath, session.sessionId);
          return;
        }

        if (upsertSession(db, session, events, "scan")) updated += 1;

        markScanned(db, filePath, session.sessionId);
      });
      writeFile();
    } catch (error) {
      // The transaction rolled this file back on its own; the counter and the log line
      // are all the rest of the scan needs to keep going.
      failed += 1;
      console.warn(`scan: skipping ${filePath}: ${error?.message ?? error}`);
    }
  }

  const knownFiles = new Set(files);
  const tracked = db.prepare("SELECT session_file FROM scan_state").all();
  const missing = tracked.filter((row) => !knownFiles.has(row.session_file));

  const deleteSession = db.prepare("DELETE FROM sessions WHERE session_file = ?");
  const deleteState = db.prepare("DELETE FROM scan_state WHERE session_file = ?");
  const removeMissing = db.transaction(() => {
    for (const row of missing) {
      deleteState.run(row.session_file);
      deleteSession.run(row.session_file);
    }
  });
  removeMissing();

  return {
    scanned,
    skipped,
    updated,
    deleted: missing.length,
    rejected,
    tombstoned,
    failed,
    files: files.length,
    skippedLines,
    ms: Math.round(performance.now() - startedAt),
  };
};

/**
 * Resolve the Pi sessions directory.
 *
 * Order matches Pi's own resolution: explicit argument, then
 * `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting, then the default.
 * Relative settings paths resolve against the working directory.
 *
 * @param {string} [explicitPath] Value from a CLI flag, if given
 * @param {string} [settingsSessionDir] Value read from Pi's settings.json, if available
 * @returns {string} Absolute directory path
 */
export const resolveSessionsDir = (explicitPath, settingsSessionDir) => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidate =
    explicitPath ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsSessionDir ?? join(home, ".pi", "agent", "sessions");
  return candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)
    ? candidate
    : join(process.cwd(), candidate);
};
