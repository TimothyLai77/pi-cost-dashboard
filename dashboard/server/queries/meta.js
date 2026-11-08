/**
 * What the app needs that is not spend: the distinct filter values behind the controls, and
 * the health check an operator reads first.
 */

import {
  money,
} from "./shared.js";

/**
 * Distinct filter values for the dashboard controls.
 * @param {import("better-sqlite3").Database} db
 * @returns {{ projects: string[], providers: string[] }}
 */
export const getFilters = (db) => ({
  projects: db
    .prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd <> '' ORDER BY cwd")
    .all()
    .map((row) => row.cwd),
  providers: db
    .prepare("SELECT DISTINCT provider FROM usage_events WHERE provider IS NOT NULL ORDER BY provider")
    .all()
    .map((row) => row.provider),
});

/**
 * Operator sanity check: what is in the database, and can the scanner see any files at all?
 *
 * `scanner` comes from `scannerStatus()` in the scanner module. It is passed in rather than
 * worked out here because "not looked" and "looked, found none" are different answers, and only
 * the caller knows which one it has.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionsDir The directory the scanner was told to read
 * @param {{ enabled?: boolean, reason?: string | null, fileCount?: number | null }} [scanner]
 * @returns {object}
 */
export const getHealth = (db, sessionsDir, scanner) => {
  const state = scanner ?? { enabled: false, reason: "scanner state unavailable", fileCount: null };
  const schemaVersion = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta")
    .get().version;
  const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  const events = db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n;
  const lastScan = db.prepare("SELECT MAX(scanned_at) AS at FROM scan_state").get().at;
  const totals = db
    .prepare("SELECT COALESCE(SUM(cost_micros), 0) AS cost_micros FROM sessions")
    .get();

  return {
    status: "ok",
    dbPath: db.name,
    sessionsDir,
    scanner: { enabled: state.enabled ?? false, reason: state.reason ?? null },
    schemaVersion,
    sessionCount: sessions,
    usageEventCount: events,
    sessionFilesOnDisk: state.fileCount ?? null,
    lastScanAt: lastScan,
    ...money(totals.cost_micros),
  };
};
