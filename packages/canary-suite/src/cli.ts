import { readFile } from 'fs/promises';
import { runCanary, type RunCanaryOptions } from './runner';
import type { RunCanaryResult } from './types';
import { runMechanisms, type RunMechanismsOptions } from './mechanisms/mechanism-runner';
import type { MechanismReport } from './mechanisms/types';
import {
  runTaskmasterCanarySuite,
  writeTaskmasterCanaryArtifacts,
  type TaskmasterCanaryDeps,
  type TaskmasterCanaryResult,
} from './taskmaster-canary';

interface CanaryCliDeps {
  readonly runner: (options: RunCanaryOptions) => Promise<RunCanaryResult>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly taskmasterRunner?: (options: TaskmasterCanaryDeps) => Promise<TaskmasterCanaryResult>;
  readonly taskmasterArtifactWriter?: (
    outputRoot: string,
    report: TaskmasterCanaryResult
  ) => Promise<readonly string[]>;
  readonly mechanismRunner?: (
    options: RunMechanismsOptions
  ) => Promise<{ report: MechanismReport; artifactPaths: readonly string[] }>;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function exitFor(verdict: RunCanaryResult['report']['verdict']): number {
  return {
    passed: 0,
    probe_passed: 0,
    failed: 2,
    probe_failed: 2,
    build_failed: 2,
    blocked: 3,
    aborted: 4,
    static_only: 5,
  }[verdict];
}

export async function runCanaryCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: CanaryCliDeps = {
    runner: runCanary,
    stdout: value => process.stdout.write(`${value}\n`),
    stderr: value => process.stderr.write(`${value}\n`),
  }
): Promise<number> {
  const command = args[0];
  if (command === 'mechanisms') {
    const outputRoot = flag(args, '--output-root');
    const levelValue = flag(args, '--level') ?? '0';
    if (!outputRoot || (levelValue !== '0' && levelValue !== '1')) {
      deps.stderr('mechanism_canary_missing_or_invalid_required_argument');
      return 3;
    }
    const result = await (deps.mechanismRunner ?? runMechanisms)({
      outputRoot,
      level: Number(levelValue) as 0 | 1,
      env,
    });
    deps.stdout(
      args.includes('--json')
        ? JSON.stringify(result.report, null, 2)
        : `${result.report.verdict}: ${result.report.suiteRunId}`
    );
    return exitFor(result.report.verdict);
  }
  if (command === 'taskmaster') {
    const dbPath = flag(args, '--db-path');
    const statusUrl = flag(args, '--status-url');
    const githubRepo = flag(args, '--github-repo');
    const outputRoot = flag(args, '--output-root');
    const issueValue = flag(args, '--github-issue');
    const intervalValue = flag(args, '--interval-ms') ?? env.TASKMASTER_INTERVAL_MS;
    const githubIssue = issueValue === undefined ? NaN : Number(issueValue);
    const intervalMs = intervalValue === undefined ? undefined : Number(intervalValue);
    if (
      !dbPath ||
      !statusUrl ||
      !githubRepo ||
      !outputRoot ||
      !Number.isSafeInteger(githubIssue) ||
      githubIssue <= 0 ||
      (intervalMs !== undefined && (!Number.isFinite(intervalMs) || intervalMs < 0))
    ) {
      deps.stderr('taskmaster_canary_missing_or_invalid_required_argument');
      return 3;
    }
    const report = await (deps.taskmasterRunner ?? runTaskmasterCanarySuite)({
      dbPath,
      statusUrl,
      githubRepo,
      githubIssue,
      intervalMs,
      operatorToken: env.ARCHON_OPERATOR_TOKEN,
    });
    await (deps.taskmasterArtifactWriter ?? writeTaskmasterCanaryArtifacts)(outputRoot, report);
    deps.stdout(JSON.stringify(report, null, 2));
    return exitFor(report.verdict);
  }
  const level = command === 'check' ? 0 : command === 'plan' ? 1 : null;
  if (level === null) {
    deps.stderr('Usage: archon-canary <check|plan|taskmaster|mechanisms> [options]');
    return 3;
  }
  const manifestPath = flag(args, '--manifest');
  const apiBase = flag(args, '--api-base');
  const codebaseId = flag(args, '--codebase-id');
  const outputRoot = flag(args, '--output-root');
  if (!manifestPath || !apiBase || !codebaseId || !outputRoot) {
    deps.stderr('canary_cli_missing_required_argument');
    return 3;
  }
  const tokenFile = flag(args, '--token-file');
  const token = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : env.ARCHON_OPERATOR_TOKEN;
  if (!token) {
    deps.stderr('ARCHON_OPERATOR_TOKEN is required (or use --token-file)');
    return 3;
  }
  try {
    const result = await deps.runner({
      level,
      manifestPath,
      apiBase,
      token,
      outputRoot,
      codebaseId,
    });
    if (args.includes('--json')) deps.stdout(JSON.stringify(result.report, null, 2));
    else deps.stdout(`${result.report.verdict}: ${result.report.suiteRunId}`);
    return exitFor(result.report.verdict);
  } catch (error) {
    deps.stderr((error as Error).message.replaceAll(token, '[REDACTED]'));
    return 4;
  }
}

if (import.meta.main) process.exitCode = await runCanaryCli(Bun.argv.slice(2));
