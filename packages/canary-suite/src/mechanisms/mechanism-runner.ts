import { randomUUID } from 'crypto';
import { link, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { evaluateMechanismResult } from './absence-evaluator';
import { mechanismRegistry } from './registry';
import { writeRunnerHeartbeat } from './runner-liveness';
import type { MechanismDefinition, MechanismReport } from './types';

export interface RunMechanismsOptions {
  readonly level?: 0 | 1;
  readonly outputRoot: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly registry?: readonly MechanismDefinition[];
  readonly now?: () => Date;
}

export function renderMechanismMarkdown(report: MechanismReport): string {
  return `${['# Cross-Mechanism Canary Report', '', `- Suite run: \`${report.suiteRunId}\``, `- Level: ${report.level}`, `- Verdict: **${report.verdict.toUpperCase()}**`, `- Observed: ${report.generatedAt}`, '', '| Mechanism | Verdict | Reasons | Evidence |', '|---|---|---|---|', ...report.mechanisms.map(item => `| ${item.id} | ${item.verdict} | ${item.reasonCodes.join(', ') || '-'} | ${item.evidenceRefs.join(', ') || '-'} |`), ''].join('\n')}\n`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeMechanismArtifacts(
  outputRoot: string,
  report: MechanismReport
): Promise<string[]> {
  const directory = join(outputRoot, report.suiteRunId);
  const paths = [join(directory, 'summary.json'), join(directory, 'summary.md')];
  const contents = [`${JSON.stringify(report, null, 2)}\n`, renderMechanismMarkdown(report)];
  await mkdir(directory, { recursive: true });
  const existing = await Promise.all(paths.map(readIfPresent));
  if (existing.every((value, index) => value === contents[index])) return paths;
  if (existing.some(Boolean)) throw new Error('mechanism_artifact_conflict');
  const suffix = randomUUID();
  for (let i = 0; i < paths.length; i += 1) {
    const temporary = `${paths[i]}.tmp-${suffix}`;
    await writeFile(temporary, contents[i], { flag: 'wx' });
    try {
      await link(temporary, paths[i]);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return paths;
}

export async function runMechanisms(
  options: RunMechanismsOptions
): Promise<{ report: MechanismReport; artifactPaths: readonly string[] }> {
  const level = options.level ?? 0;
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const suiteRunId = `mechanisms-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const selected = (options.registry ?? mechanismRegistry).filter(item => item.level <= level);
  const mechanisms = await Promise.all(
    selected.map(async definition => {
      try {
        return {
          id: definition.id,
          ...evaluateMechanismResult(
            await definition.probe({
              env: options.env ?? process.env,
              outputRoot: options.outputRoot,
            })
          ),
        };
      } catch (error) {
        return {
          id: definition.id,
          verdict: 'failed' as const,
          reasonCodes: [`mechanism_probe_threw:${definition.id}`],
          evidenceRefs: [`error=${(error as Error).message}`],
        };
      }
    })
  );
  const verdict = mechanisms.some(item => item.verdict === 'failed')
    ? 'failed'
    : mechanisms.some(item => item.verdict === 'blocked')
      ? 'blocked'
      : 'passed';
  const report: MechanismReport = {
    schemaVersion: 1,
    suiteRunId,
    level,
    generatedAt,
    verdict,
    reasonCodes: mechanisms.flatMap(item => item.reasonCodes),
    evidenceRefs: mechanisms.flatMap(item => item.evidenceRefs),
    mechanisms,
  };
  const artifactPaths = await writeMechanismArtifacts(options.outputRoot, report);
  const heartbeat = await writeRunnerHeartbeat(options.outputRoot, {
    observedAt: generatedAt,
    suiteRunId,
  });
  return { report, artifactPaths: [...artifactPaths, heartbeat] };
}
