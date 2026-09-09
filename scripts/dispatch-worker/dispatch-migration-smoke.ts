import { Database, constants } from 'bun:sqlite';
import { createHash, randomUUID } from 'crypto';
import { constants as fileSystemConstants } from 'fs';
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

const BUILT_IN_LIVE_PATHS = ['/.archon/archon.db', '/opt/bdc/archon-data/archon.db'] as const;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;
const PHASE_0_NULLABLE_COLUMNS = [
  'task_outcome',
  'acknowledged_at',
  'acknowledged_by',
  'addressed_at',
  'addressed_by',
  'escalated_tg_at',
  'escalated_sms_at',
  'subject_key',
  'route_disposition',
  'supersedes_id',
] as const;
const REQUIRED_DISPATCH_INDEXES = [
  'idx_agent_dispatch_messages_lease_expiry',
  'idx_agent_dispatch_messages_recipient_status',
  'idx_dispatch_board_pending',
] as const;
const KNOWN_PRINCIPALS = [
  ['board', 'Board', 'alias_resolved', 1],
  ['cauldron', 'Cauldron', 'notify_only', 1],
  ['claude', 'Claude', 'worker_poll', 1],
  ['claude-acp', 'Claude ACP', 'worker_poll', 1],
  ['codex', 'Codex', 'worker_poll', 1],
  ['codex-mcp', 'Codex MCP', 'worker_poll', 1],
  ['cursor', 'Cursor', 'worker_poll', 1],
  ['fusion', 'Fusion', 'worker_poll', 1],
  ['grok', 'Grok', 'worker_poll', 1],
  ['grok-acp', 'Grok ACP', 'worker_poll', 1],
  ['john', 'John', 'notify_only', 0],
  ['merge-manager', 'Merge Manager', 'notify_only', 0],
  ['operator', 'Operator', 'drain_on_start', 1],
  ['overseer', 'Overseer', 'notify_only', 1],
  ['overseer-review-route', 'Overseer Review Route', 'notify_only', 1],
  ['overseer-reviewer', 'Overseer PR Reviewer', 'worker_poll', 1],
  ['xo', 'XO', 'drain_on_start', 1],
] as const;

interface SmokeArguments {
  sourceCopy: string;
  expectedHeartbeats: number;
  migratedCopyOutput: string | null;
}

interface CountRow {
  count: number;
}

interface WalCheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | number | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface IndexSnapshot extends IndexListRow {
  columns: IndexInfoRow[];
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableSnapshot {
  columns: TableInfoRow[];
  foreignKeys: ForeignKeyRow[];
  indexes: IndexSnapshot[];
  master: MasterRow[];
}

interface PrincipalRow {
  principal_id: string;
  display_name: string;
  delivery_mode: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface BeforeSnapshot {
  rows: number;
  messageColumns: string[];
  messageStateDigest: string;
  liveRecipients: string[];
}

interface MigrationSnapshot {
  messageTable: TableSnapshot;
  principalTable: TableSnapshot;
  principals: PrincipalRow[];
  rows: number;
  heartbeatRows: number;
  otherHeartbeatRows: number;
  otherNonNormalRows: number;
  missingLivePrincipalRows: number;
  preExistingMessageStateDigest: string;
  completeMessageStateDigest: string;
}

class SmokeFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseArguments(args: string[]): SmokeArguments {
  let sourceCopy: string | null = null;
  let expectedHeartbeatsText: string | null = null;
  let migratedCopyOutput: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--source-copy' && value) {
      sourceCopy = value;
      index += 1;
      continue;
    }
    if (argument === '--expected-heartbeats' && value) {
      expectedHeartbeatsText = value;
      index += 1;
      continue;
    }
    if (argument === '--migrated-copy-output') {
      if (!value || value.startsWith('--')) {
        throw new SmokeFailure('--migrated-copy-output requires a path');
      }
      migratedCopyOutput = value;
      index += 1;
      continue;
    }
    throw new SmokeFailure('unsupported_argument');
  }

  if (!sourceCopy) throw new SmokeFailure('--source-copy is required');
  if (isImmediateLivePath(sourceCopy, BUILT_IN_LIVE_PATHS)) {
    throw new SmokeFailure('source_copy_forbidden');
  }
  if (expectedHeartbeatsText === null) {
    throw new SmokeFailure('--expected-heartbeats is required');
  }
  const expectedHeartbeats = Number(expectedHeartbeatsText);
  if (!Number.isSafeInteger(expectedHeartbeats) || expectedHeartbeats < 0) {
    throw new SmokeFailure('--expected-heartbeats must be a non-negative integer');
  }
  return { sourceCopy, expectedHeartbeats, migratedCopyOutput };
}

function normalizeLiteralPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function comparisonPath(path: string): string {
  const normalized = normalizeLiteralPath(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isImmediateLivePath(source: string, knownPaths: readonly string[]): boolean {
  const literal = normalizeLiteralPath(source);
  return knownPaths.some(path => literal === normalizeLiteralPath(path));
}

function configuredKnownLivePaths(): string[] {
  const paths: string[] = [...BUILT_IN_LIVE_PATHS];
  if (process.env.NODE_ENV !== 'test') return paths;
  const encoded = process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_KNOWN_LIVE_PATHS;
  if (!encoded) return paths;
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
      paths.push(...parsed);
    }
  } catch {
    throw new SmokeFailure('invalid_test_configuration');
  }
  return paths;
}

async function canonicalSafeSourcePath(source: string): Promise<string> {
  const knownPaths = configuredKnownLivePaths();
  if (isImmediateLivePath(source, knownPaths)) throw new SmokeFailure('source_copy_forbidden');

  const resolvedSource = comparisonPath(source);
  const resolvedKnownPaths = knownPaths.map(comparisonPath);
  if (resolvedKnownPaths.includes(resolvedSource)) {
    throw new SmokeFailure('source_copy_forbidden');
  }

  let canonicalSource: string;
  try {
    canonicalSource = await realpath(source);
  } catch {
    throw new SmokeFailure('source_copy_unavailable');
  }
  const canonicalComparison = comparisonPath(canonicalSource);
  if (resolvedKnownPaths.includes(canonicalComparison)) {
    throw new SmokeFailure('source_copy_forbidden');
  }

  const canonicalKnownPaths: string[] = [];
  for (const knownPath of knownPaths) {
    try {
      canonicalKnownPaths.push(await realpath(knownPath));
    } catch {
      // A missing known path has no file identity to compare on this host.
    }
  }
  if (canonicalKnownPaths.map(comparisonPath).includes(canonicalComparison)) {
    throw new SmokeFailure('source_copy_forbidden');
  }

  let sourceInfo: Awaited<ReturnType<typeof stat>>;
  try {
    sourceInfo = await stat(canonicalSource);
  } catch {
    throw new SmokeFailure('source_copy_unavailable');
  }
  if (!sourceInfo.isFile()) throw new SmokeFailure('source_copy_unavailable');

  for (const knownPath of canonicalKnownPaths) {
    try {
      const knownInfo = await stat(knownPath);
      if (knownInfo.dev === sourceInfo.dev && knownInfo.ino === sourceInfo.ino) {
        throw new SmokeFailure('source_copy_forbidden');
      }
    } catch (error: unknown) {
      if (error instanceof SmokeFailure) throw error;
    }
  }
  return canonicalSource;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function sqliteDatabaseNamespace(path: string): string[] {
  return [path, ...SQLITE_SIDECAR_SUFFIXES.map(suffix => `${path}${suffix}`)];
}

async function canonicalPathThroughExistingParent(path: string): Promise<string> {
  let existingPath = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(existingPath), ...missingSegments);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw new SmokeFailure('migrated_copy_output_unavailable');
      }
    }

    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw new SmokeFailure('migrated_copy_output_unavailable');
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
}

async function canonicalOutputCandidate(outputPath: string): Promise<string> {
  const resolvedOutput = resolve(outputPath);
  try {
    return join(await realpath(dirname(resolvedOutput)), basename(resolvedOutput));
  } catch {
    throw new SmokeFailure('migrated_copy_output_unavailable');
  }
}

async function assertSourceCopyHasNoSidecars(
  suppliedSource: string,
  canonicalSource: string
): Promise<void> {
  const sourcePaths = [resolve(suppliedSource), canonicalSource].filter(
    (path, index, paths) =>
      paths.findIndex(candidate => comparisonPath(candidate) === comparisonPath(path)) === index
  );
  for (const sourcePath of sourcePaths) {
    for (const sidecarPath of sqliteDatabaseNamespace(sourcePath).slice(1)) {
      try {
        await lstat(sidecarPath);
      } catch (error: unknown) {
        if (isNotFoundError(error)) continue;
        throw new SmokeFailure('source_copy_sidecar_present');
      }
      throw new SmokeFailure('source_copy_sidecar_present');
    }
  }
}

async function sameFileIdentity(left: string, right: string): Promise<boolean> {
  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch {
    return false;
  }
}

async function validateMigratedCopyOutputPath(
  outputPath: string,
  suppliedSource: string,
  canonicalSource: string
): Promise<string> {
  const knownPaths = configuredKnownLivePaths();
  if (isImmediateLivePath(outputPath, knownPaths)) {
    throw new SmokeFailure('migrated_copy_output_forbidden');
  }

  const canonicalCandidate = await canonicalOutputCandidate(outputPath);
  const outputCandidates = [comparisonPath(outputPath), comparisonPath(canonicalCandidate)];
  const sourceNamespace = [resolve(suppliedSource), canonicalSource]
    .flatMap(sqliteDatabaseNamespace)
    .map(comparisonPath);
  if (outputCandidates.some(candidate => sourceNamespace.includes(candidate))) {
    throw new SmokeFailure('migrated_copy_output_source_alias');
  }

  for (const knownPath of knownPaths) {
    const canonicalKnownPath = await canonicalPathThroughExistingParent(knownPath);
    const knownNamespace = [knownPath, canonicalKnownPath]
      .flatMap(sqliteDatabaseNamespace)
      .map(comparisonPath);
    if (outputCandidates.some(candidate => knownNamespace.includes(candidate))) {
      throw new SmokeFailure('migrated_copy_output_forbidden');
    }
  }

  try {
    await lstat(canonicalCandidate);
  } catch (error: unknown) {
    if (isNotFoundError(error)) return canonicalCandidate;
    throw new SmokeFailure('migrated_copy_output_unavailable');
  }

  let canonicalOutput: string;
  try {
    canonicalOutput = await realpath(canonicalCandidate);
  } catch (error: unknown) {
    if (isNotFoundError(error)) throw new SmokeFailure('migrated_copy_output_exists');
    throw new SmokeFailure('migrated_copy_output_unavailable');
  }

  if (comparisonPath(canonicalOutput) === comparisonPath(canonicalSource)) {
    throw new SmokeFailure('migrated_copy_output_source_alias');
  }
  if (await sameFileIdentity(canonicalOutput, canonicalSource)) {
    throw new SmokeFailure('migrated_copy_output_source_alias');
  }

  for (const knownPath of knownPaths.flatMap(sqliteDatabaseNamespace)) {
    try {
      const canonicalKnownPath = await realpath(knownPath);
      if (
        comparisonPath(canonicalOutput) === comparisonPath(canonicalKnownPath) ||
        (await sameFileIdentity(canonicalOutput, canonicalKnownPath))
      ) {
        throw new SmokeFailure('migrated_copy_output_forbidden');
      }
    } catch (error: unknown) {
      if (error instanceof SmokeFailure) throw error;
    }
  }
  throw new SmokeFailure('migrated_copy_output_exists');
}

async function sha256File(path: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    throw new SmokeFailure('source_copy_unavailable');
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { blob_hex: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, canonicalValue(record[key])])
    );
  }
  return value;
}

function canonicalDigest(value: unknown): string {
  return sha256Text(JSON.stringify(canonicalValue(value)));
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quotePragmaValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function count(database: Database, sql: string): number {
  const row = database.query<CountRow, []>(sql).get();
  if (!row) throw new SmokeFailure('migration_snapshot_failed');
  return row.count;
}

function tableInfo(database: Database, table: string): TableInfoRow[] {
  return database
    .query<TableInfoRow, []>(`PRAGMA table_info(${quotePragmaValue(table)})`)
    .all()
    .sort((left, right) => left.cid - right.cid);
}

function captureTable(database: Database, table: string): TableSnapshot {
  const indexRows = database
    .query<IndexListRow, []>(`PRAGMA index_list(${quotePragmaValue(table)})`)
    .all()
    .sort((left, right) => left.name.localeCompare(right.name));
  const indexes = indexRows.map(index => ({
    ...index,
    columns: database
      .query<IndexInfoRow, []>(`PRAGMA index_info(${quotePragmaValue(index.name)})`)
      .all()
      .sort((left, right) => left.seqno - right.seqno),
  }));
  return {
    columns: tableInfo(database, table),
    foreignKeys: database
      .query<ForeignKeyRow, []>(`PRAGMA foreign_key_list(${quotePragmaValue(table)})`)
      .all()
      .sort((left, right) => left.id - right.id || left.seq - right.seq),
    indexes,
    master: database
      .query<MasterRow, [string]>(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name = $1 OR tbl_name = $1
         ORDER BY type, name`
      )
      .all(table),
  };
}

function messageStateDigest(database: Database, columns?: readonly string[]): string {
  const projection = columns ? columns.map(quoteIdentifier).join(', ') : '*';
  const rows = database
    .query<
      Record<string, unknown>,
      []
    >(`SELECT ${projection} FROM agent_dispatch_messages ORDER BY id`)
    .all();
  return canonicalDigest(rows);
}

function inspectBeforeMigration(path: string): BeforeSnapshot {
  const database = new Database(path, constants.SQLITE_OPEN_READONLY);
  try {
    const messageColumns = tableInfo(database, 'agent_dispatch_messages').map(row => row.name);
    return {
      rows: count(database, 'SELECT COUNT(*) AS count FROM agent_dispatch_messages'),
      messageColumns,
      messageStateDigest: messageStateDigest(database, messageColumns),
      liveRecipients: database
        .query<{ principal_id: string }, []>(
          `SELECT DISTINCT LOWER(TRIM(recipient)) AS principal_id
           FROM agent_dispatch_messages
           WHERE TRIM(recipient) <> ''
           ORDER BY principal_id`
        )
        .all()
        .map(row => row.principal_id),
    };
  } finally {
    database.close();
  }
}

function inspectAfterMigration(path: string, before: BeforeSnapshot): MigrationSnapshot {
  const database = new Database(path, constants.SQLITE_OPEN_READONLY);
  try {
    return {
      messageTable: captureTable(database, 'agent_dispatch_messages'),
      principalTable: captureTable(database, 'dispatch_principals'),
      principals: database
        .query<PrincipalRow, []>(
          `SELECT principal_id, display_name, delivery_mode, active, created_at, updated_at
           FROM dispatch_principals
           ORDER BY principal_id`
        )
        .all(),
      rows: count(database, 'SELECT COUNT(*) AS count FROM agent_dispatch_messages'),
      heartbeatRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE status = 'queued' AND task_type = 'run_report' AND priority = 'heartbeat'`
      ),
      otherHeartbeatRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE priority = 'heartbeat'
           AND NOT (status = 'queued' AND task_type = 'run_report')`
      ),
      otherNonNormalRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM agent_dispatch_messages
         WHERE NOT (status = 'queued' AND task_type = 'run_report')
           AND priority <> 'normal'`
      ),
      missingLivePrincipalRows: count(
        database,
        `SELECT COUNT(*) AS count
         FROM (
           SELECT DISTINCT LOWER(TRIM(message.recipient)) AS principal_id
           FROM agent_dispatch_messages AS message
           LEFT JOIN dispatch_principals AS principal
             ON principal.principal_id = LOWER(TRIM(message.recipient))
           WHERE TRIM(message.recipient) <> '' AND principal.principal_id IS NULL
         )`
      ),
      preExistingMessageStateDigest: messageStateDigest(database, before.messageColumns),
      completeMessageStateDigest: messageStateDigest(database),
    };
  } finally {
    database.close();
  }
}

function normalizedDefault(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

function normalizedSql(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function requireColumn(
  columns: readonly TableInfoRow[],
  name: string,
  type: string,
  notNull: number,
  defaultValue: string | null,
  primaryKey: number
): void {
  const column = columns.find(row => row.name === name);
  if (
    column?.type.toUpperCase() !== type ||
    column?.notnull !== notNull ||
    normalizedDefault(column?.dflt_value ?? null) !== defaultValue ||
    column?.pk !== primaryKey
  ) {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
}

function assertSqlContains(sql: string, fragments: readonly string[]): void {
  if (fragments.some(fragment => !sql.includes(fragment))) {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
}

function requireIndex(
  table: TableSnapshot,
  name: string,
  columns: readonly string[],
  unique: number,
  partial: number,
  sqlFragment: string
): void {
  const index = table.indexes.find(row => row.name === name);
  const sql = normalizedSql(
    table.master.find(row => row.type === 'index' && row.name === name)?.sql ?? null
  );
  if (
    index?.columns.map(column => column.name).join(',') !== columns.join(',') ||
    index?.unique !== unique ||
    index?.partial !== partial ||
    !sql.includes(sqlFragment)
  ) {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
}

function validateMessageSchema(table: TableSnapshot): void {
  requireColumn(table.columns, 'priority', 'TEXT', 1, "'normal'", 0);
  for (const name of PHASE_0_NULLABLE_COLUMNS) {
    requireColumn(table.columns, name, 'TEXT', 0, null, 0);
  }
  requireColumn(table.columns, 'sender_principal_id', 'TEXT', 0, null, 0);
  const supersedesForeignKey = table.foreignKeys.find(row => row.from === 'supersedes_id');
  if (
    supersedesForeignKey?.table !== 'agent_dispatch_messages' ||
    supersedesForeignKey?.to !== 'id' ||
    supersedesForeignKey?.on_update !== 'NO ACTION' ||
    supersedesForeignKey?.on_delete !== 'NO ACTION'
  ) {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
  const tableSql = normalizedSql(
    table.master.find(row => row.type === 'table' && row.name === 'agent_dispatch_messages')?.sql ??
      null
  );
  if (/idempotency_key\s+text\s+not\s+null\s+unique/i.test(tableSql)) {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
  assertSqlContains(tableSql, [
    "check (priority in ('blocker', 'normal', 'heartbeat'))",
    "check (task_outcome is null or task_outcome in ('succeeded', 'failed', 'blocked'))",
    "check (route_disposition is null or route_disposition in ('unroutable', 'superseded'))",
    'supersedes_id text references agent_dispatch_messages(id)',
    'sender_principal_id',
  ]);
  requireIndex(
    table,
    REQUIRED_DISPATCH_INDEXES[0],
    ['lease_expires_at'],
    0,
    1,
    "on agent_dispatch_messages(lease_expires_at) where status = 'claimed'"
  );
  requireIndex(
    table,
    REQUIRED_DISPATCH_INDEXES[1],
    ['recipient', 'status'],
    0,
    0,
    'on agent_dispatch_messages(recipient, status)'
  );
  requireIndex(
    table,
    REQUIRED_DISPATCH_INDEXES[2],
    ['recipient_alias', 'status', 'created_at'],
    0,
    0,
    'on agent_dispatch_messages(recipient_alias, status, created_at)'
  );
  requireIndex(
    table,
    'uq_agent_dispatch_messages_sender_idempotency_authenticated',
    ['sender_principal_id', 'idempotency_key'],
    1,
    1,
    'where sender_principal_id is not null'
  );
  requireIndex(
    table,
    'uq_agent_dispatch_messages_idempotency_legacy',
    ['idempotency_key'],
    1,
    1,
    'where sender_principal_id is null'
  );
}

function validatePrincipalSchema(table: TableSnapshot): void {
  requireColumn(table.columns, 'principal_id', 'TEXT', 0, null, 1);
  requireColumn(table.columns, 'display_name', 'TEXT', 1, null, 0);
  requireColumn(table.columns, 'delivery_mode', 'TEXT', 1, null, 0);
  requireColumn(table.columns, 'active', 'INTEGER', 1, '1', 0);
  const created = table.columns.find(row => row.name === 'created_at');
  const updated = table.columns.find(row => row.name === 'updated_at');
  for (const timestamp of [created, updated]) {
    if (
      timestamp?.type.toUpperCase() !== 'TEXT' ||
      timestamp?.notnull !== 1 ||
      !normalizedDefault(timestamp?.dflt_value ?? null)?.includes("strftime('%Y-%m-%dT%H:%M:%fZ'")
    ) {
      throw new SmokeFailure('migration_schema_validation_failed');
    }
  }
  const tableSql = normalizedSql(
    table.master.find(row => row.type === 'table' && row.name === 'dispatch_principals')?.sql ??
      null
  );
  assertSqlContains(tableSql, [
    'principal_id text primary key',
    "delivery_mode in ('worker_poll', 'drain_on_start', 'alias_resolved', 'notify_only')",
    'active in (0, 1)',
  ]);
  const primaryIndex = table.indexes.find(index => index.origin === 'pk' && index.unique === 1);
  if (primaryIndex?.columns.map(column => column.name).join(',') !== 'principal_id') {
    throw new SmokeFailure('migration_schema_validation_failed');
  }
}

function validatePrincipals(principals: PrincipalRow[], liveRecipients: readonly string[]): void {
  const expected = new Map<string, readonly [string, string, number]>();
  for (const [id, displayName, mode, active] of KNOWN_PRINCIPALS) {
    expected.set(id, [displayName, mode, active]);
  }
  for (const recipient of liveRecipients) {
    if (!expected.has(recipient)) expected.set(recipient, [recipient, 'drain_on_start', 1]);
  }
  if (principals.length !== expected.size) {
    throw new SmokeFailure('migration_principal_validation_failed');
  }
  for (const principal of principals) {
    const attributes = expected.get(principal.principal_id);
    if (
      !attributes ||
      principal.principal_id !== principal.principal_id.trim().toLowerCase() ||
      principal.display_name !== attributes[0] ||
      principal.delivery_mode !== attributes[1] ||
      principal.active !== attributes[2] ||
      !Number.isFinite(Date.parse(principal.created_at)) ||
      !Number.isFinite(Date.parse(principal.updated_at)) ||
      !principal.created_at.endsWith('Z') ||
      !principal.updated_at.endsWith('Z')
    ) {
      throw new SmokeFailure('migration_principal_validation_failed');
    }
  }
}

function assertFirstMigration(
  before: BeforeSnapshot,
  after: MigrationSnapshot,
  expectedHeartbeats: number
): void {
  validateMessageSchema(after.messageTable);
  validatePrincipalSchema(after.principalTable);
  validatePrincipals(after.principals, before.liveRecipients);
  if (after.rows !== before.rows) throw new SmokeFailure('migration_message_count_changed');
  if (after.preExistingMessageStateDigest !== before.messageStateDigest) {
    throw new SmokeFailure('migration_pre_existing_message_state_changed');
  }
  if (after.heartbeatRows !== expectedHeartbeats) {
    throw new SmokeFailure(
      `expected ${expectedHeartbeats} heartbeat rows, found ${after.heartbeatRows}`
    );
  }
  // Backfill rules apply only when introducing priority. Existing priorities
  // must instead remain unchanged, as verified by the state digest above.
  if (
    !before.messageColumns.includes('priority') &&
    (after.otherHeartbeatRows !== 0 || after.otherNonNormalRows !== 0)
  ) {
    throw new SmokeFailure('migration_priority_validation_failed');
  }
  if (after.missingLivePrincipalRows !== 0) {
    throw new SmokeFailure('migration_live_principal_missing');
  }
}

async function proveSenderScopedIdempotency(path: string): Promise<void> {
  const database = new Database(path);
  try {
    database.run('BEGIN IMMEDIATE');
    try {
      const key = 'phase15-smoke-shared-key';
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO agent_dispatch_messages
        (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient, body, status, created_at, priority, fencing_token)
       VALUES (?, ?, ?, 'agent_message', 'claude', 'alice', 'codex', 'a', 'queued', ?, 'normal', 0)`,
        ['p15-alice', 'c-a', key, now]
      );
      database.run(
        `INSERT INTO agent_dispatch_messages
        (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient, body, status, created_at, priority, fencing_token)
       VALUES (?, ?, ?, 'agent_message', 'fusion', 'bob', 'codex', 'b', 'queued', ?, 'normal', 0)`,
        ['p15-bob', 'c-b', key, now]
      );
      const scoped = database
        .query<
          CountRow,
          [string]
        >('SELECT COUNT(*) AS count FROM agent_dispatch_messages WHERE idempotency_key = ?')
        .get(key);
      if (scoped?.count !== 2) throw new SmokeFailure('migration_sender_scope_validation_failed');

      let dupFailed = false;
      try {
        database.run(
          `INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, sender_principal_id, recipient, body, status, created_at, priority, fencing_token)
         VALUES (?, ?, ?, 'agent_message', 'claude', 'alice', 'codex', 'a2', 'queued', ?, 'normal', 0)`,
          ['p15-alice-dup', 'c-a2', key, now]
        );
      } catch {
        dupFailed = true;
      }
      if (!dupFailed) throw new SmokeFailure('migration_sender_scope_validation_failed');

      const historical = database
        .query<CountRow, []>(
          `SELECT COUNT(*) AS count FROM agent_dispatch_messages
         WHERE id NOT LIKE 'p15-%' AND sender_principal_id IS NOT NULL`
        )
        .get();
      if ((historical?.count ?? -1) !== 0) {
        throw new SmokeFailure('migration_sender_scope_validation_failed');
      }
    } finally {
      database.run('ROLLBACK');
    }
  } catch (error: unknown) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure('migration_sender_scope_validation_failed');
  } finally {
    database.close();
  }
}

async function runRealMigration(path: string): Promise<void> {
  const adapterUrl = pathToFileURL(
    join(import.meta.dir, '..', '..', 'packages', 'core', 'src', 'db', 'adapters', 'sqlite.ts')
  ).href;
  const runner = `
    process.env.LOG_LEVEL = 'fatal';
    const sqliteModule = await import(${JSON.stringify(adapterUrl)});
    let adapter;
    try {
      adapter = new sqliteModule.SqliteAdapter(process.argv[1]);
      await adapter.query('SELECT 1');
    } finally {
      if (adapter) await adapter.close();
    }
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', runner, path],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'ignore',
    stderr: 'ignore',
    env: { ...process.env, LOG_LEVEL: 'fatal' },
  });
  if ((await child.exited) !== 0) throw new SmokeFailure('migration_initialization_failed');
}

function testTempParent(): string {
  if (process.env.NODE_ENV === 'test') {
    const configured = process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_TEMP_PARENT;
    if (configured) return configured;
  }
  return tmpdir();
}

function induceTestDrift(path: string): void {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_DRIFT_AFTER_FIRST !== '1'
  ) {
    return;
  }
  const database = new Database(path);
  try {
    database.run(
      `UPDATE agent_dispatch_messages
       SET body = body || '-TEST-DRIFT'
       WHERE id = (SELECT id FROM agent_dispatch_messages ORDER BY id LIMIT 1)`
    );
  } finally {
    database.close();
  }
}

async function checkpointValidatedCopy(path: string): Promise<void> {
  if (
    process.env.NODE_ENV === 'test' &&
    process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_CHECKPOINT === '1'
  ) {
    throw new SmokeFailure('migrated_copy_checkpoint_failed');
  }
  const database = new Database(path);
  try {
    const row = database.query<WalCheckpointRow, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (row?.busy !== 0 || (row?.log !== -1 && row?.log !== row?.checkpointed)) {
      throw new SmokeFailure('migrated_copy_checkpoint_failed');
    }
  } catch (error: unknown) {
    throw error instanceof SmokeFailure
      ? error
      : new SmokeFailure('migrated_copy_checkpoint_failed');
  } finally {
    database.close();
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof Bun.gc === 'function') Bun.gc(true);
    try {
      await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
    } catch {
      // Retry after SQLite resources have had a chance to release file handles.
    }
    if (!(await Bun.file(`${path}-wal`).exists()) && !(await Bun.file(`${path}-shm`).exists())) {
      return;
    }
    if (attempt < 2) await Bun.sleep(25);
  }
  throw new SmokeFailure('migrated_copy_checkpoint_failed');
}

function exportStagingPath(outputPath: string): string {
  return join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.partial`);
}

async function exportMigratedCopy(tempPath: string, outputPath: string): Promise<void> {
  const stagingPath = exportStagingPath(outputPath);
  let outputLinked = false;
  try {
    if (
      process.env.NODE_ENV === 'test' &&
      process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_EXPORT_DURING_COPY === '1'
    ) {
      await writeFile(stagingPath, 'partial', { flag: 'wx' });
      throw new Error('induced_partial_export_failure');
    }
    await copyFile(tempPath, stagingPath, fileSystemConstants.COPYFILE_EXCL);
    await link(stagingPath, outputPath);
    outputLinked = true;
    if (
      process.env.NODE_ENV === 'test' &&
      process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_EXPORT_AFTER_COPY === '1'
    ) {
      throw new Error('induced_export_failure');
    }
    await rm(stagingPath, { force: false });
  } catch {
    let cleanupFailed = false;
    if (outputLinked) {
      try {
        await rm(outputPath, { force: false });
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await rm(stagingPath, { force: true });
    } catch {
      cleanupFailed = true;
    }
    throw new SmokeFailure(
      cleanupFailed
        ? 'migrated_copy_export_failed;migrated_copy_cleanup_failed'
        : 'migrated_copy_export_failed'
    );
  }
}

function publicFailure(error: unknown): SmokeFailure {
  return error instanceof SmokeFailure ? error : new SmokeFailure('migration_smoke_failed');
}

export async function runDispatchMigrationSmoke(args: string[]): Promise<string> {
  const options = parseArguments(args);
  const canonicalSource = await canonicalSafeSourcePath(options.sourceCopy);
  await assertSourceCopyHasNoSidecars(options.sourceCopy, canonicalSource);
  const migratedCopyOutput = options.migratedCopyOutput
    ? await validateMigratedCopyOutputPath(
        options.migratedCopyOutput,
        options.sourceCopy,
        canonicalSource
      )
    : null;
  const sourceHashBefore = await sha256File(canonicalSource);
  let tempDirectory: string | null = null;
  let output: string | null = null;
  let primaryError: SmokeFailure | null = null;

  try {
    try {
      tempDirectory = await mkdtemp(join(testTempParent(), 'dispatch-migration-smoke-'));
    } catch {
      throw new SmokeFailure('temporary_copy_failed');
    }
    const tempPath = join(tempDirectory, 'migration-copy.db');
    try {
      await assertSourceCopyHasNoSidecars(options.sourceCopy, canonicalSource);
      await copyFile(canonicalSource, tempPath);
      await assertSourceCopyHasNoSidecars(options.sourceCopy, canonicalSource);
    } catch (error: unknown) {
      if (error instanceof SmokeFailure) throw error;
      throw new SmokeFailure('temporary_copy_failed');
    }

    let before: BeforeSnapshot;
    try {
      before = inspectBeforeMigration(tempPath);
    } catch {
      throw new SmokeFailure('source_schema_read_failed');
    }
    await runRealMigration(tempPath);
    let first: MigrationSnapshot;
    try {
      first = inspectAfterMigration(tempPath, before);
    } catch (error: unknown) {
      throw publicFailure(error).code === 'migration_snapshot_failed'
        ? new SmokeFailure('migration_schema_validation_failed')
        : publicFailure(error);
    }
    assertFirstMigration(before, first, options.expectedHeartbeats);
    const reportedRowsAfter = first.rows;
    const reportedHeartbeats = first.heartbeatRows;
    await proveSenderScopedIdempotency(tempPath);
    const afterProof = inspectAfterMigration(tempPath, before);
    if (canonicalDigest(afterProof) !== canonicalDigest(first)) {
      throw new SmokeFailure('migration_sender_scope_validation_failed');
    }

    induceTestDrift(tempPath);
    await runRealMigration(tempPath);
    let second: MigrationSnapshot;
    try {
      second = inspectAfterMigration(tempPath, before);
    } catch {
      throw new SmokeFailure('migration_second_run_not_idempotent');
    }
    if (canonicalDigest(second) !== canonicalDigest(first)) {
      throw new SmokeFailure('migration_second_run_not_idempotent');
    }

    await assertSourceCopyHasNoSidecars(options.sourceCopy, canonicalSource);
    const sourceHashAfter = await sha256File(canonicalSource);
    if (sourceHashAfter !== sourceHashBefore) throw new SmokeFailure('source_copy_changed');
    if (migratedCopyOutput) {
      await checkpointValidatedCopy(tempPath);
      await assertSourceCopyHasNoSidecars(options.sourceCopy, canonicalSource);
      await exportMigratedCopy(tempPath, migratedCopyOutput);
    }
    output =
      `PASS rows_before=${before.rows} rows_after=${reportedRowsAfter} ` +
      `heartbeat_rows=${reportedHeartbeats} source_unchanged=true second_run_idempotent=true` +
      (migratedCopyOutput ? ' migrated_copy_ready=true' : '');
  } catch (error: unknown) {
    primaryError = publicFailure(error);
  }

  let cleanupFailed = false;
  if (tempDirectory) {
    if (typeof Bun.gc === 'function') Bun.gc(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (
          process.env.NODE_ENV === 'test' &&
          process.env.BDC_DISPATCH_MIGRATION_SMOKE_TEST_FAIL_CLEANUP === '1'
        ) {
          throw new Error('induced_cleanup_failure');
        }
        await rm(tempDirectory, { recursive: true, force: true });
        cleanupFailed = false;
        break;
      } catch {
        cleanupFailed = true;
        if (attempt < 2) await Bun.sleep(25);
      }
    }
  }
  if (primaryError && cleanupFailed) {
    throw new SmokeFailure(`${primaryError.code};temporary_cleanup_failed`);
  }
  if (primaryError) throw primaryError;
  if (cleanupFailed) throw new SmokeFailure('temporary_cleanup_failed');
  if (!output) throw new SmokeFailure('migration_smoke_failed');
  return output;
}

if (import.meta.main) {
  runDispatchMigrationSmoke(process.argv.slice(2))
    .then(output => {
      process.stdout.write(`${output}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${publicFailure(error).code}\n`);
      process.exitCode = 1;
    });
}
