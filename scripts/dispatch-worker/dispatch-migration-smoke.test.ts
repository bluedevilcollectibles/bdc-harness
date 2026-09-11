import { Database, constants } from 'bun:sqlite';
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'crypto';
import { link, lstat, mkdtemp, readFile, readdir, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

// WINDOWS CI TIMEOUT CLASS -- file-local restatement of the repo-wide default.
//
// packages/core/src/test/setup.ts raises the default per-test timeout to 30s
// via setDefaultTimeout() in the bunfig preload. That covers tests declared by
// files bun discovers directly, but this file is NOT one of them: it lives
// under scripts/ (outside every bunfig `root`) and is registered only through
// the cross-package `await import(...)` at the top of
// packages/core/src/db/adapters/sqlite.test.ts. On the Bun version CI pins
// (1.3.11) the preload's raised default does not reach tests registered across
// that import boundary, so they silently fall back to Bun's 5000ms default --
// while a local Bun 1.3.13 run applies it and passes, hiding the gap.
//
// Every test here spawns a real child process and does real filesystem IO, so
// on a slow windows-latest runner several land just past 5000ms (observed:
// 5015ms/5016ms against siblings measuring 4391ms, 2984ms and 2484ms). Ubuntu
// was always green: this is runner speed, not a product defect.
//
// RAISED 30s -> 90s (2026-09-08). The same class recurred at the higher
// threshold: on run 34193910325 (windows-latest) "migrates only a temporary
// copy..." and "fails when the expected heartbeat count does not match" BOTH
// hit the 30000ms wall (30016ms / 30015ms) and their spawned children were
// killed -- the CLI exited 143, SIGTERM, with "killed 1 dangling process"
// logged immediately before. On the SAME commit and the SAME run, ubuntu ran
// those two tests in 1160.99ms and 769.99ms. A ~26x platform gap with no
// product difference is runner contention, and the two slowest tests here are
// the ones that spawn the migration CLI *and* run a real SqliteAdapter
// migration inside that child.
//
// 90s is chosen against the observed 30s wall rather than the ~1s happy path,
// so it absorbs a badly contended runner without letting a genuine hang sit
// for minutes.
//
// Restating the default here makes this file honest under any invocation --
// the pinned `bun test:dispatch-migration-smoke`, the core package suite, or a
// direct run -- and independent of the Bun version in play.
setDefaultTimeout(90_000);

const temporaryDirectories: string[] = [];
const scriptPath = join(import.meta.dir, 'dispatch-migration-smoke.ts');
const reportScriptPath = join(import.meta.dir, 'report-unroutable.ts');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function makeLegacyFixture(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-migration-smoke-test-'));
  temporaryDirectories.push(dir);
  const dbPath = join(dir, 'source-copy.db');
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE agent_dispatch_messages (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      task_type TEXT NOT NULL CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report')),
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
      result_body TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      not_before TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      recipient_alias TEXT,
      motion_id TEXT,
      motion_revision_sha TEXT,
      resolved_recipient TEXT,
      resolved_xo_lease_id TEXT,
      resolved_xo_fencing_token INTEGER,
      resolved_at TEXT
    );
  `);
  const insert = db.prepare(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    'report-1',
    'correlation-1',
    'idempotency-1',
    'run_report',
    'overseer',
    'operator',
    'SECRET-report-one',
    'queued',
    '2026-08-05T10:00:00.000Z'
  );
  insert.run(
    'report-2',
    'correlation-2',
    'idempotency-2',
    'run_report',
    'not-overseer',
    'xo',
    'SECRET-report-two',
    'queued',
    '2026-08-05T10:01:00.000Z'
  );
  insert.run(
    'old-report',
    'correlation-3',
    'idempotency-3',
    'run_report',
    'overseer',
    'operator',
    'SECRET-old-report',
    'done',
    '2026-08-05T10:02:00.000Z'
  );
  insert.run(
    'live-only',
    'correlation-4',
    'idempotency-4',
    'agent_message',
    'xo',
    'fable',
    'SECRET-live-only',
    'queued',
    '2026-08-05T10:03:00.000Z'
  );
  insert.finalize();
  db.close();
  return { dir, dbPath };
}

async function runCli(
  args: string[],
  environment: Record<string, string> = {}
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'fatal', NODE_ENV: 'test', ...environment },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function runReport(dbPath: string): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, reportScriptPath, '--db', dbPath, '--format', 'json'],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'fatal', NODE_ENV: 'test' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('dispatch-migration-smoke CLI', () => {
  test('preserves populated Phase 0/1 priorities and lifecycle state on a quiescent copy', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const source = new Database(dbPath);
    source.run(
      "ALTER TABLE agent_dispatch_messages ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat'))"
    );
    source.run(
      "ALTER TABLE agent_dispatch_messages ADD COLUMN task_outcome TEXT CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked'))"
    );
    for (const name of [
      'acknowledged_at',
      'acknowledged_by',
      'addressed_at',
      'addressed_by',
      'escalated_tg_at',
      'escalated_sms_at',
      'subject_key',
      'repeat_reason',
    ]) {
      source.run(`ALTER TABLE agent_dispatch_messages ADD COLUMN ${name} TEXT`);
    }
    source.run(
      "ALTER TABLE agent_dispatch_messages ADD COLUMN route_disposition TEXT CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded'))"
    );
    source.run(
      'ALTER TABLE agent_dispatch_messages ADD COLUMN supersedes_id TEXT REFERENCES agent_dispatch_messages(id)'
    );
    source.run(
      "CREATE INDEX idx_agent_dispatch_messages_lease_expiry ON agent_dispatch_messages(lease_expires_at) WHERE status = 'claimed'"
    );
    source.run(
      'CREATE INDEX idx_agent_dispatch_messages_recipient_status ON agent_dispatch_messages(recipient, status)'
    );
    source.run(
      'CREATE INDEX idx_dispatch_board_pending ON agent_dispatch_messages(recipient_alias, status, created_at)'
    );
    source.run(
      'CREATE INDEX idx_agent_dispatch_messages_subject_history ON agent_dispatch_messages(subject_key, created_at DESC, id DESC) WHERE subject_key IS NOT NULL'
    );
    source.run("UPDATE agent_dispatch_messages SET priority='heartbeat' WHERE id='report-1'");
    source.run(`UPDATE agent_dispatch_messages SET priority='blocker', status='claimed',
      subject_key='synthetic-subject', repeat_reason='synthetic-repeat',
      acknowledged_at='2026-08-05T10:00:00.000Z', acknowledged_by='xo',
      addressed_at='2026-08-05T10:00:00.000Z', addressed_by='xo',
      escalated_tg_at='2026-08-05T10:00:00.000Z', escalated_sms_at='2026-08-05T10:00:00.000Z',
      task_outcome='blocked', route_disposition='superseded', supersedes_id='old-report',
      lease_owner='synthetic-worker', lease_expires_at='2026-08-05T10:30:00.000Z', fencing_token=2
      WHERE id='report-2'`);
    // A completed heartbeat is valid existing state, not a backfill candidate.
    source.run(
      "UPDATE agent_dispatch_messages SET priority='heartbeat', task_outcome='succeeded' WHERE id='old-report'"
    );
    const beforeRows = source
      .query<Record<string, unknown>, []>('SELECT * FROM agent_dispatch_messages ORDER BY id')
      .all();
    const beforeIndexes = source
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
      )
      .all();
    source.close();
    const beforeHash = await sha256(dbPath);
    const outputPath = join(dir, 'phase15-copy.db');
    const result = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '1',
      '--migrated-copy-output',
      outputPath,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(
      'PASS rows_before=4 rows_after=4 heartbeat_rows=1 source_unchanged=true second_run_idempotent=true migrated_copy_ready=true'
    );
    expect(await sha256(dbPath)).toBe(beforeHash);
    const outputUrl = pathToFileURL(outputPath);
    outputUrl.searchParams.set('mode', 'ro');
    outputUrl.searchParams.set('immutable', '1');
    const migrated = new Database(
      outputUrl.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
    );
    try {
      // Current dev also adds seq; compare every original column, not new columns.
      const originalColumns = Object.keys(beforeRows[0]);
      const afterRows = migrated
        .query<
          Record<string, unknown>,
          []
        >(`SELECT ${originalColumns.join(',')}, sender_principal_id FROM agent_dispatch_messages ORDER BY id`)
        .all();
      expect(
        afterRows.map(({ sender_principal_id, ...row }) => {
          expect(sender_principal_id).toBeNull();
          return row;
        })
      ).toEqual(beforeRows);
      expect(migrated.query('PRAGMA foreign_key_check').all()).toEqual([]);
      const indexes = migrated
        .query(
          "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"
        )
        .all();
      for (const index of beforeIndexes) expect(indexes).toContainEqual(index);
    } finally {
      migrated.close();
    }
    expect(await readdir(dir)).not.toContain('phase15-copy.db-wal');
    expect(await readdir(dir)).not.toContain('phase15-copy.db-shm');
  });

  test('migrates only a temporary copy and prints the exact non-secret PASS summary', async () => {
    const { dbPath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('SECRET-');
    expect(result.stdout.trim()).toBe(
      'PASS rows_before=4 rows_after=4 heartbeat_rows=2 source_unchanged=true second_run_idempotent=true'
    );
    expect(result.stdout).not.toContain('SECRET-');
    expect(await sha256(dbPath)).toBe(beforeHash);

    const source = new Database(dbPath, { readonly: true, create: false });
    const columns = source
      .query<{ name: string }, []>("PRAGMA table_info('agent_dispatch_messages')")
      .all()
      .map(row => row.name);
    expect(columns).not.toContain('priority');
    expect(
      source
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_principals'")
        .get()?.count
    ).toBe(0);
    source.close();
  });

  test('fails when the expected heartbeat count does not match', async () => {
    const { dbPath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '3']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('SECRET-');
    expect(result.stderr).toContain('expected 3 heartbeat rows, found 2');
    expect(await sha256(dbPath)).toBe(beforeHash);
  });

  test('rejects missing input and both exact known live paths before database access', async () => {
    const missing = await runCli(['--expected-heartbeats', '369']);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('--source-copy is required');

    for (const livePath of ['/.archon/archon.db', '/opt/bdc/archon-data/archon.db']) {
      const result = await runCli(['--source-copy', livePath, '--expected-heartbeats', '369']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain('ENOENT');
    }
  });

  test('rejects canonical dot-segment and duplicate-separator live paths before access', async () => {
    const aliases = [
      '/opt/bdc/archon-data/../archon-data/archon.db',
      '/opt//bdc//archon-data//archon.db',
    ];

    for (const alias of aliases) {
      const result = await runCli(['--source-copy', alias, '--expected-heartbeats', '369']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain(alias);
      expect(result.stderr).not.toContain('ENOENT');
    }
  });

  test('rejects symlink and hardlink identities of a protected file without reading it', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const symlinkPath = join(dir, 'symlink-copy.db');
    const hardlinkPath = join(dir, 'hardlink-copy.db');
    await symlink(dbPath, symlinkPath, 'file');
    await link(dbPath, hardlinkPath);
    const environment = {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS: JSON.stringify([dbPath]),
    };

    for (const alias of [symlinkPath, hardlinkPath]) {
      const beforeHash = await sha256(dbPath);
      const result = await runCli(
        ['--source-copy', alias, '--expected-heartbeats', '2'],
        environment
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('source_copy_forbidden');
      expect(result.stderr).not.toContain(alias);
      expect(await sha256(dbPath)).toBe(beforeHash);
    }
  });

  test('rejects malformed Phase 0 column definitions even when aggregate counts pass', async () => {
    const { dbPath } = await makeLegacyFixture();
    const database = new Database(dbPath);
    database.run('DELETE FROM agent_dispatch_messages');
    database.run('ALTER TABLE agent_dispatch_messages ADD COLUMN priority INTEGER DEFAULT 0');
    database.close();

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '0']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    // Phase 1.5 refuses a malformed priority type fatally during adapter init
    // before schema snapshot validation can heal or ignore it.
    expect(result.stderr).toMatch(
      /migration_initialization_failed|migration_schema_validation_failed/
    );
  });

  test('rejects a pre-existing dispatch index with the right name but wrong definition', async () => {
    // Use a Phase 1.5-shaped table (no inline UNIQUE) so rebuild does not heal
    // a wrong-definition leftover via IF NOT EXISTS.
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-migration-smoke-test-'));
    temporaryDirectories.push(dir);
    const dbPath = join(dir, 'source-copy.db');
    const database = new Database(dbPath);
    database.run(`
      CREATE TABLE agent_dispatch_messages (
        id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report', 'board_motion')),
        sender TEXT NOT NULL,
        sender_principal_id TEXT,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
        result_body TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT,
        not_before TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        recipient_alias TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board'),
        motion_id TEXT,
        motion_revision_sha TEXT,
        resolved_recipient TEXT,
        resolved_xo_lease_id TEXT,
        resolved_xo_fencing_token INTEGER,
        resolved_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat')),
        task_outcome TEXT,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        addressed_at TEXT,
        addressed_by TEXT,
        escalated_tg_at TEXT,
        escalated_sms_at TEXT,
        subject_key TEXT,
        repeat_reason TEXT,
        route_disposition TEXT,
        supersedes_id TEXT REFERENCES agent_dispatch_messages(id)
      );
    `);
    database.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, priority, fencing_token)
       VALUES ('r1', 'c1', 'k1', 'run_report', 'overseer', 'operator', 'body', 'queued', '2026-08-05T10:00:00.000Z', 'heartbeat', 0)`
    );
    database.run(
      `INSERT INTO agent_dispatch_messages
       (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, priority, fencing_token)
       VALUES ('r2', 'c2', 'k2', 'run_report', 'overseer', 'operator', 'body', 'queued', '2026-08-05T10:01:00.000Z', 'heartbeat', 0)`
    );
    database.run('CREATE INDEX idx_dispatch_board_pending ON agent_dispatch_messages(status)');
    database.close();

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_schema_validation_failed');
  });

  test('detects complete message-state drift between migration runs', async () => {
    const { dbPath } = await makeLegacyFixture();
    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_DRIFT_AFTER_FIRST: '1',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_second_run_not_idempotent');
    expect(result.stderr).not.toContain('SECRET-');
  });

  test('does not disclose a sensitive nonexistent source path', async () => {
    const sensitivePath = join(tmpdir(), 'CUSTOMER-SECRET-ACCOUNT-NAME', 'private-snapshot.db');
    const result = await runCli(['--source-copy', sensitivePath, '--expected-heartbeats', '369']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('source_copy_unavailable');
    expect(result.stderr).not.toContain(sensitivePath);
    expect(result.stderr).not.toContain('CUSTOMER-SECRET-ACCOUNT-NAME');
  });

  test('cleans the temporary copy after constructor failure and preserves the primary error', async () => {
    const { dbPath } = await makeLegacyFixture();
    const source = new Database(dbPath);
    source.run('CREATE TABLE dispatch_principals (principal_id TEXT PRIMARY KEY)');
    source.close();
    const tempParent = await mkdtemp(join(tmpdir(), 'dispatch-smoke-parent-'));
    temporaryDirectories.push(tempParent);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_TEMP_PARENT: tempParent,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migration_initialization_failed');
    expect(result.stderr).not.toContain(dbPath);
    expect(result.stderr).not.toContain(tempParent);
    expect(await readdir(tempParent)).toEqual([]);
  });

  test('surfaces cleanup failure together with a primary migration failure', async () => {
    const { dbPath } = await makeLegacyFixture();
    const source = new Database(dbPath);
    source.run('CREATE TABLE dispatch_principals (principal_id TEXT PRIMARY KEY)');
    source.close();
    const tempParent = await mkdtemp(join(tmpdir(), 'CUSTOMER-SECRET-DISPATCH-SMOKE-'));
    temporaryDirectories.push(tempParent);

    const result = await runCli(['--source-copy', dbPath, '--expected-heartbeats', '2'], {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_TEMP_PARENT: tempParent,
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_CLEANUP: '1',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split(/\r?\n/).at(-1)).toBe(
      'migration_initialization_failed;temporary_cleanup_failed'
    );
    expect(result.stderr).not.toContain(dbPath);
    expect(result.stderr).not.toContain(tempParent);
    expect(result.stderr).not.toContain('CUSTOMER-SECRET-DISPATCH-SMOKE');
    expect(result.stderr).not.toContain('SECRET-');
  });

  test('exports a validated migrated copy without changing the source or leaving sidecars', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'migrated-report-copy.db');
    const beforeHash = await sha256(dbPath);

    const result = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      outputPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('SECRET-');
    expect(result.stdout.trim()).toBe(
      'PASS rows_before=4 rows_after=4 heartbeat_rows=2 source_unchanged=true second_run_idempotent=true migrated_copy_ready=true'
    );
    expect(await sha256(dbPath)).toBe(beforeHash);
    const outputUrl = pathToFileURL(outputPath);
    outputUrl.searchParams.set('mode', 'ro');
    outputUrl.searchParams.set('immutable', '1');
    const output = new Database(
      outputUrl.href,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
    );
    expect(
      output
        .query<{ name: string }, []>("PRAGMA table_info('agent_dispatch_messages')")
        .all()
        .map(row => row.name)
    ).toContain('priority');
    expect(
      output
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_principals'")
        .get()?.count
    ).toBe(1);
    expect(
      output
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agent_dispatch_messages')
        .get()?.count
    ).toBe(4);
    expect(
      output
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM agent_dispatch_messages WHERE id LIKE 'p15-%'")
        .get()?.count
    ).toBe(0);
    output.close();
    const entries = await readdir(dir);
    expect(entries).not.toContain('migrated-report-copy.db-wal');
    expect(entries).not.toContain('migrated-report-copy.db-shm');
  });

  test('exports a database that report-unroutable can read without writing sidecars', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'report-compatible-copy.db');

    const smoke = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      outputPath,
    ]);
    const report = await runReport(outputPath);

    expect(smoke.exitCode).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(report.stderr).not.toContain('SECRET-');
    expect(JSON.parse(report.stdout)).toEqual({ count: 0, findings: [] });
    const entries = await readdir(dir);
    expect(entries).not.toContain('report-compatible-copy.db-wal');
    expect(entries).not.toContain('report-compatible-copy.db-shm');
  });

  test('rejects a missing migrated-copy output value and preserves a colliding output', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const missing = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
    ]);
    const outputPath = join(dir, 'already-there.db');
    await Bun.write(outputPath, 'existing-output');

    const collision = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      outputPath,
    ]);

    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('--migrated-copy-output requires a path');
    expect(collision.exitCode).not.toBe(0);
    expect(collision.stdout).toBe('');
    expect(collision.stderr).toContain('migrated_copy_output_exists');
    expect(await readFile(outputPath, 'utf8')).toBe('existing-output');
  });

  test('rejects the source database and a hardlink alias as migrated-copy outputs', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const sourceAliasPath = join(dir, 'source-alias.db');
    await link(dbPath, sourceAliasPath);

    for (const outputPath of [dbPath, sourceAliasPath]) {
      const result = await runCli([
        '--source-copy',
        dbPath,
        '--expected-heartbeats',
        '2',
        '--migrated-copy-output',
        outputPath,
      ]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('migrated_copy_output_source_alias');
      expect(result.stderr).not.toContain(outputPath);
    }
  });

  test('rejects a configured live database path as the migrated-copy output', async () => {
    const { dbPath } = await makeLegacyFixture();
    const { dbPath: livePath } = await makeLegacyFixture();
    const result = await runCli(
      ['--source-copy', dbPath, '--expected-heartbeats', '2', '--migrated-copy-output', livePath],
      { BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS: JSON.stringify([livePath]) }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migrated_copy_output_forbidden');
    expect(result.stderr).not.toContain(livePath);
  });

  test('rejects source and known-live database sidecar namespaces as outputs', async () => {
    const { dbPath } = await makeLegacyFixture();
    const { dbPath: livePath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);
    const environment = {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS: JSON.stringify([livePath]),
    };

    for (const suffix of ['-wal', '-shm']) {
      for (const [outputPath, expectedCode] of [
        [`${dbPath}${suffix}`, 'migrated_copy_output_source_alias'],
        [`${livePath}${suffix}`, 'migrated_copy_output_forbidden'],
      ] as const) {
        const result = await runCli(
          [
            '--source-copy',
            dbPath,
            '--expected-heartbeats',
            '2',
            '--migrated-copy-output',
            outputPath,
          ],
          environment
        );

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(expectedCode);
        expect(result.stderr).not.toContain(dbPath);
        expect(result.stderr).not.toContain(livePath);
        expect(await Bun.file(outputPath).exists()).toBe(false);
        expect(await sha256(dbPath)).toBe(beforeHash);
      }
    }
  });

  test('rejects sidecar outputs reached through aliased source and known-live parents', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const { dir: liveDir, dbPath: livePath } = await makeLegacyFixture();
    const aliasRoot = await mkdtemp(join(tmpdir(), 'dispatch-sidecar-alias-test-'));
    temporaryDirectories.push(aliasRoot);
    const sourceParentAlias = join(aliasRoot, 'source-parent');
    const liveParentAlias = join(aliasRoot, 'live-parent');
    const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(dir, sourceParentAlias, directoryLinkType);
    await symlink(liveDir, liveParentAlias, directoryLinkType);
    const beforeHash = await sha256(dbPath);
    const environment = {
      BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS: JSON.stringify([livePath]),
    };

    for (const [outputPath, expectedCode] of [
      [join(sourceParentAlias, 'source-copy.db-wal'), 'migrated_copy_output_source_alias'],
      [join(liveParentAlias, 'source-copy.db-shm'), 'migrated_copy_output_forbidden'],
    ] as const) {
      const result = await runCli(
        [
          '--source-copy',
          dbPath,
          '--expected-heartbeats',
          '2',
          '--migrated-copy-output',
          outputPath,
        ],
        environment
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(expectedCode);
      expect(result.stderr).not.toContain(outputPath);
      expect(result.stderr).not.toContain(dbPath);
      expect(result.stderr).not.toContain(livePath);
      expect(await Bun.file(outputPath).exists()).toBe(false);
      expect(await sha256(dbPath)).toBe(beforeHash);
    }
  });

  test('rejects a sidecar output beside a supplied source file alias', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const sourceAliasPath = join(dir, 'source-file-alias.db');
    const outputPath = `${sourceAliasPath}-wal`;
    await symlink(dbPath, sourceAliasPath, 'file');
    const beforeHash = await sha256(dbPath);

    const result = await runCli([
      '--source-copy',
      sourceAliasPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      outputPath,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migrated_copy_output_source_alias');
    expect(result.stderr).not.toContain(sourceAliasPath);
    expect(result.stderr).not.toContain(outputPath);
    expect(await Bun.file(outputPath).exists()).toBe(false);
    expect(await sha256(dbPath)).toBe(beforeHash);
  });

  test('rejects supplied raw copies with source WAL or SHM sidecars before export', async () => {
    for (const suffix of ['-wal', '-shm']) {
      const { dir, dbPath } = await makeLegacyFixture();
      const sidecarPath = `${dbPath}${suffix}`;
      const outputPath = join(dir, `must-not-export${suffix}.db`);
      const sidecarSentinel = `SECRET-SOURCE-SIDECAR${suffix}`;
      await Bun.write(sidecarPath, sidecarSentinel);
      const beforeHash = await sha256(dbPath);

      const result = await runCli([
        '--source-copy',
        dbPath,
        '--expected-heartbeats',
        '2',
        '--migrated-copy-output',
        outputPath,
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('source_copy_sidecar_present');
      expect(result.stderr).not.toContain(dbPath);
      expect(result.stderr).not.toContain(sidecarPath);
      expect(result.stderr).not.toContain(outputPath);
      expect(result.stderr).not.toContain(sidecarSentinel);
      expect(await sha256(dbPath)).toBe(beforeHash);
      expect(await readFile(sidecarPath, 'utf8')).toBe(sidecarSentinel);
      expect(await Bun.file(outputPath).exists()).toBe(false);
    }
  });

  test('rejects a sidecar beside the supplied lexical source alias', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const sourceAliasPath = join(dir, 'source-alias-input.db');
    const aliasSidecarPath = `${sourceAliasPath}-wal`;
    const outputPath = join(dir, 'must-not-export-alias-source.db');
    const sidecarSentinel = 'SECRET-LEXICAL-SOURCE-SIDECAR';
    await symlink(dbPath, sourceAliasPath, 'file');
    await Bun.write(aliasSidecarPath, sidecarSentinel);
    const beforeHash = await sha256(dbPath);

    const result = await runCli([
      '--source-copy',
      sourceAliasPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      outputPath,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('source_copy_sidecar_present');
    expect(result.stderr).not.toContain(sourceAliasPath);
    expect(result.stderr).not.toContain(aliasSidecarPath);
    expect(result.stderr).not.toContain(outputPath);
    expect(result.stderr).not.toContain(sidecarSentinel);
    expect(await sha256(dbPath)).toBe(beforeHash);
    expect(await readFile(aliasSidecarPath, 'utf8')).toBe(sidecarSentinel);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test('rejects missing output parents before migration', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const beforeHash = await sha256(dbPath);
    const missingParentOutput = join(dir, 'missing-parent', 'output.db');

    const missingParent = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '2',
      '--migrated-copy-output',
      missingParentOutput,
    ]);

    expect(missingParent.exitCode).not.toBe(0);
    expect(missingParent.stdout).toBe('');
    expect(missingParent.stderr).toContain('migrated_copy_output_unavailable');
    expect(missingParent.stderr).not.toContain(missingParentOutput);
    expect(await sha256(dbPath)).toBe(beforeHash);
    expect(await Bun.file(missingParentOutput).exists()).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'rejects dangling output aliases before migration',
    async () => {
      const { dir, dbPath } = await makeLegacyFixture();
      const beforeHash = await sha256(dbPath);
      const danglingOutput = join(dir, 'dangling-output.db');
      await symlink(join(dir, 'missing-target.db'), danglingOutput, 'file');

      const dangling = await runCli([
        '--source-copy',
        dbPath,
        '--expected-heartbeats',
        '2',
        '--migrated-copy-output',
        danglingOutput,
      ]);

      expect(dangling.exitCode).not.toBe(0);
      expect(dangling.stdout).toBe('');
      expect(dangling.stderr).toContain('migrated_copy_output_exists');
      expect(dangling.stderr).not.toContain(danglingOutput);
      expect((await lstat(danglingOutput)).isSymbolicLink()).toBe(true);
      expect(await sha256(dbPath)).toBe(beforeHash);
    }
  );

  test('does not export when migration validation fails', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'must-not-exist.db');

    const result = await runCli([
      '--source-copy',
      dbPath,
      '--expected-heartbeats',
      '3',
      '--migrated-copy-output',
      outputPath,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('expected 3 heartbeat rows, found 2');
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test('does not export when the validated copy cannot checkpoint WAL state', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'checkpoint-must-not-export.db');
    const result = await runCli(
      ['--source-copy', dbPath, '--expected-heartbeats', '2', '--migrated-copy-output', outputPath],
      { BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_CHECKPOINT: '1' }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migrated_copy_checkpoint_failed');
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test('removes an in-progress partial export when copy creation fails', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'partial-during-copy.db');
    const result = await runCli(
      ['--source-copy', dbPath, '--expected-heartbeats', '2', '--migrated-copy-output', outputPath],
      { BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_EXPORT_DURING_COPY: '1' }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migrated_copy_export_failed');
    expect(await Bun.file(outputPath).exists()).toBe(false);
    expect(await readdir(dir)).toEqual(['source-copy.db']);
  });

  test('removes a partial migrated-copy output when export fails after the copy', async () => {
    const { dir, dbPath } = await makeLegacyFixture();
    const outputPath = join(dir, 'partial-output.db');
    const result = await runCli(
      ['--source-copy', dbPath, '--expected-heartbeats', '2', '--migrated-copy-output', outputPath],
      { BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_EXPORT_AFTER_COPY: '1' }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('migrated_copy_export_failed');
    expect(result.stderr).not.toContain(outputPath);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });
});
