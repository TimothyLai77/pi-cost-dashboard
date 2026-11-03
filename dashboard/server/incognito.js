/**
 * Incognito tombstones: the server-side half of incognito mode.
 *
 * A tombstone is a recorded session UUID that must never appear in the facts tables.
 * It stores the id and the time the tombstone was created, nothing else — no cost, no
 * cwd, no timing for the session itself.
 *
 * Three operations live here:
 *   - isExcluded: the guard every writer consults, funneled through upsertSession.
 *   - tombstoneSession: record the tombstone and purge anything already stored for
 *     that id, so toggling incognito mid-session erases the partial pushes.
 *   - liftTombstone: remove the tombstone so the session may be reported again.
 */

/**
 * Whether a session id carries a tombstone.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionId
 * @returns {boolean}
 */
export const isExcluded = (db, sessionId) =>
  db.prepare("SELECT 1 FROM excluded_session WHERE session_id = ?").get(sessionId) !== undefined;

/**
 * Delete every stored row for a session: the rollup first, its facts by cascade.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionId
 * @returns {number} 1 when a session row existed and was removed, 0 otherwise
 */
export const purgeSession = (db, sessionId) =>
  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId).changes;

/**
 * Record a tombstone and wipe any rows already stored for that session.
 *
 * Idempotent: re-tombstoning an already tombstoned session changes nothing and purges
 * nothing that the first tombstone did not already purge.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionId
 * @returns {{ purged: number }} sessions rows removed by the tombstone
 */
export const tombstoneSession = (db, sessionId) =>
  db
    .transaction(() => {
      db.prepare(
        "INSERT INTO excluded_session (session_id) VALUES (?) ON CONFLICT (session_id) DO NOTHING",
      ).run(sessionId);
      return { purged: purgeSession(db, sessionId) };
    })();

/**
 * Remove a tombstone so the session's id may be written again.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} sessionId
 * @returns {number} 1 when a tombstone existed and was removed, 0 otherwise
 */
export const liftTombstone = (db, sessionId) =>
  db.prepare("DELETE FROM excluded_session WHERE session_id = ?").run(sessionId).changes;
