import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type { LifecycleCanaryReport } from './types';
import { isValidLifecycleRunId } from './lifecycle-canary';

// Renders the ten-leg scoreboard. Each row reports verdict + reason codes +
// artifact-query evidence, per Section 6/Stop Point 1 of the WO (no leg silently
// omitted, no false pass).
export function renderLifecycleMarkdown(report: LifecycleCanaryReport): string {
  const lines: string[] = [
    '# Lifecycle Canary Report (end-to-end wheel probe)',
    '',
    `- Suite run: \`${report.suiteRunId}\``,
    `- Verdict: **${report.verdict.toUpperCase()}**`,
    `- Generated: ${report.generatedAt}`,
    `- Reason codes: ${report.reasonCodes.length ? report.reasonCodes.join(', ') : '-'}`,
    '',
    '| # | Leg | Verdict | Reasons | Gap | Evidence |',
    '|---:|---|---|---|---|---|',
    ...report.legs.map(
      (legReport, index) =>
        `| ${index + 1} | ${legReport.title} | ${legReport.verdict} | ${legReport.reasonCodes.join(', ') || '-'} | ${legReport.gap ?? '-'} | ${legReport.evidenceRefs.join('; ') || '-'} |`
    ),
    '',
    '## Invariants',
    '',
    report.invariantViolations.length
      ? report.invariantViolations.map(violation => `- VIOLATED: ${violation}`).join('\n')
      : '- No invariant violations detected.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Renders the evidence markdown filed under docs/evidence/. Distinct from the
// per-run summary.md: this is the durable, dated record referenced by the WO
// (leg results, cleanup status, timings), independent of the run-id-keyed
// output-root artifact directory.
export function renderLifecycleEvidence(report: LifecycleCanaryReport, dateStamp: string): string {
  const leg10 = report.legs.find(l => l.legId === 'canary-reverts');
  const cleanupLine =
    leg10?.evidenceRefs.find(ref => ref.startsWith('cleanup=')) ?? 'cleanup=unknown';
  const lines: string[] = [
    `# Lifecycle Canary Evidence -- ${dateStamp}`,
    '',
    `- Suite run: \`${report.suiteRunId}\``,
    `- Verdict: **${report.verdict.toUpperCase()}**`,
    `- Generated: ${report.generatedAt}`,
    `- Cleanup status: ${cleanupLine}`,
    '',
    '## Leg results',
    '',
    '| # | Leg | Verdict | Reasons | Evidence |',
    '|---:|---|---|---|---|',
    ...report.legs.map(
      (legReport, index) =>
        `| ${index + 1} | ${legReport.title} | ${legReport.verdict} | ${legReport.reasonCodes.join(', ') || '-'} | ${legReport.evidenceRefs.join('; ') || '-'} |`
    ),
    '',
    '## Invariants',
    '',
    report.invariantViolations.length
      ? report.invariantViolations.map(violation => `- VIOLATED: ${violation}`).join('\n')
      : '- No invariant violations detected.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

// Path-traversal guard for a CLI-controlled runId used to build a filesystem
// path. Defense in depth: cli.ts validates at parse time; this function
// re-validates here because this is the actual filesystem write site and must
// never trust its caller. On failure this rejects (never throws synchronously
// at call time) so both CLI and programmatic callers get a normal error path.
function assertContainedPath(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(
      `lifecycle_canary_path_escape: resolved path ${resolvedTarget} is outside artifact root ${resolvedRoot}`
    );
  }
}

// Atomic write mirroring report.ts: temp file + link, idempotent on identical
// content, conflict-safe on divergent bytes for the same run id.
export async function writeLifecycleCanaryArtifacts(
  outputRoot: string,
  report: LifecycleCanaryReport
): Promise<string[]> {
  // Defense in depth: cli.ts validates --run-id at parse time, but this
  // function is the actual filesystem write site and must never trust its
  // caller -- runId is joined directly into a filesystem path below.
  if (!isValidLifecycleRunId(report.suiteRunId)) {
    throw new Error(`lifecycle_canary_invalid_run_id: ${report.suiteRunId}`);
  }
  const resolvedRoot = resolve(outputRoot);
  const directory = join(outputRoot, report.suiteRunId);
  // The runId-derived directory is the only path built from CLI-controlled
  // input; after path.resolve, assert it is still inside the artifact root
  // (prevents any remaining traversal vector even though the regex above
  // already rejects '..' and path separators).
  assertContainedPath(resolvedRoot, directory);

  const dateStamp = report.generatedAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const evidenceDir = join(resolvedRoot, '..', 'docs', 'evidence');
  const evidencePath = join(evidenceDir, `lifecycle-canary-${dateStamp}.md`);
  const paths = [join(directory, 'summary.json'), join(directory, 'summary.md'), evidencePath];
  const contents = [
    `${JSON.stringify(report, null, 2)}\n`,
    renderLifecycleMarkdown(report),
    renderLifecycleEvidence(report, dateStamp),
  ];
  await mkdir(directory, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const existing = await Promise.all(paths.map(readIfPresent));
  if (existing.every((value, index) => value === contents[index])) return paths;
  if (existing.some(value => value !== null)) throw new Error('lifecycle_canary_artifact_conflict');

  const writerId = randomUUID();
  const temporary = paths.map(path => `${path}.tmp-${writerId}`);
  try {
    for (let index = 0; index < temporary.length; index += 1) {
      await writeFile(temporary[index], contents[index], { flag: 'wx' });
    }
    for (let index = 0; index < paths.length; index += 1) {
      try {
        await link(temporary[index], paths[index]);
      } catch (error) {
        const published = await readIfPresent(paths[index]);
        if (published !== contents[index]) throw error;
      }
      await rm(temporary[index], { force: true });
    }
  } catch (error) {
    await Promise.all(temporary.map(path => rm(path, { force: true })));
    throw error;
  }
  return paths;
}
