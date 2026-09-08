#!/usr/bin/env bun
/**
 * One-off operator repair for a tm_expectations table whose schema predates
 * migration 049's final shape AND still holds rows.
 *
 * WHY THIS IS A SCRIPT AND NOT A STARTUP REPAIR
 *
 * tm_expectations ships for the first time in
 * WO-HARNESS-TASKMASTER-EXPECTATION-REGISTRY-01: it exists in no commit on
 * origin/dev, and the live archon.db reports the table absent. No deployed
 * database can hold an outdated shape, so the only way to reach this script is
 * a database built from an intermediate revision of that branch.
 *
 * For such a table the adapter deliberately REFUSES to start rather than
 * deriving registration_key values on its own. Every derivation scheme that
 * mixes preserved keys with generated ones can collide, and a collision fails
 * the unique index and blocks startup anyway -- so the honest move is to stop
 * and let a human look at the rows. This script is that look: it prints them,
 * exports them to JSON, and only then recreates the table.
 *
 * Usage:
 *   bun scripts/db/repair-tm-expectations.ts <path-to-db>            # inspect only
 *   bun scripts/db/repair-tm-expectations.ts <path-to-db> --apply    # export + recreate
 *
 * --apply always writes the JSON export first; the recreate runs in one
 * transaction, so an interrupted run leaves the database untouched.
 */
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'fs';

const TM_EXPECTATIONS_SCHEMA = `CREATE TABLE tm_expectations (
  id TEXT PRIMARY KEY,
  registration_key TEXT NOT NULL UNIQUE,
  dispatch_ref TEXT NOT NULL,
  recipient TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  due_at TEXT NOT NULL,
  on_absence TEXT NOT NULL CHECK (on_absence IN ('redispatch', 'escalate', 'give_up')),
  max_retries INTEGER NOT NULL DEFAULT 0 CHECK (max_retries >= 0),
  retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'met', 'failed', 'escalating', 'escalated', 'given_up')
  ),
  evidence_pointer TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

function main(): void {
  const dbPath = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!dbPath) {
    console.error('usage: bun scripts/db/repair-tm-expectations.ts <path-to-db> [--apply]');
    process.exit(2);
  }

  const db = new Database(dbPath);
  try {
    const table = db
      .query<
        { sql: string },
        []
      >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_expectations'")
      .get();
    if (!table) {
      console.log('tm_expectations is absent -- nothing to repair.');
      return;
    }

    const rows = db.query<Record<string, unknown>, []>('SELECT * FROM tm_expectations').all();
    console.log(`tm_expectations holds ${String(rows.length)} row(s).`);
    console.log('--- current schema ---');
    console.log(table.sql);
    console.log('--- rows ---');
    for (const row of rows) console.log(JSON.stringify(row));

    if (!apply) {
      console.log('');
      console.log('Inspect-only. Re-run with --apply to export these rows to JSON and');
      console.log('recreate the table with the current schema. THE ROWS ARE NOT MIGRATED:');
      console.log('expectations are short-lived supervision records, and re-deriving their');
      console.log('identity keys is exactly what is unsafe to automate.');
      return;
    }

    const exportPath = `${dbPath}.tm_expectations.${String(Date.now())}.json`;
    writeFileSync(exportPath, JSON.stringify(rows, null, 2));
    console.log(`Exported ${String(rows.length)} row(s) to ${exportPath}`);

    db.run('BEGIN');
    try {
      db.run('DROP TABLE tm_expectations');
      db.run(TM_EXPECTATIONS_SCHEMA);
      db.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_expectations_registration_key ON tm_expectations(registration_key)'
      );
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_tm_expectations_due ON tm_expectations(status, due_at)'
      );
      db.run(
        'CREATE INDEX IF NOT EXISTS idx_tm_expectations_dispatch_ref ON tm_expectations(dispatch_ref)'
      );
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
    console.log('tm_expectations recreated with the current schema. Startup can proceed.');
  } finally {
    db.close();
  }
}

main();
