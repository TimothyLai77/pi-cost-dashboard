/**
 * SQLite handle and migration runner.
 *
 * The database is a single file, default `dashboard/data/cost.db`, overridable with
 * `PI_COST_DB`. Migrations are numbered `.sql` files in `server/migrations`, applied in
 * filename order inside a transaction and recorded in `schema_meta`. A matching
 * `<name>.down.sql` is applied by `migrateDown`.
 */

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));

/** Directory holding the numbered migration files. @type {string} */
export const MIGRATIONS_DIR = join(here, "migrations");

/** Default database location for this project. @type {string} */
export const DEFAULT_DB_PATH = join(here, "..", "data", "cost.db");

/**
 * Open the database with the pragmas this project relies on.
 *
 * WAL keeps the periodic scan writes from blocking dashboard reads. Foreign keys are
 * off by default in SQLite and the cascade from sessions to usage_events depends on them.
 *
 * @param {string} [databasePath] File path, or ":memory:" for tests
 * @returns {import("better-sqlite3").Database}
 */
export const openDatabase = (databasePath = process.env.PI_COST_DB ?? DEFAULT_DB_PATH) => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
};

/**
 * List migrations on disk, oldest first, excluding the DOWN scripts.
 * @param {string} [migrationsDir]
 * @returns {{ version: number, name: string, upFile: string, downFile: string }[]}
 */
export const listMigrations = (migrationsDir = MIGRATIONS_DIR) =>
  readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
    .map((file) => ({
      version: Number(file.split("_")[0]),
      name: file.replace(/\.sql$/, ""),
      upFile: join(migrationsDir, file),
      downFile: join(migrationsDir, `${file.replace(/\.sql$/, "")}.down.sql`),
    }))
    .sort((a, b) => a.version - b.version);

/**
 * Ensure the migration bookkeeping table exists.
 * @param {import("better-sqlite3").Database} db
 * @returns {void}
 */
export const ensureSchemaMeta = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
};

/**
 * Highest applied migration version, 0 for a fresh database.
 * @param {import("better-sqlite3").Database} db
 * @returns {number}
 */
export const currentVersion = (db) =>
  db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_meta").get().version;

/**
 * Apply every pending migration, one transaction per migration.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} [migrationsDir]
 * @returns {{ applied: string[], version: number }}
 */
export const migrateUp = (db, migrationsDir = MIGRATIONS_DIR) => {
  ensureSchemaMeta(db);
  const applied = [];

  for (const migration of listMigrations(migrationsDir)) {
    if (migration.version <= currentVersion(db)) continue;

    const sql = readFileSync(migration.upFile, "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_meta (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name,
      );
    });
    apply();
    applied.push(migration.name);
  }

  return { applied, version: currentVersion(db) };
};

/**
 * Roll back the most recent migration using its `.down.sql` partner.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {string} [migrationsDir]
 * @returns {{ rolledBack: string | null, version: number }}
 */
export const migrateDown = (db, migrationsDir = MIGRATIONS_DIR) => {
  ensureSchemaMeta(db);
  const version = currentVersion(db);
  if (version === 0) return { rolledBack: null, version: 0 };

  const migration = listMigrations(migrationsDir).find((candidate) => candidate.version === version);
  if (!migration) throw new Error(`no migration file for version ${version}`);

  const sql = readFileSync(migration.downFile, "utf8");
  const rollback = db.transaction(() => {
    db.exec(sql);
    db.prepare("DELETE FROM schema_meta WHERE version = ?").run(version);
  });
  rollback();

  return { rolledBack: migration.name, version: currentVersion(db) };
};
