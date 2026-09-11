import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderLifecycleMarkdown, writeLifecycleCanaryArtifacts } from './lifecycle-report';
import type { LifecycleCanaryReport } from './types';

function report(overrides: Partial<LifecycleCanaryReport> = {}): LifecycleCanaryReport {
  return {
    schemaVersion: 1,
    suiteRunId: 'lifecycle-fixture-001',
    generatedAt: '2026-09-02T00:00:00.000Z',
    verdict: 'blocked',
    reasonCodes: ['taskmaster_never_fires'],
    invariantViolations: [],
    legs: [
      {
        legId: 'taskmaster-fire',
        title: 'Taskmaster proposes/dispatches the canary WO',
        verdict: 'blocked',
        reasonCodes: ['taskmaster_never_fires'],
        evidenceRefs: ['tm_journal.fire_cauldron_rows=0'],
        gap: 'taskmaster-never-fired, fallback: fire.ps1 used',
      },
      {
        legId: 'canary-reverts',
        title: 'the canary change reverts so dev stays clean',
        verdict: 'passed',
        reasonCodes: [],
        evidenceRefs: ['scratch_residue_diff=empty'],
      },
    ],
    ...overrides,
  };
}

test('renders every leg with verdict, reasons, gap and evidence', () => {
  const markdown = renderLifecycleMarkdown(report());
  expect(markdown).toContain('| # | Leg | Verdict | Reasons | Gap | Evidence |');
  expect(markdown).toContain('Taskmaster proposes/dispatches the canary WO');
  expect(markdown).toContain('taskmaster_never_fires');
  expect(markdown).toContain('taskmaster-never-fired, fallback: fire.ps1 used');
  expect(markdown).toContain('- No invariant violations detected.');
});

test('renders invariant violations when present', () => {
  const markdown = renderLifecycleMarkdown(
    report({ invariantViolations: ['canary_diff_scope_violation: packages/server/src/x.ts'] })
  );
  expect(markdown).toContain('VIOLATED: canary_diff_scope_violation');
});

// The evidence file (docs/evidence/lifecycle-canary-<date>.md) is written
// relative to outputRoot's PARENT, not inside outputRoot itself, so cleanup
// must remove that sibling directory too -- otherwise runs sharing the same
// OS tmp parent (mkdtemp always shares one) leak evidence files across tests.
async function cleanupEvidenceSibling(root: string): Promise<void> {
  await rm(join(root, '..', 'docs'), { recursive: true, force: true });
}

test('writes summary.json, summary.md, and the evidence file atomically and idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-report-'));
  try {
    const paths = await writeLifecycleCanaryArtifacts(root, report());
    const relative = paths.map(path => path.replaceAll('\\', '/'));
    expect(relative[0]!.endsWith('lifecycle-fixture-001/summary.json')).toBe(true);
    expect(relative[1]!.endsWith('lifecycle-fixture-001/summary.md')).toBe(true);
    expect(relative[2]!.endsWith('docs/evidence/lifecycle-canary-2026-09-02.md')).toBe(true);
    expect(JSON.parse(await readFile(paths[0]!, 'utf8')).suiteRunId).toBe('lifecycle-fixture-001');
    const evidence = await readFile(paths[2]!, 'utf8');
    expect(evidence).toContain('lifecycle-fixture-001');
    expect(evidence).toContain('cleanup=');
    // Idempotent second write returns the same paths.
    await expect(writeLifecycleCanaryArtifacts(root, report())).resolves.toEqual(paths);
    expect((await readdir(join(root, 'lifecycle-fixture-001'))).sort()).toEqual([
      'summary.json',
      'summary.md',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await cleanupEvidenceSibling(root);
  }
});

test('rejects conflicting bytes for an existing run id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-report-conflict-'));
  try {
    await writeLifecycleCanaryArtifacts(root, report());
    await expect(
      writeLifecycleCanaryArtifacts(root, report({ verdict: 'failed' }))
    ).rejects.toThrow('lifecycle_canary_artifact_conflict');
  } finally {
    await rm(root, { recursive: true, force: true });
    await cleanupEvidenceSibling(root);
  }
});

test('rejects an invalid runId at the artifact-writer level (path-traversal defense in depth)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-report-invalid-runid-'));
  try {
    await expect(
      writeLifecycleCanaryArtifacts(root, report({ suiteRunId: '../../etc/passwd' }))
    ).rejects.toThrow('lifecycle_canary_invalid_run_id');
  } finally {
    await rm(root, { recursive: true, force: true });
    await cleanupEvidenceSibling(root);
  }
});
