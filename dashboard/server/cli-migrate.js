#!/usr/bin/env node
/**
 * CLI: apply pending migrations, or roll the newest one back.
 *
 * Usage:
 *   node server/cli-migrate.js            apply pending migrations
 *   node server/cli-migrate.js --down     roll back the newest migration
 *   node server/cli-migrate.js --status   show the applied versions
 */

import { currentVersion, listMigrations, migrateDown, migrateUp, openDatabase } from "./db.js";

const flags = process.argv.slice(2);
const db = openDatabase();

if (flags.includes("--status")) {
  const version = currentVersion(db);
  console.log(`schema version ${version}`);
  for (const migration of listMigrations()) {
    console.log(`  ${migration.version <= version ? "applied  " : "pending  "} ${migration.name}`);
  }
} else if (flags.includes("--down")) {
  const { rolledBack, version } = migrateDown(db);
  console.log(rolledBack ? `rolled back ${rolledBack}, now at ${version}` : "nothing to roll back");
} else {
  const { applied, version } = migrateUp(db);
  console.log(
    applied.length > 0
      ? `applied ${applied.join(", ")}; schema version ${version}`
      : `no pending migrations; schema version ${version}`,
  );
}

db.close();
