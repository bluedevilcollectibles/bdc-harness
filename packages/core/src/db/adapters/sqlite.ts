/**
 * SQLite adapter using bun:sqlite
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IDatabase, QueryResult, SqlDialect } from './types';
import { createLogger } from '@archon/paths';
import { installM31TargetV2Sqlite } from '../m31-target-v2-sqlite';
import { installOverseerControlPlaneSqlite } from '../overseer-control-plane-sqlite';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('db.sqlite');
  return cachedLog;
}

export class SqliteAdapter implements IDatabase {
  private db: Database;
  readonly dialect = 'sqlite' as const;
  readonly sql: SqlDialect = sqliteDialect;
  /** M-42 Slice 8: registration of reviewed isolated Wave 2 schema installers. */
  private wave2SchemaPromise: Promise<void> | null = null;
  /** Re-entrancy guard while installers call this.query(). */
  private wave2Installing = false;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.run('PRAGMA journal_mode = WAL');

    // Retry busy locks up to 5s to avoid SQLITE_BUSY during parallel workflows
    this.db.run('PRAGMA busy_timeout = 5000');

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON');

    // Initialize schema if needed
    this.initSchema();
  }

  /**
   * Await central registration of M-31 target-v2 and control-plane SQLite schemas.
   * Slice 8 alone registers these reviewed isolated installers.
   * Installers are idempotent (IF NOT EXISTS). Invoked on first query so
   * constructor teardown races in tests cannot hit a closed database handle.
   */
  async ensureWave2Schemas(): Promise<void> {
    if (!this.wave2SchemaPromise) {
      this.wave2SchemaPromise = (async (): Promise<void> => {
        this.wave2Installing = true;
        try {
          await installM31TargetV2Sqlite(this);
          await installOverseerControlPlaneSqlite(this);
        } finally {
          this.wave2Installing = false;
        }
      })();
    }
    await this.wave2SchemaPromise;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    // Register Wave 2 isolated schemas before any application query.
    // Skip while installers themselves are issuing CREATE statements.
    if (!this.wave2Installing) {
      await this.ensureWave2Schemas();
    }

    // Convert $1, $2, etc. to ? placeholders and reorder params to match
    const { sql: convertedSql, params: reorderedParams } = this.convertPlaceholders(
      sql,
      params ?? []
    );

    try {
      // Determine if this is a SELECT or mutation
      const trimmedSql = sql.trim().toUpperCase();
      const isSelect =
        trimmedSql.startsWith('SELECT') ||
        trimmedSql.startsWith('WITH') ||
        trimmedSql.startsWith('PRAGMA');

      // Cast params to SQLite's expected type
      const sqliteParams = reorderedParams as SQLQueryBindings[];

      if (isSelect) {
        const stmt = this.db.prepare(convertedSql);
        try {
          const rows = stmt.all(...sqliteParams) as T[];
          return { rows, rowCount: rows.length };
        } finally {
          stmt.finalize();
        }
      } else {
        const upperSql = sql.toUpperCase();

        // Handle INSERT with RETURNING using native SQLite RETURNING (3.35+)
        // We must use .all() instead of .run() because .run() discards
        // RETURNING results, and its lastInsertRowid is unreliable when
        // ON CONFLICT DO UPDATE fires.
        if (upperSql.includes('RETURNING') && upperSql.includes('INSERT')) {
          const stmt = this.db.prepare(convertedSql);
          try {
            const rows = stmt.all(...sqliteParams) as T[];
            return { rows, rowCount: rows.length };
          } finally {
            stmt.finalize();
          }
        }

        // UPDATE/DELETE with RETURNING not supported
        if (upperSql.includes('RETURNING')) {
          throw new Error(
            'SQLite adapter does not support RETURNING clause on UPDATE/DELETE statements. ' +
              `Query: ${convertedSql.substring(0, 100)}... ` +
              'Hint: Use a SELECT before the mutation if you need the row data.'
          );
        }

        // Standard INSERT/UPDATE/DELETE without RETURNING
        const stmt = this.db.prepare(convertedSql);
        try {
          const result = stmt.run(...sqliteParams);
          return { rows: [], rowCount: result.changes };
        } finally {
          stmt.finalize();
        }
      }
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, sql: convertedSql, params }, 'db.sqlite_query_failed');
      throw error;
    }
  }

  async withTransaction<T>(
    fn: (query: <U>(sql: string, params?: unknown[]) => Promise<QueryResult<U>>) => Promise<T>
  ): Promise<T> {
    await this.query('BEGIN');
    try {
      const result = await fn(this.query.bind(this));
      await this.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await this.query('ROLLBACK');
      } catch (rollbackError) {
        getLog().error({ err: rollbackError as Error }, 'db.sqlite_transaction_rollback_failed');
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    // Checkpoint and truncate the WAL before closing so the -wal/-shm files are
    // released; on Windows a lingering WAL handle makes rmSync fail with EBUSY.
    try {
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Best-effort: closing matters more than the checkpoint.
    }
    this.db.close();
    // Bun keeps the sqlite file handle alive in a GC finalizer after close();
    // on Windows this makes rmSync on the db directory fail with EBUSY until a
    // collection runs. Force one so close() means closed. (Verified 2026-07-13:
    // rm fails after close(), succeeds after Bun.gc(true).)
    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
  }

  /** Run a PRAGMA query and finalize the statement immediately. */
  private pragmaAll(sql: string): unknown[] {
    const stmt = this.db.prepare(sql);
    try {
      return stmt.all();
    } finally {
      stmt.finalize();
    }
  }

  /**
   * Convert PostgreSQL $1, $2 placeholders to SQLite ? placeholders.
   *
   * PostgreSQL uses explicit indices ($1, $2) so params can appear in any order
   * in SQL. SQLite uses positional ? -- so params must be reordered to match the
   * left-to-right order of placeholders in the SQL string.
   *
   * Example: SQL has "$2 ... $1" with params [id, json] ->
   *   converted SQL: "? ... ?" with reordered params [json, id]
   */
  private convertPlaceholders(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
    // Collect $N placeholders in order of appearance
    const placeholderOrder: number[] = [];
    const convertedSql = sql
      .replace(/\$(\d+)/g, (_match, indexStr: string) => {
        placeholderOrder.push(Number(indexStr));
        return '?';
      })
      .replace(/::jsonb/g, '')
      .replace(/::INTERVAL/g, '');

    // Reorder params to match the positional order of ? in the SQL.
    // $N is 1-based, so $1 -> params[0], $2 -> params[1], etc.
    const reordered =
      placeholderOrder.length > 0 ? placeholderOrder.map(idx => params[idx - 1]) : params;

    return { sql: convertedSql, params: reordered };
  }

  /**
   * Initialize database schema.
   * Always runs createSchema() since all statements use IF NOT EXISTS,
   * ensuring new tables from migrations are created in existing databases.
   */
  private initSchema(): void {
    this.createSchema();
    this.migrateColumns();
    this.seedDispatchPrincipals();
    // Phase 1.5 partial unique indexes must run only after sender_principal_id exists.
    const postMigrateCols = this.pragmaAll("PRAGMA table_info('agent_dispatch_messages')") as {
      name: string;
    }[];
    if (postMigrateCols.some(column => column.name === 'sender_principal_id')) {
      this.db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_sender_idempotency_authenticated
         ON agent_dispatch_messages(sender_principal_id, idempotency_key)
         WHERE sender_principal_id IS NOT NULL`
      );
      this.db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_idempotency_legacy
         ON agent_dispatch_messages(idempotency_key)
         WHERE sender_principal_id IS NULL`
      );
    }
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_dispatch_board_pending ON agent_dispatch_messages(recipient_alias, status, created_at)'
    );
    const dispatchColumns = this.pragmaAll("PRAGMA table_info('agent_dispatch_messages')") as {
      name: string;
    }[];
    if (dispatchColumns.some(column => column.name === 'subject_key')) {
      this.db.run(
        'CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_subject_history ON agent_dispatch_messages(subject_key, created_at DESC, id DESC) WHERE subject_key IS NOT NULL'
      );
    }
    // Taskmaster Slice 1 indexes (migration 041) -- after migrateColumns()
    // per the established pattern.
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_tm_journal_thread ON tm_journal(thread_ref, created_at)'
    );
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tm_journal_idem ON tm_journal(idempotency_key)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tm_journal_created ON tm_journal(created_at)');
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_tm_usage_provider ON tm_usage_sample(provider, observed_at)'
    );
    // Taskmaster adoption projection indexes (migration 043) -- after migrateColumns()
    // per the established pattern.
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tm_adoption_snapshot ON tm_adoption(snapshot_id)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tm_adoption_thread ON tm_adoption(thread_ref)');
  }

  /**
   * Add columns to existing tables that predate newer schema additions.
   * SQLite's CREATE TABLE IF NOT EXISTS skips entirely for existing tables,
   * so new columns must be added via ALTER TABLE for databases created before
   * the columns were added to createSchema().
   */
  private migrateColumns(): void {
    // Migration 045: SQLite cannot alter CHECK constraints. Rebuild existing
    // four-verb journals transactionally before any fire_cauldron insert.
    const journalSchema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_journal'")
      .get() as { sql?: string } | undefined;
    if (journalSchema?.sql && !journalSchema.sql.includes('fire_cauldron')) {
      this.db.run('BEGIN');
      try {
        this.db.run(`
          CREATE TABLE tm_journal_new (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            thread_ref TEXT NOT NULL,
            action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')),
            proposal_json TEXT NOT NULL,
            idempotency_key TEXT,
            before_hash TEXT,
            proof_predicate TEXT,
            proof_deadline_at TEXT,
            outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')),
            graded_at TEXT,
            grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful'))
          );
          INSERT INTO tm_journal_new SELECT * FROM tm_journal;
          DROP TABLE tm_journal;
          ALTER TABLE tm_journal_new RENAME TO tm_journal;
        `);
        this.db.run('COMMIT');
      } catch (error: unknown) {
        this.db.run('ROLLBACK');
        throw error;
      }
    }
    // Migration 046: older on-disk databases used a composite primary key for
    // tm_health. Add a provider-only UNIQUE index (allowed by the WO) instead
    // of rebuilding: table constraints, columns, indexes and triggers survive.
    const hasHealthConflictTarget = (): boolean =>
      this.db
        .prepare(
          `
          SELECT 1 FROM pragma_index_list('tm_health') AS idx
          WHERE idx."unique" = 1 AND idx.partial = 0
            AND (SELECT COUNT(*) FROM pragma_index_info(idx.name)) = 1
            AND (SELECT name FROM pragma_index_info(idx.name)) = 'provider'
          LIMIT 1
        `
        )
        .get() != null;
    if (!hasHealthConflictTarget()) {
      this.db.run('BEGIN IMMEDIATE');
      try {
        // Another connection may have repaired it while this one awaited the
        // writer lock. Recheck before deleting rows or creating the index.
        if (!hasHealthConflictTarget()) {
          this.db.run(`
            DELETE FROM tm_health AS older
            WHERE EXISTS (
              SELECT 1 FROM tm_health AS newer
              WHERE newer.provider = older.provider
                AND (newer.sampled_at > older.sampled_at
                  OR (newer.sampled_at = older.sampled_at AND newer.rowid > older.rowid))
            );
            CREATE UNIQUE INDEX tm_health_provider_unique ON tm_health(provider);
          `);
        }
        this.db.run('COMMIT');
      } catch (error: unknown) {
        this.db.run('ROLLBACK');
        throw error;
      }
    }
    // Conversations columns
    try {
      const cols = this.pragmaAll("PRAGMA table_info('remote_agent_conversations')") as {
        name: string;
      }[];
      const colNames = new Set(cols.map(c => c.name));

      if (!colNames.has('title')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN title TEXT');
      }
      if (!colNames.has('deleted_at')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN deleted_at TEXT');
      }
      if (!colNames.has('hidden')) {
        this.db.run('ALTER TABLE remote_agent_conversations ADD COLUMN hidden INTEGER DEFAULT 0');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_conversations_columns_failed');
    }

    // Workflow runs columns
    try {
      const wfCols = this.pragmaAll("PRAGMA table_info('remote_agent_workflow_runs')") as {
        name: string;
      }[];
      const wfColNames = new Set(wfCols.map(c => c.name));

      if (!wfColNames.has('parent_conversation_id')) {
        this.db.run(
          'ALTER TABLE remote_agent_workflow_runs ADD COLUMN parent_conversation_id TEXT'
        );
      }

      if (!wfColNames.has('working_path')) {
        this.db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN working_path TEXT');
      }

      if (!wfColNames.has('archived_at')) {
        this.db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN archived_at TEXT');
      }

      if (!wfColNames.has('archived_by')) {
        this.db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN archived_by TEXT');
      }

      if (!wfColNames.has('archive_reason')) {
        this.db.run('ALTER TABLE remote_agent_workflow_runs ADD COLUMN archive_reason TEXT');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_workflow_runs_columns_failed');
    }

    // Sessions columns
    try {
      const sessCols = this.pragmaAll("PRAGMA table_info('remote_agent_sessions')") as {
        name: string;
      }[];
      const sessColNames = new Set(sessCols.map(c => c.name));

      if (!sessColNames.has('ended_reason')) {
        this.db.run('ALTER TABLE remote_agent_sessions ADD COLUMN ended_reason TEXT');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_session_columns_failed');
    }

    // Dispatch board-motion and agent messaging columns
    try {
      const boardColumns: [string, string][] = [
        ['recipient_alias', "TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board')"],
        ['motion_id', 'TEXT'],
        [
          'motion_revision_sha',
          "TEXT CHECK (motion_revision_sha IS NULL OR motion_revision_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')",
        ],
        ['resolved_recipient', 'TEXT'],
        ['resolved_xo_lease_id', 'TEXT'],
        [
          'resolved_xo_fencing_token',
          'INTEGER CHECK (resolved_xo_fencing_token IS NULL OR resolved_xo_fencing_token > 0)',
        ],
        ['resolved_at', 'TEXT'],
      ];
      const phase0Columns: [string, string][] = [
        [
          'priority',
          "TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat'))",
        ],
        [
          'task_outcome',
          "TEXT CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked'))",
        ],
        ['acknowledged_at', 'TEXT'],
        ['acknowledged_by', 'TEXT'],
        ['addressed_at', 'TEXT'],
        ['addressed_by', 'TEXT'],
        ['escalated_tg_at', 'TEXT'],
        ['escalated_sms_at', 'TEXT'],
        ['subject_key', 'TEXT'],
        ['repeat_reason', 'TEXT'],
        [
          'route_disposition',
          "TEXT CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded'))",
        ],
        ['supersedes_id', 'TEXT REFERENCES agent_dispatch_messages(id)'],
      ];
      const boardDispatchCols = this.db
        .prepare("PRAGMA table_info('agent_dispatch_messages')")
        .all() as { name: string }[];
      const boardDispatchColNames = new Set(boardDispatchCols.map(c => c.name));
      for (const [name, definition] of boardColumns) {
        if (!boardDispatchColNames.has(name)) {
          this.db.run(`ALTER TABLE agent_dispatch_messages ADD COLUMN ${name} ${definition}`);
        }
      }

      this.db.run('BEGIN');
      try {
        const dispatchCols = this.db
          .prepare("PRAGMA table_info('agent_dispatch_messages')")
          .all() as { name: string }[];
        const dispatchColNames = new Set(dispatchCols.map(c => c.name));
        const priorityNeedsBackfill = !dispatchColNames.has('priority');
        for (const [name, definition] of [...boardColumns, ...phase0Columns]) {
          if (!dispatchColNames.has(name)) {
            this.db.run(`ALTER TABLE agent_dispatch_messages ADD COLUMN ${name} ${definition}`);
          }
        }
        if (priorityNeedsBackfill) {
          this.db.run(
            "UPDATE agent_dispatch_messages SET priority = 'heartbeat' WHERE status = 'queued' AND task_type = 'run_report'"
          );
        }
        this.db.run('COMMIT');
      } catch (error: unknown) {
        try {
          this.db.run('ROLLBACK');
        } catch (rollbackError: unknown) {
          getLog().error(
            { err: rollbackError as Error },
            'db.sqlite_migration_dispatch_columns_rollback_failed'
          );
        }
        throw error;
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_dispatch_columns_failed');
    }

    this.migrateDispatchSenderPrincipalIdempotency();

    try {
      const actionCols = this.db
        .prepare("PRAGMA table_info('remote_agent_supervisor_actions')")
        .all() as { name: string }[];
      const actionColNames = new Set(actionCols.map(c => c.name));
      if (!actionColNames.has('status')) {
        this.db.run(
          "ALTER TABLE remote_agent_supervisor_actions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('reserved', 'completed', 'failed'))"
        );
      }
      if (!actionColNames.has('completed_at')) {
        this.db.run('ALTER TABLE remote_agent_supervisor_actions ADD COLUMN completed_at TEXT');
      }
    } catch (e: unknown) {
      getLog().warn({ err: e as Error }, 'db.sqlite_migration_supervisor_action_columns_failed');
    }
  }

  /**
   * Phase 1.5: add nullable sender_principal_id and replace the global UNIQUE
   * idempotency constraint with two partial unique indexes. Rebuild is fatal on
   * failure -- it must not be swallowed by the best-effort migration warn path.
   */
  private migrateDispatchSenderPrincipalIdempotency(): void {
    const tableExists = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_messages'"
      )
      .get() as { name?: string } | null;
    if (!tableExists?.name) return;

    const cols = this.db.prepare("PRAGMA table_info('agent_dispatch_messages')").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const colNames = new Set(cols.map(c => c.name));
    // Phase 0 must land first. Rebuilding before priority/subject_key exist would
    // bypass the Phase 0 transactional backfill contract on failed opens.
    if (!colNames.has('priority') || !colNames.has('subject_key')) {
      return;
    }
    const priorityCol = cols.find(c => c.name === 'priority');
    // Refuse malformed Phase 0 priority definitions rather than silently healing them.
    if (priorityCol?.type.toUpperCase() !== 'TEXT' || priorityCol.notnull !== 1) {
      throw new Error('dispatch_phase15_priority_definition_invalid');
    }
    if (!colNames.has('sender_principal_id')) {
      this.db.run('ALTER TABLE agent_dispatch_messages ADD COLUMN sender_principal_id TEXT');
    }

    const indexRows = this.db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_dispatch_messages'"
      )
      .all() as { name: string; sql: string | null }[];
    const hasAuth = indexRows.some(
      row => row.name === 'uq_agent_dispatch_messages_sender_idempotency_authenticated'
    );
    const hasLegacy = indexRows.some(
      row => row.name === 'uq_agent_dispatch_messages_idempotency_legacy'
    );
    const tableSqlRow = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_messages'"
      )
      .get() as { sql: string } | null;
    const tableSql = tableSqlRow?.sql ?? '';
    const hasInlineUnique =
      /idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql) ||
      /UNIQUE\s*\(\s*idempotency_key\s*\)/i.test(tableSql);

    if (!hasInlineUnique) {
      // Column present and no inline UNIQUE -- only ensure partial indexes.
      // Do not recreate or redefine non-unique helper indexes here; smoke validation
      // catches wrong-definition leftovers on already-migrated schemas.
      if (!hasAuth) {
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_sender_idempotency_authenticated
           ON agent_dispatch_messages(sender_principal_id, idempotency_key)
           WHERE sender_principal_id IS NOT NULL`
        );
      }
      if (!hasLegacy) {
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_idempotency_legacy
           ON agent_dispatch_messages(idempotency_key)
           WHERE sender_principal_id IS NULL`
        );
      }
      return;
    }

    // Disable FKs outside the rebuild transaction so the setting sticks.
    this.db.run('PRAGMA foreign_keys = OFF');
    try {
      this.db.run('BEGIN');
      try {
        this.db.run(`
          CREATE TABLE agent_dispatch_messages__phase15 (
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
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            claimed_at TEXT,
            completed_at TEXT,
            not_before TEXT,
            lease_owner TEXT,
            lease_expires_at TEXT,
            fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
            recipient_alias TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board'),
            motion_id TEXT,
            motion_revision_sha TEXT CHECK (motion_revision_sha IS NULL OR motion_revision_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
            resolved_recipient TEXT,
            resolved_xo_lease_id TEXT,
            resolved_xo_fencing_token INTEGER CHECK (resolved_xo_fencing_token IS NULL OR resolved_xo_fencing_token > 0),
            resolved_at TEXT,
            priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat')),
            task_outcome TEXT CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked')),
            acknowledged_at TEXT,
            acknowledged_by TEXT,
            addressed_at TEXT,
            addressed_by TEXT,
            escalated_tg_at TEXT,
            escalated_sms_at TEXT,
            subject_key TEXT,
            repeat_reason TEXT,
            route_disposition TEXT CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded')),
            supersedes_id TEXT REFERENCES agent_dispatch_messages__phase15(id)
          )
        `);

        const sourceCols = this.db
          .prepare("PRAGMA table_info('agent_dispatch_messages')")
          .all() as { name: string }[];
        const sourceNames = new Set(sourceCols.map(c => c.name));
        const targetCols = [
          'id',
          'correlation_id',
          'idempotency_key',
          'task_type',
          'sender',
          'sender_principal_id',
          'recipient',
          'body',
          'status',
          'result_body',
          'created_at',
          'claimed_at',
          'completed_at',
          'not_before',
          'lease_owner',
          'lease_expires_at',
          'fencing_token',
          'recipient_alias',
          'motion_id',
          'motion_revision_sha',
          'resolved_recipient',
          'resolved_xo_lease_id',
          'resolved_xo_fencing_token',
          'resolved_at',
          'priority',
          'task_outcome',
          'acknowledged_at',
          'acknowledged_by',
          'addressed_at',
          'addressed_by',
          'escalated_tg_at',
          'escalated_sms_at',
          'subject_key',
          'repeat_reason',
          'route_disposition',
          'supersedes_id',
        ];
        const selectExprs = targetCols.map(name =>
          sourceNames.has(name) ? name : 'NULL AS ' + name
        );
        this.db.run(
          `INSERT INTO agent_dispatch_messages__phase15 (${targetCols.join(', ')})
           SELECT ${selectExprs.join(', ')} FROM agent_dispatch_messages`
        );
        this.db.run('DROP TABLE agent_dispatch_messages');
        this.db.run(
          'ALTER TABLE agent_dispatch_messages__phase15 RENAME TO agent_dispatch_messages'
        );

        this.db.run(
          'CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_recipient_status ON agent_dispatch_messages(recipient, status)'
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_lease_expiry ON agent_dispatch_messages(lease_expires_at) WHERE status = 'claimed'"
        );
        this.db.run(
          'CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_subject_history ON agent_dispatch_messages(subject_key, created_at DESC, id DESC) WHERE subject_key IS NOT NULL'
        );
        this.db.run(
          'CREATE INDEX IF NOT EXISTS idx_dispatch_board_pending ON agent_dispatch_messages(recipient_alias, status, created_at)'
        );
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_sender_idempotency_authenticated
           ON agent_dispatch_messages(sender_principal_id, idempotency_key)
           WHERE sender_principal_id IS NOT NULL`
        );
        this.db.run(
          `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_dispatch_messages_idempotency_legacy
           ON agent_dispatch_messages(idempotency_key)
           WHERE sender_principal_id IS NULL`
        );
        this.db.run('COMMIT');
      } catch (error: unknown) {
        try {
          this.db.run('ROLLBACK');
        } catch {
          /* ignore rollback failure; surface original */
        }
        throw error;
      }

      const fkCheck = this.db.prepare('PRAGMA foreign_key_check').all();
      if (fkCheck.length > 0) {
        throw new Error('dispatch_phase15_foreign_key_check_failed');
      }
    } finally {
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }

  private seedDispatchPrincipals(): void {
    this.db.run(`
      INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
      VALUES
        ('claude', 'Claude', 'worker_poll', 1),
        ('codex', 'Codex', 'worker_poll', 1),
        ('grok', 'Grok', 'worker_poll', 1),
        ('cursor', 'Cursor', 'worker_poll', 1),
        ('fusion', 'Fusion', 'worker_poll', 1),
        ('claude-acp', 'Claude ACP', 'worker_poll', 1),
        ('codex-mcp', 'Codex MCP', 'worker_poll', 1),
        ('grok-acp', 'Grok ACP', 'worker_poll', 1),
        ('operator', 'Operator', 'drain_on_start', 1),
        ('xo', 'XO', 'drain_on_start', 1),
        ('board', 'Board', 'alias_resolved', 1),
        ('overseer', 'Overseer', 'notify_only', 1),
        ('cauldron', 'Cauldron', 'notify_only', 1),
        ('john', 'John', 'notify_only', 0),
        ('merge-manager', 'Merge Manager', 'notify_only', 0),
        -- WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 (migration 043 parity): keep the
        -- SQLite seed in sync with 000_combined.sql -- this INSERT block is a
        -- hand-maintained mirror, not derived from the migration files.
        ('overseer-reviewer', 'Overseer PR Reviewer', 'worker_poll', 1),
        ('overseer-review-route', 'Overseer Review Route', 'notify_only', 1)
      ON CONFLICT (principal_id) DO NOTHING
    `);
    this.db.run(`
      INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
      SELECT DISTINCT
        LOWER(TRIM(recipient)),
        LOWER(TRIM(recipient)),
        'drain_on_start',
        1
      FROM agent_dispatch_messages
      WHERE TRIM(recipient) <> ''
      ON CONFLICT (principal_id) DO NOTHING
    `);
  }

  /**
   * Create all tables.
   *
   * NOTE: NOT NULL constraint changes on existing columns (e.g., branch_name in
   * isolation_environments, user_message in workflow_runs, name in codebases) are only
   * enforced for new databases. For existing databases, CREATE TABLE IF NOT EXISTS is a
   * no-op so the old schema remains. SQLite lacks ALTER COLUMN support; enforcing new
   * constraints on existing tables would require a table rebuild via migrateColumns().
   */
  private createSchema(): void {
    this.db.run(`
      -- Codebases table
      CREATE TABLE IF NOT EXISTS remote_agent_codebases (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        repository_url TEXT,
        default_cwd TEXT NOT NULL,
        default_branch TEXT DEFAULT 'main',
        ai_assistant_type TEXT DEFAULT 'claude',
        commands TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Codebase env vars table
      CREATE TABLE IF NOT EXISTS remote_agent_codebase_env_vars (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(codebase_id, key)
      );

      -- Conversations table
      CREATE TABLE IF NOT EXISTS remote_agent_conversations (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        platform_type TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL,
        ai_assistant_type TEXT DEFAULT 'claude',
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        cwd TEXT,
        isolation_env_id TEXT,
        title TEXT,
        deleted_at TEXT,
        hidden INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_activity_at TEXT DEFAULT (datetime('now')),
        UNIQUE(platform_type, platform_conversation_id)
      );

      -- Sessions table
      CREATE TABLE IF NOT EXISTS remote_agent_sessions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        ai_assistant_type TEXT NOT NULL DEFAULT 'claude',
        assistant_session_id TEXT,
        active INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        ended_at TEXT,
        parent_session_id TEXT REFERENCES remote_agent_sessions(id),
        transition_reason TEXT,
        ended_reason TEXT
      );

      -- Isolation environments table
      CREATE TABLE IF NOT EXISTS remote_agent_isolation_environments (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        codebase_id TEXT NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'worktree',
        working_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        created_by_platform TEXT,
        metadata TEXT DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
        -- Note: uniqueness enforced via partial index below (only active environments)
      );

      -- Partial unique index: only active environments need uniqueness
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
        ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
        WHERE status = 'active';

      -- Workflow runs table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_runs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        codebase_id TEXT REFERENCES remote_agent_codebases(id) ON DELETE SET NULL,
        workflow_name TEXT NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        current_step_index INTEGER,
        metadata TEXT DEFAULT '{}',
        parent_conversation_id TEXT REFERENCES remote_agent_conversations(id) ON DELETE SET NULL,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        last_activity_at TEXT DEFAULT (datetime('now')),
        working_path TEXT,
        archived_at TEXT,
        archived_by TEXT,
        archive_reason TEXT
      );

      -- Workflow events table
      CREATE TABLE IF NOT EXISTS remote_agent_workflow_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        workflow_run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        step_index INTEGER,
        step_name TEXT,
        data TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Smart Cauldron reliability authority (immutable after insert)
      CREATE TABLE IF NOT EXISTS remote_agent_run_authorities (
        run_id TEXT PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        dispatch_id TEXT NOT NULL,
        wo_id TEXT NOT NULL,
        spec_source TEXT NOT NULL,
        spec_revision TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        codebase_id TEXT NOT NULL,
        canonical_remote TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        run_scope_sha TEXT NOT NULL,
        head_branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        workflow_revision TEXT NOT NULL,
        bundle_revision TEXT NOT NULL,
        engine_revision TEXT NOT NULL,
        runtime_image_revision TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_authorities_dispatch_id
        ON remote_agent_run_authorities(dispatch_id);

      -- One renewable worker lease per workflow run
      CREATE TABLE IF NOT EXISTS remote_agent_run_leases (
        run_id TEXT PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        lease_token TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );

      -- Provider call ledger; rows are inserted before each call and completed once
      CREATE TABLE IF NOT EXISTS remote_agent_provider_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        declared_provider TEXT NOT NULL,
        declared_model TEXT NOT NULL,
        required_capabilities TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        served_model_id TEXT,
        outcome_class TEXT CHECK (
          outcome_class IS NULL OR outcome_class IN
            ('success', 'availability', 'quality', 'progress', 'quota', 'contradiction', 'cancelled')
        ),
        reason_code TEXT,
        resume_at TEXT,
        supersedes_attempt_id TEXT REFERENCES remote_agent_provider_attempts(attempt_id),
        UNIQUE(run_id, node_id, attempt_number)
      );

      -- Authoritative multidimensional outcome; legacy workflow status remains a projection
      CREATE TABLE IF NOT EXISTS remote_agent_run_outcomes (
        run_id TEXT PRIMARY KEY REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        execution_state TEXT NOT NULL CHECK (
          execution_state IN
            ('queued', 'running', 'waiting_provider', 'paused_human', 'interrupted', 'completed', 'failed', 'cancelled')
        ),
        deliverable_state TEXT NOT NULL CHECK (
          deliverable_state IN ('none', 'worktree_changes', 'committed', 'pushed', 'pr_open', 'pr_ready')
        ),
        validation_state TEXT NOT NULL CHECK (
          validation_state IN ('not_run', 'passed', 'failed', 'indeterminate')
        ),
        recovery_state TEXT NOT NULL CHECK (
          recovery_state IN ('not_needed', 'recoverable', 'recovering', 'recovered', 'abandoned_by_operator')
        ),
        route_state TEXT NOT NULL CHECK (
          route_state IN ('current', 'failed_over', 'escalated', 'spec_repair', 'exhausted')
        ),
        primary_reason TEXT NOT NULL,
        reason_codes TEXT NOT NULL DEFAULT '[]',
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      -- Durable quota/provider waits replace in-process sleeps
      CREATE TABLE IF NOT EXISTS remote_agent_scheduled_waits (
        wait_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL REFERENCES remote_agent_provider_attempts(attempt_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        resume_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'scheduled' CHECK (
          state IN ('scheduled', 'claimed', 'cancelled', 'completed')
        ),
        claim_owner_id TEXT,
        claim_token TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        cancelled_at TEXT,
        completed_at TEXT
      );

      -- Dual-supervisor coordination; observations are multi-writer, repairs are fenced
      CREATE TABLE IF NOT EXISTS remote_agent_supervisor_incidents (
        incident_id TEXT PRIMARY KEY,
        incident_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        wo_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'repairing', 'recovered', 'escalated')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_agent_supervisor_observations (
        observation_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
        supervisor_id TEXT NOT NULL,
        assessment TEXT NOT NULL,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS remote_agent_supervisor_repair_leases (
        incident_id TEXT PRIMARY KEY REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        acquired_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS remote_agent_supervisor_actions (
        action_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES remote_agent_supervisor_incidents(incident_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        action_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('reserved', 'completed', 'failed')),
        completed_at TEXT
      );

      -- Durable maintenance admission state (singleton) and audit trail
      CREATE TABLE IF NOT EXISTS remote_agent_cauldron_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL CHECK (mode IN ('normal', 'draining')),
        updated_at TEXT,
        updated_by TEXT
      );
      INSERT INTO remote_agent_cauldron_control (id, mode)
      VALUES (1, 'normal')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS remote_agent_cauldron_control_events (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        from_mode TEXT NOT NULL CHECK (from_mode IN ('normal', 'draining')),
        to_mode TEXT NOT NULL CHECK (to_mode IN ('normal', 'draining')),
        actor TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      -- Messages table (conversation history for Web UI)
      CREATE TABLE IF NOT EXISTS remote_agent_messages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        conversation_id TEXT NOT NULL REFERENCES remote_agent_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Blue Devil Dispatch message drop-box
      CREATE TABLE IF NOT EXISTS agent_dispatch_messages (
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
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        claimed_at TEXT,
        completed_at TEXT,
        not_before TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
        recipient_alias TEXT CHECK (recipient_alias IS NULL OR recipient_alias = 'board'),
        motion_id TEXT,
        motion_revision_sha TEXT CHECK (motion_revision_sha IS NULL OR motion_revision_sha GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
        resolved_recipient TEXT,
        resolved_xo_lease_id TEXT,
        resolved_xo_fencing_token INTEGER CHECK (resolved_xo_fencing_token IS NULL OR resolved_xo_fencing_token > 0),
        resolved_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('blocker', 'normal', 'heartbeat')),
        task_outcome TEXT CHECK (task_outcome IS NULL OR task_outcome IN ('succeeded', 'failed', 'blocked')),
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        addressed_at TEXT,
        addressed_by TEXT,
        escalated_tg_at TEXT,
        escalated_sms_at TEXT,
        subject_key TEXT,
        repeat_reason TEXT,
        route_disposition TEXT CHECK (route_disposition IS NULL OR route_disposition IN ('unroutable', 'superseded')),
        supersedes_id TEXT REFERENCES agent_dispatch_messages(id)
      );

      CREATE TABLE IF NOT EXISTS dispatch_principals (
        principal_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('worker_poll', 'drain_on_start', 'alias_resolved', 'notify_only')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS agent_dispatch_workers (
        worker_id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}',
        max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable')),
        registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS known_bad_bindings (
        id TEXT PRIMARY KEY,
        binding_key TEXT NOT NULL UNIQUE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        auth_context_id TEXT NOT NULL,
        assistant_config_hash TEXT NOT NULL,
        node_override_hash TEXT NOT NULL DEFAULT '',
        error_class TEXT NOT NULL,
        http_status INTEGER,
        error_body_excerpt TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        cleared_at TEXT,
        clear_reason TEXT
      );

      -- Board authority foundation
      CREATE TABLE IF NOT EXISTS board_xo_leases (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lease_id TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        seat_id TEXT NOT NULL CHECK (seat_id IN ('john', 'general', 'xo')),
        holder_id TEXT NOT NULL,
        holder_token_hash TEXT NOT NULL,
        fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
        acquired_at TEXT NOT NULL,
        renewed_at TEXT,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS board_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'xo_lease_acquired',
            'xo_lease_acquire_rejected',
            'xo_lease_renewed',
            'xo_lease_renew_rejected',
            'xo_lease_released',
            'xo_lease_release_rejected',
            'board_recipient_resolved',
            'board_recipient_deferred',
            'canonical_motion_frozen',
            'canonical_approval_accepted',
            'canonical_approval_rejected',
            'motion_notification_enqueued',
            'motion_notification_deduplicated',
            'board_alias_resolved',
            'board_petition_delivered',
            'execution_claim_authority_rejected',
            'manual_initiation_recorded'
          )
        ),
        actor_principal_id TEXT,
        actor_seat_id TEXT CHECK (actor_seat_id IS NULL OR actor_seat_id IN ('john', 'general', 'xo')),
        xo_lease_id TEXT,
        xo_fencing_token INTEGER CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
        motion_id TEXT,
        motion_revision_sha TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_board_audit_events_no_update
        BEFORE UPDATE ON board_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'board_audit_events is append-only');
        END;

      CREATE TRIGGER IF NOT EXISTS trg_board_audit_events_no_delete
        BEFORE DELETE ON board_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'board_audit_events is append-only');
        END;

      -- Board execution claims (migration 032): exclusive fenced action ownership.
      CREATE TABLE IF NOT EXISTS board_execution_claims (
        claim_id TEXT PRIMARY KEY,
        motion_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK (
          action_kind IN ('production_deploy', 'overseer_repair_refire')
        ),
        environment TEXT NOT NULL CHECK (environment IN ('production', 'recovery')),
        target_sha TEXT NOT NULL CHECK (
          length(target_sha) IN (40, 64) AND target_sha NOT GLOB '*[^0-9a-f]*'
        ),
        action_key TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        motion_file_path TEXT NOT NULL,
        motion_revision_sha TEXT NOT NULL CHECK (
          length(motion_revision_sha) = 40 AND motion_revision_sha NOT GLOB '*[^0-9a-f]*'
        ),
        claimant_principal TEXT NOT NULL,
        claimant_xo_holder_id TEXT NOT NULL,
        claimant_xo_lease_id TEXT NOT NULL,
        claimant_xo_fencing_token INTEGER NOT NULL CHECK (claimant_xo_fencing_token > 0),
        execution_fencing_token INTEGER NOT NULL CHECK (execution_fencing_token > 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'released', 'completed')),
        reconciliation_status TEXT NOT NULL CHECK (
          reconciliation_status IN ('clear', 'required', 'resolved_retryable', 'resolved_completed')
        ),
        effect_attempt_id TEXT,
        effect_attempt_state TEXT NOT NULL CHECK (
          effect_attempt_state IN ('none', 'armed', 'completed', 'reconciled')
        ),
        effect_armed_at TEXT,
        acquired_at TEXT NOT NULL,
        renewed_at TEXT,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        completed_at TEXT,
        external_effect_reference TEXT,
        completion_evidence_json TEXT CHECK (
          completion_evidence_json IS NULL OR json_valid(completion_evidence_json)
        ),
        reconciliation_evidence_json TEXT CHECK (
          reconciliation_evidence_json IS NULL OR json_valid(reconciliation_evidence_json)
        ),
        CONSTRAINT board_execution_claims_action_identity_unique
          UNIQUE (motion_id, action_kind, environment, target_sha),
        CONSTRAINT board_execution_claims_status_reconciliation_pair CHECK (
          (status = 'active' AND reconciliation_status IN ('clear', 'required'))
          OR (status = 'released' AND reconciliation_status IN ('clear', 'resolved_retryable'))
          OR (status = 'completed' AND reconciliation_status IN ('clear', 'resolved_completed'))
        ),
        CONSTRAINT board_execution_claims_arm_iff_required CHECK (
          (reconciliation_status = 'required') = (effect_attempt_state = 'armed')
        ),
        CONSTRAINT board_execution_claims_armed_attempt_present CHECK (
          effect_attempt_state <> 'armed'
          OR (effect_attempt_id IS NOT NULL AND effect_armed_at IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_board_execution_claims_active
        ON board_execution_claims(status, reconciliation_status, expires_at);

      CREATE TABLE IF NOT EXISTS board_execution_claim_events (
        event_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL REFERENCES board_execution_claims(claim_id),
        event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'claim_acquired',
            'claim_conflict',
            'claim_renewed',
            'claim_taken_over',
            'claim_released',
            'claim_stale_rejected',
            'claim_effect_armed',
            'claim_reconciliation_required',
            'claim_reconciled_retryable',
            'claim_reconciled_completed',
            'claim_completed'
          )
        ),
        actor_principal TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('xo', 'john', 'system')),
        xo_lease_id TEXT,
        xo_fencing_token INTEGER CHECK (xo_fencing_token IS NULL OR xo_fencing_token > 0),
        execution_fencing_token INTEGER CHECK (
          execution_fencing_token IS NULL OR execution_fencing_token > 0
        ),
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CONSTRAINT board_execution_claim_events_sequence_unique UNIQUE (claim_id, event_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_board_execution_claim_events_claim
        ON board_execution_claim_events(claim_id, created_at);

      CREATE TRIGGER IF NOT EXISTS trg_board_execution_claim_events_no_update
        BEFORE UPDATE ON board_execution_claim_events
        BEGIN
          SELECT RAISE(ABORT, 'board_execution_claim_events is append-only');
        END;

      CREATE TRIGGER IF NOT EXISTS trg_board_execution_claim_events_no_delete
        BEFORE DELETE ON board_execution_claim_events
        BEGIN
          SELECT RAISE(ABORT, 'board_execution_claim_events is append-only');
        END;

      -- M-31 Overseer merge-steward substrate (migration 033): five append-only
      -- tables for immutable snapshots, sorted membership, discrepancies, exact
      -- expiring proposals, and single-use compare-and-consume receipts. Mirrors
      -- migrations/033_overseer_m31_substrate.sql (booleans as INTEGER 0/1).
      CREATE TABLE IF NOT EXISTS overseer_m31_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        repository TEXT NOT NULL,
        capture_started_at TEXT NOT NULL,
        capture_completed_at TEXT NOT NULL,
        operator_actor TEXT NOT NULL,
        operator_model TEXT NOT NULL,
        read_only_query_method TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL CHECK (
          (length(base_sha) = 40 OR length(base_sha) = 64) AND base_sha NOT GLOB '*[^0-9a-f]*'
        ),
        predecessor_snapshot_id TEXT REFERENCES overseer_m31_snapshots(snapshot_id),
        predecessor_evidence_git_blob TEXT CHECK (
          predecessor_evidence_git_blob IS NULL
          OR ((length(predecessor_evidence_git_blob) = 40 OR length(predecessor_evidence_git_blob) = 64)
              AND predecessor_evidence_git_blob NOT GLOB '*[^0-9a-f]*')
        ),
        artifact_path TEXT NOT NULL,
        git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
        evidence_git_blob TEXT NOT NULL UNIQUE CHECK (
          (length(evidence_git_blob) = 40 OR length(evidence_git_blob) = 64)
          AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'
        ),
        mutation_attempted INTEGER NOT NULL CHECK (mutation_attempted IN (0, 1)),
        mutation_succeeded INTEGER NOT NULL CHECK (mutation_succeeded = 0),
        fusion_calls_attempted INTEGER NOT NULL CHECK (fusion_calls_attempted >= 0),
        fusion_calls_succeeded INTEGER NOT NULL CHECK (fusion_calls_succeeded = 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CONSTRAINT overseer_m31_snapshots_predecessor_pair CHECK (
          (predecessor_snapshot_id IS NULL) = (predecessor_evidence_git_blob IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshots_repo
        ON overseer_m31_snapshots(repository, created_at);
      CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshots_predecessor
        ON overseer_m31_snapshots(predecessor_snapshot_id) WHERE predecessor_snapshot_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS overseer_m31_snapshot_members (
        snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        head_sha TEXT NOT NULL CHECK (
          (length(head_sha) = 40 OR length(head_sha) = 64) AND head_sha NOT GLOB '*[^0-9a-f]*'
        ),
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL CHECK (
          (length(base_sha) = 40 OR length(base_sha) = 64) AND base_sha NOT GLOB '*[^0-9a-f]*'
        ),
        state TEXT NOT NULL,
        checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
        check_source_sha TEXT NOT NULL CHECK (
          (length(check_source_sha) = 40 OR length(check_source_sha) = 64)
          AND check_source_sha NOT GLOB '*[^0-9a-f]*'
        ),
        checks_observed_at TEXT NOT NULL,
        review_state TEXT NOT NULL,
        mergeability TEXT NOT NULL,
        merge_state_status TEXT NOT NULL,
        linked_work_evidence_json TEXT NOT NULL CHECK (json_valid(linked_work_evidence_json)),
        evidence_artifact_path TEXT NOT NULL,
        git_object_format TEXT NOT NULL CHECK (git_object_format IN ('sha1', 'sha256')),
        evidence_git_blob TEXT NOT NULL CHECK (
          (length(evidence_git_blob) = 40 OR length(evidence_git_blob) = 64)
          AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'
        ),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, ordinal),
        CONSTRAINT overseer_m31_snapshot_members_pr_unique UNIQUE (snapshot_id, pr_number)
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_m31_snapshot_members_snapshot
        ON overseer_m31_snapshot_members(snapshot_id, ordinal);

      CREATE TABLE IF NOT EXISTS overseer_m31_discrepancies (
        discrepancy_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
        evidence_git_blob TEXT NOT NULL CHECK (
          (length(evidence_git_blob) = 40 OR length(evidence_git_blob) = 64)
          AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'
        ),
        affected_rows_json TEXT NOT NULL CHECK (json_valid(affected_rows_json)),
        observed_conflict TEXT NOT NULL,
        recorder TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        resolution TEXT,
        predecessor_discrepancy_id TEXT REFERENCES overseer_m31_discrepancies(discrepancy_id)
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_m31_discrepancies_snapshot
        ON overseer_m31_discrepancies(snapshot_id, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_overseer_m31_discrepancies_unresolved
        ON overseer_m31_discrepancies(snapshot_id) WHERE resolution IS NULL;

      CREATE TABLE IF NOT EXISTS overseer_m31_action_proposals (
        proposal_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        head_sha TEXT NOT NULL CHECK (
          (length(head_sha) = 40 OR length(head_sha) = 64) AND head_sha NOT GLOB '*[^0-9a-f]*'
        ),
        base_branch TEXT NOT NULL,
        base_sha TEXT NOT NULL CHECK (
          (length(base_sha) = 40 OR length(base_sha) = 64) AND base_sha NOT GLOB '*[^0-9a-f]*'
        ),
        snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
        evidence_path TEXT NOT NULL,
        evidence_git_blob TEXT NOT NULL CHECK (
          (length(evidence_git_blob) = 40 OR length(evidence_git_blob) = 64)
          AND evidence_git_blob NOT GLOB '*[^0-9a-f]*'
        ),
        action_kind TEXT NOT NULL CHECK (action_kind IN (
          'MERGE', 'CLOSE', 'REOPEN', 'REFRESH', 'REBASE', 'PUSH', 'RETARGET',
          'REPAIR', 'REFIRE', 'COMMENT', 'LABEL', 'ASSIGN', 'REVIEW',
          'STAGING_MUTATION', 'PRODUCTION_MUTATION', 'DEPLOY'
        )),
        action_parameters_json TEXT NOT NULL CHECK (json_valid(action_parameters_json)),
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        execution_id TEXT NOT NULL UNIQUE,
        capability TEXT NOT NULL,
        policy_digest TEXT NOT NULL CHECK (
          length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
        ),
        verifier_registry_digest TEXT NOT NULL CHECK (
          length(verifier_registry_digest) = 64 AND verifier_registry_digest NOT GLOB '*[^0-9a-f]*'
        ),
        CONSTRAINT overseer_m31_action_proposals_expiry_after_creation CHECK (expires_at > created_at)
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_m31_action_proposals_repo
        ON overseer_m31_action_proposals(repository, pr_number);
      CREATE INDEX IF NOT EXISTS idx_overseer_m31_action_proposals_snapshot
        ON overseer_m31_action_proposals(snapshot_id);

      CREATE TABLE IF NOT EXISTS overseer_m31_execution_receipts (
        receipt_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL UNIQUE REFERENCES overseer_m31_action_proposals(proposal_id),
        execution_id TEXT NOT NULL UNIQUE,
        snapshot_id TEXT NOT NULL REFERENCES overseer_m31_snapshots(snapshot_id),
        live_observation_json TEXT NOT NULL CHECK (json_valid(live_observation_json)),
        live_observation_digest TEXT NOT NULL CHECK (
          length(live_observation_digest) = 64 AND live_observation_digest NOT GLOB '*[^0-9a-f]*'
        ),
        revalidated_at TEXT NOT NULL,
        valid_until TEXT NOT NULL,
        compare_result TEXT NOT NULL CHECK (compare_result = 'permit_issued'),
        provider_atomic_operation TEXT CHECK (provider_atomic_operation IS NULL),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        CONSTRAINT overseer_m31_execution_receipts_validity_window CHECK (valid_until > revalidated_at)
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_m31_execution_receipts_proposal
        ON overseer_m31_execution_receipts(proposal_id);

      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_snapshots_no_update
        BEFORE UPDATE ON overseer_m31_snapshots
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_snapshots is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_snapshots_no_delete
        BEFORE DELETE ON overseer_m31_snapshots
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_snapshots is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_snapshot_members_no_update
        BEFORE UPDATE ON overseer_m31_snapshot_members
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_snapshot_members is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_snapshot_members_no_delete
        BEFORE DELETE ON overseer_m31_snapshot_members
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_snapshot_members is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_discrepancies_no_update
        BEFORE UPDATE ON overseer_m31_discrepancies
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_discrepancies is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_discrepancies_no_delete
        BEFORE DELETE ON overseer_m31_discrepancies
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_discrepancies is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_action_proposals_no_update
        BEFORE UPDATE ON overseer_m31_action_proposals
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_action_proposals is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_action_proposals_no_delete
        BEFORE DELETE ON overseer_m31_action_proposals
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_action_proposals is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_execution_receipts_no_update
        BEFORE UPDATE ON overseer_m31_execution_receipts
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_execution_receipts is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_m31_execution_receipts_no_delete
        BEFORE DELETE ON overseer_m31_execution_receipts
        BEGIN SELECT RAISE(ABORT, 'overseer_m31_execution_receipts is append-only'); END;

      -- M-42 Slice 1 capability state (migration 034). Capabilities start
      -- disabled and closed; capability events are append-only.
      CREATE TABLE IF NOT EXISTS overseer_capability_state (
        capability TEXT PRIMARY KEY CHECK (capability IN (
          'escalation', 'repair', 'branch', 'lifecycle', 'merge'
        )),
        action_enabled INTEGER NOT NULL DEFAULT 0 CHECK (action_enabled IN (0, 1)),
        circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open')),
        circuit_reason TEXT,
        circuit_opened_at TEXT,
        policy_digest TEXT NOT NULL CHECK (
          length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
        ),
        verifier_registry_digest TEXT NOT NULL CHECK (
          length(verifier_registry_digest) = 64
          AND verifier_registry_digest NOT GLOB '*[^0-9a-f]*'
        ),
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS overseer_capability_events (
        event_id TEXT PRIMARY KEY,
        capability TEXT NOT NULL CHECK (capability IN (
          'escalation', 'repair', 'branch', 'lifecycle', 'merge'
        )),
        event_type TEXT NOT NULL CHECK (event_type IN (
          'gate_allowed', 'gate_denied', 'circuit_opened', 'circuit_reset', 'adapter_attempt'
        )),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        proposal_id TEXT REFERENCES overseer_m31_action_proposals(proposal_id),
        execution_id TEXT REFERENCES overseer_m31_action_proposals(execution_id),
        policy_digest TEXT NOT NULL CHECK (
          length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
        ),
        verifier_registry_digest TEXT NOT NULL CHECK (
          length(verifier_registry_digest) = 64
          AND verifier_registry_digest NOT GLOB '*[^0-9a-f]*'
        ),
        details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_capability_events_capability
        ON overseer_capability_events(capability, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_overseer_capability_events_adapter_execution
        ON overseer_capability_events(execution_id)
        WHERE event_type = 'adapter_attempt' AND execution_id IS NOT NULL;

      INSERT OR IGNORE INTO overseer_capability_state (
        capability, action_enabled, circuit_state, circuit_reason, circuit_opened_at,
        policy_digest, verifier_registry_digest, updated_at, updated_by
      ) VALUES
        ('escalation', 0, 'closed', NULL, NULL,
         '0000000000000000000000000000000000000000000000000000000000000000',
         '0000000000000000000000000000000000000000000000000000000000000000',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration-034'),
        ('repair', 0, 'closed', NULL, NULL,
         '0000000000000000000000000000000000000000000000000000000000000000',
         '0000000000000000000000000000000000000000000000000000000000000000',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration-034'),
        ('branch', 0, 'closed', NULL, NULL,
         '0000000000000000000000000000000000000000000000000000000000000000',
         '0000000000000000000000000000000000000000000000000000000000000000',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration-034'),
        ('lifecycle', 0, 'closed', NULL, NULL,
         '0000000000000000000000000000000000000000000000000000000000000000',
         '0000000000000000000000000000000000000000000000000000000000000000',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration-034'),
        ('merge', 0, 'closed', NULL, NULL,
         '0000000000000000000000000000000000000000000000000000000000000000',
         '0000000000000000000000000000000000000000000000000000000000000000',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration-034');

      CREATE TRIGGER IF NOT EXISTS trg_overseer_capability_events_no_update
        BEFORE UPDATE ON overseer_capability_events
        BEGIN SELECT RAISE(ABORT, 'overseer_capability_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_capability_events_no_delete
        BEFORE DELETE ON overseer_capability_events
        BEGIN SELECT RAISE(ABORT, 'overseer_capability_events is append-only'); END;

      -- M-42 Slice 3 durable operator cards and delivery evidence (migration 035).
      CREATE TABLE IF NOT EXISTS overseer_operator_cards (
        card_id TEXT PRIMARY KEY CHECK (
          length(card_id) = 64 AND card_id NOT GLOB '*[^0-9a-f]*'
        ),
        identity_version TEXT NOT NULL CHECK (
          identity_version = 'overseer-actionable-event-v1'
        ),
        canonical_event_identity TEXT NOT NULL CHECK (json_valid(canonical_event_identity)),
        payload_digest TEXT NOT NULL CHECK (
          length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
        ),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        run_id TEXT NOT NULL,
        wo_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        branch TEXT,
        pr_url TEXT,
        pr_number INTEGER CHECK (pr_number > 0),
        head_sha TEXT,
        base_branch TEXT,
        base_sha TEXT,
        checks TEXT NOT NULL CHECK (json_valid(checks)),
        mergeability TEXT NOT NULL,
        blocker TEXT NOT NULL,
        mechanical_evidence TEXT NOT NULL CHECK (json_valid(mechanical_evidence)),
        recovery_attempted TEXT NOT NULL CHECK (json_valid(recovery_attempted)),
        proposed_remediation TEXT NOT NULL CHECK (json_valid(proposed_remediation)),
        next_permitted_action TEXT NOT NULL,
        responsible_actor TEXT NOT NULL,
        actionable_event_at TEXT NOT NULL,
        required_ruling TEXT,
        evidence_links TEXT NOT NULL CHECK (json_valid(evidence_links)),
        lifecycle_classification TEXT NOT NULL,
        governance_classification TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS overseer_operator_card_delivery_jobs (
        card_id TEXT NOT NULL REFERENCES overseer_operator_cards(card_id),
        channel TEXT NOT NULL CHECK (channel IN ('dispatch', 'builder_monitor', 'notion')),
        state TEXT NOT NULL CHECK (state IN (
          'pending', 'leased', 'succeeded', 'exhausted', 'indeterminate'
        )),
        attempts_started INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started BETWEEN 0 AND 3),
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (card_id, channel)
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_operator_card_jobs_due
        ON overseer_operator_card_delivery_jobs(state, next_attempt_at, channel);

      CREATE TABLE IF NOT EXISTS overseer_operator_card_delivery_receipts (
        receipt_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES overseer_operator_cards(card_id),
        channel TEXT NOT NULL CHECK (channel IN ('dispatch', 'builder_monitor', 'notion')),
        attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
        phase TEXT NOT NULL CHECK (phase IN ('started', 'terminal')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        outcome TEXT CHECK (outcome IN (
          'succeeded', 'transient_failure', 'permanent_failure', 'indeterminate'
        )),
        sanitized_status TEXT,
        error_class TEXT,
        next_attempt_at TEXT,
        provider_receipt_id TEXT,
        fencing_token INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (card_id, channel, attempt_number, phase),
        CHECK (
          (phase = 'started' AND completed_at IS NULL AND outcome IS NULL)
          OR (phase = 'terminal' AND completed_at IS NOT NULL AND outcome IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_overseer_operator_card_receipts_card
        ON overseer_operator_card_delivery_receipts(card_id, channel, attempt_number, phase);

      CREATE TRIGGER IF NOT EXISTS trg_overseer_operator_cards_no_update
        BEFORE UPDATE ON overseer_operator_cards
        BEGIN SELECT RAISE(ABORT, 'overseer_operator_cards is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_operator_cards_no_delete
        BEFORE DELETE ON overseer_operator_cards
        BEGIN SELECT RAISE(ABORT, 'overseer_operator_cards is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_operator_card_delivery_receipts_no_update
        BEFORE UPDATE ON overseer_operator_card_delivery_receipts
        BEGIN SELECT RAISE(ABORT, 'overseer_operator_card_delivery_receipts is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS trg_overseer_operator_card_delivery_receipts_no_delete
        BEFORE DELETE ON overseer_operator_card_delivery_receipts
        BEGIN SELECT RAISE(ABORT, 'overseer_operator_card_delivery_receipts is append-only'); END;

      CREATE TABLE IF NOT EXISTS overseer_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        wo_id TEXT NOT NULL,
        class TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- overseer_reconcile_actions: reconcile duty (V1B) actions are not scoped to any
      -- remote_agent_workflow_runs row (they fire off a merged PR, not a run), so they
      -- cannot honor overseer_actions.run_id's NOT NULL FK. Separate append-only log,
      -- keyed on the PR itself. WO-HARNESS-OVERSEER-RECONCILE-FK-FIX-01.
      CREATE TABLE IF NOT EXISTS overseer_reconcile_actions (
        id TEXT PRIMARY KEY,
        pr_ref TEXT NOT NULL,
        wo_id TEXT NOT NULL,
        class TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- overseer_verdicts: judge-first verdict store (Motion M-99, migration 039).
      -- One PRIMARY verdict per (run_id, head_sha); claim row inserted BEFORE the
      -- model call so the watch loop never double-bills. status is row lifecycle
      -- (claimed|verdict|judge_unavailable|judge_invalid_output|evidence_unavailable);
      -- health states are retryable ALARMS, never semantic verdicts.
      CREATE TABLE IF NOT EXISTS overseer_verdicts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
        wo_id TEXT NOT NULL,
        head_sha TEXT NOT NULL DEFAULT '',
        evidence_digest TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'claimed',
        verdict TEXT,
        confidence REAL,
        model TEXT,
        model_rung INTEGER,
        proposed_action TEXT,
        proposed_tier INTEGER,
        required_tier INTEGER,
        effective_tier INTEGER,
        hint_action TEXT,
        hint_error_class TEXT,
        reason TEXT,
        evidence TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- Indexes
      CREATE UNIQUE INDEX IF NOT EXISTS uq_overseer_verdicts_run_head ON overseer_verdicts(run_id, head_sha);
      CREATE INDEX IF NOT EXISTS idx_overseer_verdicts_status ON overseer_verdicts(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_codebase_env_vars_codebase_id ON remote_agent_codebase_env_vars(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_platform ON remote_agent_conversations(platform_type, platform_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON remote_agent_sessions(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active ON remote_agent_sessions(active);
      CREATE INDEX IF NOT EXISTS idx_isolation_codebase ON remote_agent_isolation_environments(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_workflow ON remote_agent_isolation_environments(workflow_type, workflow_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation ON remote_agent_workflow_runs(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON remote_agent_workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_run_id ON remote_agent_workflow_events(workflow_run_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_events_type ON remote_agent_workflow_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_reliability_active_leases
        ON remote_agent_run_leases(expires_at) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_reliability_attempts_run_node
        ON remote_agent_provider_attempts(run_id, node_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_reliability_due_waits
        ON remote_agent_scheduled_waits(resume_at) WHERE state = 'scheduled';
      CREATE UNIQUE INDEX IF NOT EXISTS unique_reliability_wait_attempt
        ON remote_agent_scheduled_waits(attempt_id);
      CREATE INDEX IF NOT EXISTS idx_supervisor_observations_incident
        ON remote_agent_supervisor_observations(incident_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_supervisor_actions_incident
        ON remote_agent_supervisor_actions(incident_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_supervisor_action_incident
        ON remote_agent_supervisor_actions(incident_id);
      CREATE INDEX IF NOT EXISTS idx_supervisor_repair_leases_expiry
        ON remote_agent_supervisor_repair_leases(expires_at) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_cauldron_control_events_created
        ON remote_agent_cauldron_control_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON remote_agent_messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_recipient_status ON agent_dispatch_messages(recipient, status);
      CREATE INDEX IF NOT EXISTS idx_agent_dispatch_messages_lease_expiry ON agent_dispatch_messages(lease_expires_at) WHERE status = 'claimed';
      CREATE INDEX IF NOT EXISTS idx_agent_dispatch_workers_status_heartbeat ON agent_dispatch_workers(status, last_heartbeat_at);
      CREATE INDEX IF NOT EXISTS idx_known_bad_bindings_provider_model ON known_bad_bindings(provider_id, model_id);
      CREATE INDEX IF NOT EXISTS idx_known_bad_bindings_active ON known_bad_bindings(binding_key) WHERE cleared_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_board_xo_leases_active
        ON board_xo_leases(expires_at) WHERE released_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_board_audit_events_created
        ON board_audit_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_board_audit_events_motion
        ON board_audit_events(motion_id, motion_revision_sha) WHERE motion_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_overseer_actions_run_id ON overseer_actions(run_id);
      CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_pr_ref ON overseer_reconcile_actions(pr_ref);
      CREATE INDEX IF NOT EXISTS idx_overseer_reconcile_actions_action ON overseer_reconcile_actions(action);
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_parent_conv ON remote_agent_workflow_runs(parent_conversation_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_hidden ON remote_agent_conversations(hidden);
      DROP INDEX IF EXISTS idx_conversations_codebase;
      CREATE INDEX IF NOT EXISTS idx_conversations_codebase ON remote_agent_conversations(codebase_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_conversations_isolation_env_id ON remote_agent_conversations(isolation_env_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_codebase ON remote_agent_sessions(codebase_id);
      CREATE INDEX IF NOT EXISTS idx_isolation_env_status ON remote_agent_isolation_environments(status);

      -- From PG migration 009: staleness detection for running workflows
      CREATE INDEX IF NOT EXISTS idx_workflow_runs_last_activity
        ON remote_agent_workflow_runs(last_activity_at) WHERE status = 'running';

      -- From PG migration 010: session audit trail
      CREATE INDEX IF NOT EXISTS idx_sessions_parent
        ON remote_agent_sessions(parent_session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_conversation_started
        ON remote_agent_sessions(conversation_id, started_at DESC);

      -- Taskmaster Slice 1 (migration 041, WO-HARNESS-TASKMASTER-SLICE1-01).
      -- Additive only; agent_dispatch_messages is migration 040's surface.
      CREATE TABLE IF NOT EXISTS tm_journal (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        thread_ref TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK (
          action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')
        ),
        proposal_json TEXT NOT NULL,
        idempotency_key TEXT,
        before_hash TEXT,
        proof_predicate TEXT,
        proof_deadline_at TEXT,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')
        ),
        graded_at TEXT,
        grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful'))
      );

      CREATE TABLE IF NOT EXISTS tm_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pause_state TEXT NOT NULL DEFAULT 'RUNNING' CHECK (
          pause_state IN ('RUNNING', 'PAUSED', 'HARD_PAUSE')
        ),
        pause_scope TEXT,
        pause_reason TEXT,
        pause_actor TEXT,
        epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS tm_health (
        provider TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        evidence TEXT
      );

      CREATE TABLE IF NOT EXISTS tm_usage_sample (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        window_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        value_json TEXT,
        confidence TEXT,
        is_unknown INTEGER NOT NULL DEFAULT 0 CHECK (is_unknown IN (0, 1))
      );

      INSERT OR IGNORE INTO tm_control (id, pause_state, epoch) VALUES (1, 'RUNNING', 0);

      -- Taskmaster adoption projection (migration 043,
      -- WO-HARNESS-TASKMASTER-ADOPTION-PROJECTION-01). Disposable snapshot
      -- rebuilt from GitHub; additive only.
      CREATE TABLE IF NOT EXISTS tm_adoption (
        thread_ref TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        title TEXT,
        priority TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        owner_login TEXT,
        is_blocked INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        next_action TEXT,
        latest_marker_kind TEXT CHECK (
          latest_marker_kind IS NULL OR latest_marker_kind IN ('PROGRESS', 'BLOCKED')
        ),
        latest_marker_at TEXT,
        state TEXT,
        last_movement_at TEXT,
        last_movement_kind TEXT CHECK (
          last_movement_kind IS NULL
          OR last_movement_kind IN ('closed', 'assigned', 'status_label', 'progress_comment')
        ),
        attempts_24h INTEGER NOT NULL DEFAULT 0,
        attempts_total INTEGER NOT NULL DEFAULT 0,
        evidence_observed_at TEXT,
        source_updated_at TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, thread_ref)
      );

      CREATE TABLE IF NOT EXISTS tm_adoption_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        committed_snapshot_id TEXT,
        rebuilt_at TEXT,
        row_count INTEGER,
        source_commit TEXT,
        complete INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO tm_adoption_meta (id) VALUES (1);

      -- Taskmaster noise suppression (migration 044,
      -- WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01). Durable standalone table --
      -- deliberately NOT a column on the disposable tm_adoption projection,
      -- which commitAdoptionSnapshot wipes on every refresh.
      CREATE TABLE IF NOT EXISTS tm_suppression (
        thread_ref TEXT PRIMARY KEY,
        suppressed_until_hash TEXT NOT NULL,
        suppressed_at TEXT NOT NULL,
        noise_grade_count INTEGER NOT NULL DEFAULT 2
      );
    `);
    getLog().info('db.sqlite_schema_initialized');
  }
}

/**
 * SQLite SQL dialect helpers
 */
export const sqliteDialect: SqlDialect = {
  generateUuid(): string {
    return crypto.randomUUID();
  },

  now(): string {
    return "datetime('now')";
  },

  jsonMerge(column: string, paramIndex: number): string {
    // SQLite json_patch: merges two JSON objects
    // Use $N placeholder (not raw ?) so convertPlaceholders can reorder params correctly
    return `json_patch(${column}, $${String(paramIndex)})`;
  },

  jsonArrayContains(column: string, path: string, paramIndex: number): string {
    // SQLite: check if JSON array contains value using instr
    // Use $N placeholder for consistent param ordering
    return `instr(json_extract(${column}, '$.${path}'), $${String(paramIndex)}) > 0`;
  },

  nowMinusDays(paramIndex: number): string {
    return `datetime('now', '-' || $${String(paramIndex)} || ' days')`;
  },

  daysSince(column: string): string {
    return `(julianday('now') - julianday(${column}))`;
  },
};
