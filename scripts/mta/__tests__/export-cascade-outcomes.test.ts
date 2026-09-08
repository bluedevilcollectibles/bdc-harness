import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { removeTempDirWithRetry } from '../../../packages/core/src/test/temp-dir';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDatabase,
  getDatabase,
  resetDatabase,
} from '../../../packages/core/src/db/connection';
import {
  parseMetadata,
  parsePriorTier,
  parseProject,
  parseWoId,
  runRowToOutcomeRecord,
  type CascadeOutcomeRecord,
  type WorkflowRunExportRow,
} from '../lib/extract-cascade-outcome';
import { parseCliArgs, recordsToJsonl, runExport } from '../export-cascade-outcomes';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_PATH = join(REPO_ROOT, 'scripts', 'mta', 'export-cascade-outcomes.ts');

let savedArchonHome: string | undefined;
let savedDatabaseUrl: string | undefined;
let testHome: string;

function isolateHome(): void {
  savedArchonHome = process.env.ARCHON_HOME;
  savedDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  testHome = mkdtempSync(join(tmpdir(), 'mta-cascade-export-'));
  process.env.ARCHON_HOME = testHome;
  resetDatabase();
}

async function restoreHome(): Promise<void> {
  await closeDatabase();
  resetDatabase();
  if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = savedArchonHome;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  try {
    removeTempDirWithRetry(testHome);
  } catch {
    // Best-effort temp cleanup.
  }
}

async function seedConversation(id = 'conv-mta-1'): Promise<string> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO remote_agent_conversations
       (id, platform_type, platform_conversation_id)
     VALUES ($1, $2, $3)`,
    [id, 'test', `plat-${id}`]
  );
  return id;
}

async function seedRun(opts: {
  id: string;
  conversationId: string;
  workflowName: string;
  userMessage: string;
  status: string;
  metadata: Record<string, unknown>;
  startedAt: string;
  completedAt: string | null;
}): Promise<void> {
  const db = getDatabase();
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, conversation_id, workflow_name, user_message, status, metadata, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.id,
      opts.conversationId,
      opts.workflowName,
      opts.userMessage,
      opts.status,
      JSON.stringify(opts.metadata),
      opts.startedAt,
      opts.completedAt,
    ]
  );
}

const COMPLETED_SUMMARY = [
  {
    node_id: 'implement',
    declared_model_id: 'sonnet',
    requested_model_id: 'sonnet',
    served_model_id: 'claude-sonnet-4-5',
    mismatch: false,
  },
  {
    node_id: 'review',
    declared_model_id: 'sonnet',
    requested_model_id: 'sonnet',
    served_model_id: 'claude-sonnet-4-5',
    mismatch: false,
  },
];

function fixtureRow(partial: Partial<WorkflowRunExportRow> & { id: string }): WorkflowRunExportRow {
  return {
    workflow_name: 'bdc-feature-development',
    user_message: 'WO_ID=WO-HARNESS-MOCK-01 --project bdc-harness',
    status: 'completed',
    metadata: {},
    started_at: '2026-08-01 10:00:00',
    completed_at: '2026-08-01 10:05:00',
    ...partial,
  };
}

describe('cascade outcome extractor', () => {
  test('parses WO_ID assignment, --project, and locked prior-tier tokens', () => {
    const message =
      'WO_ID=WO-HARNESS-CASCADE-OUTCOME-EXPORT-01 --project bdc-harness prior_tier=sonnet';
    expect(parseWoId(message)).toBe('WO-HARNESS-CASCADE-OUTCOME-EXPORT-01');
    expect(parseProject(message)).toBe('bdc-harness');
    expect(parsePriorTier(message)).toBe('sonnet');
    expect(parsePriorTier('prior-tier opus Execute WO-FOO-01')).toBe('opus');
    expect(parsePriorTier('no escalation context here')).toBeNull();
    expect(parsePriorTier('prior_tier="haiku"')).toBe('haiku');
    expect(parsePriorTier('flags: --prior-tier=gpt-5')).toBe('gpt-5');
    expect(parsePriorTier(null, { prior_tier: 'sonnet' })).toBe('sonnet');
    expect(parseMetadata(undefined)).toEqual({});
    expect(parseMetadata('{not-json')).toEqual({});
    expect(parseMetadata({ node_counts: { failed: 1 } }).node_counts).toEqual({ failed: 1 });
  });

  test('gap honesty: failed run without model attribution invents no models', () => {
    const record = runRowToOutcomeRecord({
      id: 'run-failed-1',
      workflow_name: 'bdc-feature-development',
      user_message: 'WO_ID=WO-HARNESS-CASCADE-OUTCOME-EXPORT-01 --project bdc-harness',
      status: 'failed',
      metadata: {
        node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
        total_cost_usd: 1.25,
        total_tokens: 4000,
      },
      started_at: '2026-08-01 10:00:00',
      completed_at: '2026-08-01 10:05:00',
    });
    expect(record.attribution_complete).toBe(false);
    expect(record.models_served).toEqual([]);
    expect(record.model_mismatches).toBe(0);
    expect(record.wo_id).toBe('WO-HARNESS-CASCADE-OUTCOME-EXPORT-01');
    expect(record.project).toBe('bdc-harness');
    expect(record.duration_s).toBe(300);
    expect(record.prior_tier).toBeNull();
    const jsonl = recordsToJsonl([record]);
    expect(jsonl).toContain('"attribution_complete":false');
    const exported = JSON.parse(jsonl.trim()) as CascadeOutcomeRecord;
    expect(exported.attribution_complete).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(exported, 'attribution_complete')).toBe(true);
    expect(exported.models_served).toEqual([]);
  });

  test('does not throw on missing nested metadata fields', () => {
    const record = runRowToOutcomeRecord({
      id: 'run-null-meta',
      workflow_name: 'bdc-feature-development',
      user_message: null,
      status: 'completed',
      metadata: null,
      started_at: null,
      completed_at: null,
    });
    expect(record.wo_id).toBeNull();
    expect(record.project).toBeNull();
    expect(record.prior_tier).toBeNull();
    expect(record.node_counts).toBeNull();
    expect(record.models_served).toEqual([]);
    expect(record.attribution_complete).toBe(false);
    expect(record.started_at).toBeNull();
    expect(record.completed_at).toBeNull();
    expect(record.duration_s).toBeNull();
  });

  test('cascade linkage: prior_tier populated and WO_ID shared with predecessor', () => {
    const woId = 'WO-HARNESS-CASCADE-OUTCOME-EXPORT-01';
    const predecessor = runRowToOutcomeRecord({
      id: 'run-pred',
      workflow_name: 'bdc-feature-development',
      user_message: `WO_ID=${woId} --project bdc-harness`,
      status: 'failed',
      metadata: {},
      started_at: '2026-08-01 09:00:00',
      completed_at: '2026-08-01 09:10:00',
    });
    const successor = runRowToOutcomeRecord({
      id: 'run-succ',
      workflow_name: 'bdc-feature-development',
      user_message: `WO_ID=${woId} --project bdc-harness prior_tier=sonnet`,
      status: 'completed',
      metadata: {
        node_counts: { completed: 3, failed: 0, skipped: 0, total: 3 },
        node_model_summary: COMPLETED_SUMMARY,
        total_cost_usd: 2.5,
        total_tokens: 8000,
      },
      started_at: '2026-08-01 10:00:00',
      completed_at: '2026-08-01 10:20:00',
    });
    expect(successor.prior_tier).toBe('sonnet');
    expect(successor.wo_id).toBe(woId);
    expect(predecessor.wo_id).toBe(successor.wo_id);
    expect(successor.models_served).toEqual(['claude-sonnet-4-5', 'claude-sonnet-4-5']);
    expect(successor.attribution_complete).toBe(true);
  });
});

describe('cascade outcome CLI', () => {
  beforeEach(() => {
    isolateHome();
  });

  afterEach(async () => {
    await restoreHome();
  });

  test('success: --write emits 3 JSONL rows with parsed wo_id/project and models_served', async () => {
    const convId = await seedConversation();
    const started = ['2026-08-01 10:00:00', '2026-08-01 11:00:00', '2026-08-01 12:00:00'];
    const completed = ['2026-08-01 10:10:00', '2026-08-01 11:15:00', '2026-08-01 12:05:00'];
    const fixtures = [
      {
        id: 'run-ok-1',
        wo: 'WO-HARNESS-ONE-01',
        project: 'bdc-harness',
        models: ['claude-sonnet-4-5'],
      },
      {
        id: 'run-ok-2',
        wo: 'WO-HARNESS-TWO-01',
        project: 'bdc-xo',
        models: ['gpt-5'],
      },
      {
        id: 'run-ok-3',
        wo: 'WO-HARNESS-THREE-01',
        project: 'shopops',
        models: ['claude-opus-4-1'],
      },
    ];

    for (let i = 0; i < fixtures.length; i++) {
      const fx = fixtures[i];
      await seedRun({
        id: fx.id,
        conversationId: convId,
        workflowName: 'bdc-feature-development',
        userMessage: `WO_ID=${fx.wo} --project ${fx.project}`,
        status: 'completed',
        metadata: {
          node_counts: { completed: 2, failed: 0, skipped: 0, total: 2 },
          node_model_summary: [
            {
              node_id: 'implement',
              served_model_id: fx.models[0],
              mismatch: false,
            },
          ],
          total_cost_usd: 1 + i,
          total_tokens: 1000 * (i + 1),
        },
        startedAt: started[i],
        completedAt: completed[i],
      });
    }

    const outPath = join(testHome, 'mta.jsonl');
    const result = await runExport({ since: null, out: outPath, write: true });
    expect(result.count).toBe(3);
    expect(result.wrote).toBe(true);
    expect(existsSync(outPath)).toBe(true);

    const lines = readFileSync(outPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const rows = lines.map(line => JSON.parse(line) as CascadeOutcomeRecord);
    expect(rows.map(r => r.wo_id)).toEqual(fixtures.map(f => f.wo));
    expect(rows.map(r => r.project)).toEqual(fixtures.map(f => f.project));
    expect(rows.map(r => r.models_served)).toEqual(fixtures.map(f => f.models));
    expect(rows.every(r => r.format_version === '1.0')).toBe(true);
    expect(recordsToJsonl(rows).split('\n').filter(Boolean)).toHaveLength(3);
  });

  test('mocked loader: --write does not open a live database', async () => {
    const outPath = join(testHome, 'mocked.jsonl');
    const result = await runExport(
      { since: null, out: outPath, write: true },
      {
        loadRows: async () => [
          fixtureRow({
            id: 'mock-1',
            user_message: 'WO_ID=WO-HARNESS-MOCK-01 --project bdc-harness',
            metadata: {
              node_model_summary: [{ node_id: 'implement', served_model_id: 'claude-sonnet-4-5' }],
              node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
            },
          }),
        ],
      }
    );
    expect(result.count).toBe(1);
    const exported = JSON.parse(readFileSync(outPath, 'utf8').trim()) as CascadeOutcomeRecord;
    expect(exported.wo_id).toBe('WO-HARNESS-MOCK-01');
    expect(exported.models_served).toEqual(['claude-sonnet-4-5']);
  });

  test('dry-run default: prints a row count and writes no file', async () => {
    const convId = await seedConversation();
    await seedRun({
      id: 'run-dry-1',
      conversationId: convId,
      workflowName: 'bdc-feature-development',
      userMessage: 'WO_ID=WO-HARNESS-DRY-01 --project bdc-harness',
      status: 'completed',
      metadata: {
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
        node_model_summary: [{ node_id: 'implement', served_model_id: 'claude-sonnet-4-5' }],
      },
      startedAt: '2026-08-01 10:00:00',
      completedAt: '2026-08-01 10:01:00',
    });

    const outPath = join(testHome, 'should-not-exist.jsonl');
    const args = parseCliArgs(['--out', outPath]);
    expect(args.write).toBe(false);

    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_PATH, '--out', outPath],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ARCHON_HOME: testHome,
        DATABASE_URL: undefined,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('export-cascade-outcomes failed');
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toMatch(/1 cascade outcome row/);
    expect(existsSync(outPath)).toBe(false);
  });

  test('rejects malformed CLI args and invalid --since ISO dates', () => {
    expect(() => parseCliArgs(['--since'])).toThrow(/Missing value for --since/);
    expect(() => parseCliArgs(['--out'])).toThrow(/Missing value for --out/);
    expect(() => parseCliArgs(['--write', '--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseCliArgs(['--since', 'not-a-date'])).toThrow(/Invalid --since timestamp/);
    expect(() => parseCliArgs(['--since', '2026-99-99T00:00:00Z'])).toThrow(
      /Invalid --since timestamp/
    );
    expect(
      parseCliArgs(['--since', '2026-01-01T00:00:00Z', '--write', '--out', '/tmp/mta.jsonl'])
    ).toEqual({
      since: '2026-01-01T00:00:00Z',
      write: true,
      out: '/tmp/mta.jsonl',
    });
  });

  test('gap honesty CLI: --write emits attribution_complete false for failed unattributed run', async () => {
    const outPath = join(testHome, 'gap.jsonl');
    const result = await runExport(
      { since: null, out: outPath, write: true },
      {
        loadRows: async () => [
          fixtureRow({
            id: 'run-gap-1',
            user_message: 'WO_ID=WO-HARNESS-GAP-01 --project bdc-harness',
            status: 'failed',
            metadata: {
              node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
              total_cost_usd: 0.5,
              total_tokens: 100,
            },
          }),
        ],
      }
    );
    expect(result.count).toBe(1);
    const raw = readFileSync(outPath, 'utf8');
    expect(raw).toContain('"attribution_complete":false');
    const exported = JSON.parse(raw.trim()) as CascadeOutcomeRecord;
    expect(exported.attribution_complete).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(exported, 'attribution_complete')).toBe(true);
    expect(exported.models_served).toEqual([]);
    expect(exported.wo_id).toBe('WO-HARNESS-GAP-01');
  });
});
