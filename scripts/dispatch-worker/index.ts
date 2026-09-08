import { mkdir, mkdtemp, stat, writeFile } from 'fs/promises';
import { tmpdir, hostname, homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { spawn } from 'bun';
import { createHash } from 'crypto';
import { isBoardAliasMessage, renderBoardMotionPrompt } from './board-motion';
import {
  ACP_DEFAULT_IDLE_TIMEOUT_MS,
  ACP_DEFAULT_KILL_GRACE_MS,
  ACP_DEFAULT_WALL_CLOCK_MS,
  MAX_PROMPT_STDIN_BYTES,
  PROMPT_FILE_PLACEHOLDER,
  buildAgentInvocation,
  defaultAgentConfigs,
  parseFusionReviewBody,
  restrictAgentsToAllowlist,
  type AgentConfig,
} from './adapters';
import { createCancelController, runAcpAgent, type AcpRunResult } from './acp/session';
import { createMcpCancelController, runMcpAgent, type McpRunResult } from './mcp/session';
import { resolveOperatorToken } from './credentials';
import { realSeatPreflightDeps, runSeatPreflight, type SeatConfig } from './seat-preflight';
import { acquireInstanceLock, type InstanceLockHandle } from './instance-lock';
import { createWorkerLog, type WorkerLog } from './worker-log';
import { enumerateProcessTree, killProcessTree, waitForTreeDeath } from './acp/kill-tree';

type DispatchTaskType =
  | 'agent_message'
  | 'run_review'
  | 'draft_spec'
  | 'run_report'
  | 'board_motion';
type DispatchStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';

interface DispatchMessage {
  id: string;
  task_type: DispatchTaskType;
  sender: string;
  recipient: string;
  body: string;
  status: DispatchStatus;
  fencing_token: number;
  recipient_alias?: 'board' | null;
  resolved_recipient?: string | null;
}

type DispatchTaskOutcome = 'succeeded' | 'failed' | 'blocked';

export function classifyDispatchOutcome(
  exitCode: number,
  output: string,
  refusal = false
): {
  resultBody: string;
  status: 'done' | 'failed';
  taskOutcome: DispatchTaskOutcome | null;
} {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  while (lines.at(-1) === '') lines.pop();
  const sentinel = /^DISPATCH_OUTCOME: (blocked|failed)$/.exec(lines.at(-1) ?? '');
  if (sentinel) lines.pop();
  const resultBody = lines.join('\n').trim();
  if (exitCode !== 0) return { resultBody, status: 'failed', taskOutcome: 'failed' };
  if (refusal || sentinel?.[1] === 'blocked')
    return { resultBody, status: 'failed', taskOutcome: 'blocked' };
  if (sentinel?.[1] === 'failed') return { resultBody, status: 'failed', taskOutcome: 'failed' };
  return { resultBody, status: 'done', taskOutcome: resultBody ? 'succeeded' : null };
}

function encodeForHash(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

export function summarizeTranscriptPayload(value: unknown): {
  sha256: string;
  utf8Bytes: number;
  preview: string;
} {
  const text = encodeForHash(value);
  const bytes = Buffer.from(text, 'utf8');
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    utf8Bytes: bytes.length,
    preview: '[redacted]',
  };
}

export const REPLY_TEXT_CAP_BYTES = 65_536;

export function summarizePersistedOutcome(
  classification: DispatchTaskOutcome | null,
  value: unknown,
  options: {
    persistText?: boolean;
    cap?: number;
    localTranscriptPath?: string;
  } = {}
): string {
  const summary = summarizeTranscriptPayload(value);
  if (options.persistText) {
    const encoded = encodeForHash(value);
    if (summary.utf8Bytes <= (options.cap ?? REPLY_TEXT_CAP_BYTES)) {
      return JSON.stringify({
        classification,
        sha256: summary.sha256,
        utf8Bytes: summary.utf8Bytes,
        text: encoded,
      });
    }
    return JSON.stringify({
      classification,
      sha256: summary.sha256,
      utf8Bytes: summary.utf8Bytes,
      text: null,
      local_transcript_path: options.localTranscriptPath ?? null,
    });
  }
  return JSON.stringify({
    classification,
    sha256: summary.sha256,
    utf8Bytes: summary.utf8Bytes,
    preview: summary.preview,
  });
}

interface BoardDeliveryConfig {
  enabled: boolean;
  credential_id: string;
  token_env: string;
  allowed_principals: string[];
}

interface WorkerConfig {
  worker_id?: string;
  host?: string;
  server_url: string;
  operator_token_env?: string;
  operator_token_file?: string;
  poll_interval_ms?: number;
  heartbeat_interval_ms?: number;
  lease_duration_ms?: number;
  /** How often to extend the lease while an agent leg is running. */
  lease_renew_interval_ms?: number;
  persist_reply_text?: boolean;
  capabilities?: Record<string, unknown>;
  max_concurrency?: Record<string, number>;
  board_delivery?: {
    enabled?: boolean;
    credential_id?: string;
    token_env?: string;
    allowed_principals?: string[];
  };
  agents?: Record<string, AgentConfig>;
  /**
   * M-131 Phase A: when present, this worker is an isolated single-provider
   * server seat. Advertisement, polling, and claiming are gated on seat
   * preflight, and the agent registry is restricted to the allowlist.
   */
  seat?: SeatConfig | null;
}

type NormalizedWorkerConfig = Required<
  Omit<WorkerConfig, 'board_delivery' | 'operator_token_file' | 'agents' | 'seat'>
> & {
  operator_token_file: string;
  agents: Record<string, AgentConfig>;
  board_delivery: BoardDeliveryConfig;
  seat: SeatConfig | null;
};

interface WorkerState {
  stopping: boolean;
  activeByAgent: Map<string, number>;
}

function defaultLockFile(workerId: string): string {
  return join(homedir(), '.config', 'bdc', `dispatch-worker-${workerId}.lock`);
}

function defaultLogFile(workerId: string): string {
  return join(homedir(), '.config', 'bdc', 'logs', `dispatch-worker-${workerId}.log`);
}

function parseArgs(): string {
  const index = process.argv.indexOf('--config');
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error('Usage: bun run scripts/dispatch-worker/index.ts --config <path>');
  }
  return process.argv[index + 1];
}

export async function readConfig(path: string): Promise<NormalizedWorkerConfig> {
  const raw = await Bun.file(path).text();
  const parsed = JSON.parse(raw) as WorkerConfig;
  if (!parsed.server_url) throw new Error('config.server_url is required');
  let agents = { ...defaultAgentConfigs, ...(parsed.agents ?? {}) };
  let capabilities = parsed.capabilities ?? { providers: Object.keys(agents) };
  if (parsed.seat) {
    // A seat worker is single-provider: restrict the registry to the
    // allowlist and advertise only what the seat can honestly run.
    const allowlist = parsed.seat.provider_allowlist ?? [];
    agents = restrictAgentsToAllowlist(agents, allowlist);
    capabilities = { providers: allowlist, seat_id: parsed.seat.seat_id };
  }

  return {
    worker_id: parsed.worker_id ?? `dispatch-worker-${hostname()}`,
    host: parsed.host ?? hostname(),
    server_url: parsed.server_url.replace(/\/+$/, ''),
    operator_token_env: parsed.operator_token_env ?? 'ARCHON_OPERATOR_TOKEN',
    operator_token_file:
      parsed.operator_token_file ?? join(homedir(), '.config', 'bdc', 'archon-operator-token'),
    poll_interval_ms: parsed.poll_interval_ms ?? 5_000,
    heartbeat_interval_ms: parsed.heartbeat_interval_ms ?? 30_000,
    lease_duration_ms: parsed.lease_duration_ms ?? 300_000,
    // Renew at ~1/3 of the lease so two consecutive failures still leave time
    // to react before the lease actually lapses.
    lease_renew_interval_ms:
      parsed.lease_renew_interval_ms ?? Math.max(10_000, (parsed.lease_duration_ms ?? 300_000) / 3),
    persist_reply_text: parsed.persist_reply_text ?? true,
    capabilities,
    max_concurrency: parsed.max_concurrency ?? {},
    board_delivery: {
      enabled: parsed.board_delivery?.enabled ?? false,
      credential_id: parsed.board_delivery?.credential_id ?? '',
      token_env: parsed.board_delivery?.token_env ?? 'DISPATCH_WORKER_TOKEN',
      allowed_principals: parsed.board_delivery?.allowed_principals ?? [],
    },
    agents,
    seat: parsed.seat ?? null,
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-archon-operator-token': token,
  };
}

async function requestJson<T>(
  config: NormalizedWorkerConfig,
  token: string,
  path: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
): Promise<T> {
  const response = await fetch(`${config.server_url}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${path}: ${text}`);
  }
  return (await response.json()) as T;
}

async function register(config: NormalizedWorkerConfig, token: string): Promise<void> {
  await requestJson(config, token, '/api/dispatch/workers/register', {
    method: 'POST',
    body: JSON.stringify({
      worker_id: config.worker_id,
      host: config.host,
      capabilities: config.capabilities,
      max_concurrency: Object.values(config.max_concurrency).reduce(
        (max, value) => Math.max(max, value),
        1
      ),
    }),
  });
}

async function heartbeat(config: NormalizedWorkerConfig, token: string): Promise<void> {
  await requestJson(config, token, '/api/dispatch/workers/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ worker_id: config.worker_id }),
  });
}

function promptFor(message: DispatchMessage): string {
  switch (message.task_type) {
    case 'agent_message':
      return message.body;
    case 'run_review':
      return `Review request from ${message.sender}:\n\n${message.body}`;
    case 'draft_spec':
      return `Draft a specification from this request by ${message.sender}:\n\n${message.body}`;
    case 'run_report':
      return `Prepare a concise report for ${message.sender}:\n\n${message.body}`;
    case 'board_motion':
      return renderBoardMotionPrompt(message.body);
  }
}

export async function writeTranscript(data: Record<string, unknown>): Promise<string> {
  const dir = join(import.meta.dir, 'transcripts');
  await mkdir(dir, { recursive: true });
  const messageId = (data.message as DispatchMessage | undefined)?.id ?? 'unknown';
  const path = join(dir, `${Date.now()}-${messageId}.json`);
  const safe = Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (key === 'message') {
        const message = value as DispatchMessage;
        return [
          key,
          {
            id: message.id,
            task_type: message.task_type,
            sender: message.sender,
            recipient: message.recipient,
            body: summarizeTranscriptPayload(message.body),
          },
        ];
      }
      if (key === 'updates' && Array.isArray(value))
        return [
          key,
          {
            count: value.length,
            types: [
              ...new Set(
                value.map(item => {
                  if (typeof item !== 'object' || !item) return typeof item;
                  const type = (item as Record<string, unknown>).type;
                  return typeof type === 'string' ? type : 'unknown';
                })
              ),
            ],
          },
        ];
      if (key === 'stdoutText') return ['stdout_text', value];
      if (
        [
          'transport',
          'stopReason',
          'timedOut',
          'cancelled',
          'exitCode',
          'agentPid',
          'treeBeforeKill',
          'treeAfterKill',
        ].includes(key)
      )
        return [key, value];
      return [key, summarizeTranscriptPayload(value)];
    })
  );
  await writeFile(path, JSON.stringify(safe, null, 2), 'utf8');
  return path;
}

/**
 * Runs one ACP agent leg and converts its result into a dispatch outcome.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 / M-118 order 4. Honest completion is
 * enforced here: `runAcpAgent` only reports ok=true for stopReason 'end_turn'
 * WITH non-empty output, so a clean-but-empty exit, a timeout, or a
 * cancellation all land as 'failed' with the reason stated in the result body
 * rather than being reported as completed work.
 */
export interface ResolvedAgentCwd {
  /** The directory the agent process will actually run in. */
  cwd: string;
  /** How that directory was chosen. */
  source: 'configured' | 'temp';
  /** Set when a configured cwd was rejected; the reason belongs in the log. */
  warning?: string;
}

/**
 * Decide the working directory for one dispatch leg.
 *
 * John's directive 2026-09-08: board seats must get context. A seat with
 * `cwd` pointing at a real checkout runs there, so it can read the repo, the
 * wiki, and its skills instead of answering a ballot from an empty scratch
 * directory. Every other agent keeps the previous behaviour -- a fresh
 * mkdtemp scratch per dispatch.
 *
 * Safety: the configured directory is only ever entered, never created,
 * written to, or removed by the worker. A configured path that is missing or
 * is not a directory falls back to mkdtemp with a warning rather than failing
 * the dispatch, so a moved worktree degrades to today's behaviour instead of
 * taking a seat offline.
 */
export async function resolveAgentCwd(
  agentConfig: AgentConfig,
  tempPrefix: string
): Promise<ResolvedAgentCwd> {
  const configured = agentConfig.cwd?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      return {
        cwd: await mkdtemp(join(tmpdir(), tempPrefix)),
        source: 'temp',
        warning: `configured cwd is not an absolute path: ${configured}`,
      };
    }
    let isDirectory = false;
    try {
      isDirectory = (await stat(configured)).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) return { cwd: configured, source: 'configured' };
    return {
      cwd: await mkdtemp(join(tmpdir(), tempPrefix)),
      source: 'temp',
      warning: `configured cwd does not exist or is not a directory: ${configured}`,
    };
  }
  return { cwd: await mkdtemp(join(tmpdir(), tempPrefix)), source: 'temp' };
}

/**
 * One log line per run naming the effective cwd, so a seat answering with no
 * context is diagnosable from the worker log alone.
 */
function reportAgentCwd(
  resolved: ResolvedAgentCwd,
  transport: 'acp' | 'mcp' | 'cli',
  message: DispatchMessage,
  log?: WorkerLog
): void {
  const line = `${transport} leg for ${message.recipient} (${message.id}) cwd=${resolved.cwd} source=${resolved.source}`;
  if (resolved.warning) {
    const warned = `${line} WARNING ${resolved.warning}`;
    if (log) void log.error(warned);
    else console.error(warned);
    return;
  }
  if (log) void log.info(line);
  else console.error(line);
}

async function runAcpLeg(
  agentConfig: AgentConfig,
  message: DispatchMessage,
  cancel: ReturnType<typeof createCancelController>,
  persistReplyText = false,
  replyTextCapBytes = REPLY_TEXT_CAP_BYTES,
  log?: WorkerLog
): Promise<{
  resultBody: string;
  status: 'done' | 'failed';
  taskOutcome: DispatchTaskOutcome | null;
  run: AcpRunResult;
}> {
  const resolvedCwd = await resolveAgentCwd(agentConfig, `bdc-dispatch-acp-${message.recipient}-`);
  reportAgentCwd(resolvedCwd, 'acp', message, log);
  const cwd = resolvedCwd.cwd;
  const run = await runAcpAgent(
    {
      command: agentConfig.command,
      args: agentConfig.args,
      cwd,
      ...(agentConfig.env ? { env: agentConfig.env } : {}),
      ...(agentConfig.acp?.authMethodId !== undefined
        ? { authMethodId: agentConfig.acp.authMethodId }
        : {}),
      idleTimeoutMs: agentConfig.acp?.idleTimeoutMs ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
      wallClockMs: agentConfig.acp?.wallClockMs ?? ACP_DEFAULT_WALL_CLOCK_MS,
      killGraceMs: agentConfig.acp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
    },
    promptFor(message),
    cancel
  );

  const transcriptPath = await writeTranscript({
    message,
    transport: 'acp',
    command: agentConfig.command,
    args: agentConfig.args,
    cwd,
    stopReason: run.stopReason,
    timedOut: run.timedOut,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    agentPid: run.agentPid,
    treeBeforeKill: run.treeBeforeKill,
    treeAfterKill: run.treeAfterKill,
    durationMs: run.durationMs,
    error: run.error ?? null,
    finalText: run.finalText,
    stdoutText:
      message.task_type === 'agent_message' && persistReplyText ? run.finalText : undefined,
    updates: run.updates,
  });

  const summary = run.ok
    ? run.finalText.trim()
    : [
        'ACP leg did not complete honestly.',
        `stopReason=${run.stopReason ?? 'none'}`,
        run.timedOut ? `timeout=${run.timedOut}` : '',
        run.cancelled ? 'cancelled=true' : '',
        run.error ? `error=${run.error}` : '',
        run.treeAfterKill.length > 0
          ? `WARNING descendants survived kill: ${run.treeAfterKill.join(',')}`
          : '',
        run.finalText.trim() ? `partial output:\n${run.finalText.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n');

  const refusal = run.stopReason === 'refusal';
  const classified = classifyDispatchOutcome(
    refusal ? 0 : run.ok ? (run.exitCode ?? 0) : 1,
    summary,
    refusal
  );
  return {
    resultBody: summarizePersistedOutcome(classified.taskOutcome, classified.resultBody, {
      persistText: message.task_type === 'agent_message' && persistReplyText,
      cap: replyTextCapBytes,
      localTranscriptPath: transcriptPath,
    }),
    status: classified.status,
    taskOutcome: classified.taskOutcome,
    run,
  };
}

async function runMcpLeg(
  agentConfig: AgentConfig,
  message: DispatchMessage,
  cancel: ReturnType<typeof createMcpCancelController>,
  persistReplyText = false,
  replyTextCapBytes = REPLY_TEXT_CAP_BYTES,
  log?: WorkerLog
): Promise<{
  resultBody: string;
  status: 'done' | 'failed';
  taskOutcome: DispatchTaskOutcome | null;
  run: McpRunResult;
}> {
  const resolvedCwd = await resolveAgentCwd(agentConfig, `bdc-dispatch-mcp-${message.recipient}-`);
  reportAgentCwd(resolvedCwd, 'mcp', message, log);
  const cwd = resolvedCwd.cwd;
  const run = await runMcpAgent(
    {
      command: agentConfig.command,
      args: agentConfig.args,
      cwd,
      ...(agentConfig.env ? { env: agentConfig.env } : {}),
      idleTimeoutMs: agentConfig.mcp?.idleTimeoutMs ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
      wallClockMs: agentConfig.mcp?.wallClockMs ?? ACP_DEFAULT_WALL_CLOCK_MS,
      killGraceMs: agentConfig.mcp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
      ...(agentConfig.mcp?.toolName ? { toolName: agentConfig.mcp.toolName } : {}),
    },
    promptFor(message),
    cancel
  );
  const transcriptPath = await writeTranscript({
    message,
    transport: 'mcp',
    command: agentConfig.command,
    args: agentConfig.args,
    cwd,
    stopReason: run.stopReason,
    timedOut: run.timedOut,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    agentPid: run.agentPid,
    treeBeforeKill: run.treeBeforeKill,
    treeAfterKill: run.treeAfterKill,
    durationMs: run.durationMs,
    error: run.error ?? null,
    finalText: run.finalText,
    stdoutText:
      message.task_type === 'agent_message' && persistReplyText ? run.finalText : undefined,
    updates: run.updates,
  });
  const summary = run.ok
    ? run.finalText.trim()
    : [
        'MCP leg did not complete honestly.',
        run.timedOut ? `timeout=${run.timedOut}` : '',
        run.cancelled ? 'cancelled=true' : '',
        run.error ? `error=${run.error}` : '',
        run.treeAfterKill.length > 0
          ? `WARNING descendants survived kill: ${run.treeAfterKill.join(',')}`
          : '',
        run.finalText.trim() ? `partial output:\n${run.finalText.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n');
  const refusal = run.stopReason === 'refusal';
  const classified = classifyDispatchOutcome(
    refusal ? 0 : run.ok ? (run.exitCode ?? 0) : 1,
    summary,
    refusal
  );
  return {
    resultBody: summarizePersistedOutcome(classified.taskOutcome, classified.resultBody, {
      persistText: message.task_type === 'agent_message' && persistReplyText,
      cap: replyTextCapBytes,
      localTranscriptPath: transcriptPath,
    }),
    status: classified.status,
    taskOutcome: classified.taskOutcome,
    run,
  };
}

export async function runAgent(
  config: AgentConfig,
  message: DispatchMessage,
  cancel?: ReturnType<typeof createCancelController>,
  persistReplyText = false,
  replyTextCapBytes = REPLY_TEXT_CAP_BYTES,
  log?: WorkerLog
): Promise<{
  resultBody: string;
  status: 'done' | 'failed';
  taskOutcome: DispatchTaskOutcome | null;
}> {
  const tempPrefix = `bdc-dispatch-${message.recipient}-`;
  const resolvedCwd = await resolveAgentCwd(config, tempPrefix);
  reportAgentCwd(resolvedCwd, 'cli', message, log);
  const cwd = resolvedCwd.cwd;
  let command = config.command;
  let args: string[];
  let promptBody: string | undefined;
  if (config.kind === 'fusion') {
    if (message.task_type !== 'run_review') throw new Error('fusion_review_task_type_required');
    const review = parseFusionReviewBody(message.body);
    const fusionCli = resolve(import.meta.dir, '..', '..', 'packages', 'fusion', 'src', 'cli.ts');
    args = [
      'run',
      fusionCli,
      'review',
      '--wo',
      review.wo,
      '--diff',
      review.diff,
      '--tests',
      review.tests,
      '--manifest',
      review.manifest,
      ...(review.ci ? ['--ci'] : []),
    ];
  } else {
    promptBody = promptFor(message);
    const promptBytes = Buffer.byteLength(promptBody, 'utf8');
    if (promptBytes > MAX_PROMPT_STDIN_BYTES) {
      return {
        status: 'failed',
        taskOutcome: 'failed',
        resultBody: `Prompt payload is ${promptBytes} UTF-8 bytes; limit is ${MAX_PROMPT_STDIN_BYTES} bytes.`,
      };
    }
    const invocation = buildAgentInvocation(config, promptBody);
    command = invocation.command;
    args = invocation.args;
  }
  const usesPromptFile =
    config.kind !== 'fusion' && config.promptDelivery === 'prompt-file' && promptBody !== undefined;
  if (usesPromptFile && promptBody !== undefined) {
    // The prompt file is worker-owned scratch and must NEVER be written into a
    // configured cwd -- that would drop an untracked file into a real
    // checkout. When cwd came from config, take a separate temp directory for
    // it; when cwd is already a per-run temp dir, reuse it as before.
    const promptDir =
      resolvedCwd.source === 'configured' ? await mkdtemp(join(tmpdir(), tempPrefix)) : cwd;
    const promptFilePath = join(promptDir, 'dispatch-prompt.txt');
    await writeFile(promptFilePath, promptBody, 'utf8');
    args = args.map(arg => (arg === PROMPT_FILE_PLACEHOLDER ? promptFilePath : arg));
  }
  const proc = spawn({
    cmd: [command, ...args],
    cwd,
    ...(config.env ? { env: { ...process.env, ...config.env } } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: config.kind === 'fusion' || usesPromptFile ? 'ignore' : 'pipe',
  });
  let treeBeforeKill: number[] = [];
  let treeAfterKill: number[] = [];
  let cancellationStarted = false;
  let cancellationPromise: Promise<void> | undefined;
  const beginCancellation = (): Promise<void> => {
    if (cancellationPromise) return cancellationPromise;
    cancellationStarted = true;
    cancellationPromise = (async (): Promise<void> => {
      const tree = await enumerateProcessTree(proc.pid);
      treeBeforeKill = tree.map(node => node.pid);
      await killProcessTree(proc.pid);
      treeAfterKill = await waitForTreeDeath(treeBeforeKill, ACP_DEFAULT_KILL_GRACE_MS);
    })();
    return cancellationPromise;
  };
  const cancelTimer = setInterval(() => {
    if (cancel?.cancelled) void beginCancellation();
  }, 50);
  cancelTimer.unref?.();
  if (promptBody !== undefined && !usesPromptFile) {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('prompt_stdin_pipe_unavailable');
    try {
      stdin.write(promptBody);
      await stdin.end();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        taskOutcome: 'failed',
        resultBody: summarizePersistedOutcome('failed', detail),
      };
    }
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearInterval(cancelTimer);
  });
  // The process can exit between polling ticks. Re-read the synchronous
  // controller state and await the entire kill/verification operation before
  // classifying or posting a result.
  if (cancel?.cancelled) await beginCancellation();
  else if (cancellationPromise) await cancellationPromise;
  const transcriptPath = await writeTranscript({
    message,
    command,
    args,
    cwd,
    stdout,
    stdoutText: message.task_type === 'agent_message' && persistReplyText ? stdout : undefined,
    stderr,
    exitCode,
    cancelled: cancellationStarted,
    treeBeforeKill,
    treeAfterKill,
  });
  const classified = cancellationStarted
    ? {
        resultBody: `CLI leg cancelled; survivors=${treeAfterKill.join(',') || 'none'}`,
        status: 'failed' as const,
        taskOutcome: 'failed' as const,
      }
    : classifyDispatchOutcome(exitCode, stdout.trim() || stderr.trim());
  return {
    resultBody: summarizePersistedOutcome(classified.taskOutcome, classified.resultBody, {
      persistText: message.task_type === 'agent_message' && persistReplyText,
      cap: replyTextCapBytes,
      localTranscriptPath: transcriptPath,
    }),
    status: classified.status,
    taskOutcome: classified.taskOutcome,
  };
}

async function processMessage(
  config: NormalizedWorkerConfig,
  token: string,
  state: WorkerState,
  queued: DispatchMessage,
  log: WorkerLog,
  deliveryPrincipal?: string
): Promise<void> {
  const agent = deliveryPrincipal ?? queued.resolved_recipient ?? queued.recipient;
  const active = state.activeByAgent.get(agent) ?? 0;
  const cap = config.max_concurrency[agent] ?? 1;
  if (active >= cap) return;
  const agentConfig = config.agents[agent];
  if (!agentConfig) return;

  state.activeByAgent.set(agent, active + 1);
  try {
    const boardHeaders = isBoardAliasMessage(queued) ? boardDeliveryHeaders(config, agent) : {};
    const claimed = await requestJson<DispatchMessage>(
      config,
      token,
      `/api/dispatch/messages/${queued.id}/claim`,
      {
        method: 'POST',
        headers: boardHeaders,
        body: JSON.stringify({
          worker_id: config.worker_id,
          ...(isBoardAliasMessage(queued) ? { delivery_principal: agent } : {}),
          lease_duration_ms: config.lease_duration_ms,
        }),
      }
    );

    // M-118 order 4: renew the lease while the agent leg runs. A cancelled or
    // stolen message stops renewing and signals the ACP leg to stand down, so
    // an operator `cancel` reaches a live agent instead of being discovered
    // only at result time.
    const cancel = createCancelController();
    const renewTimer = setInterval(() => {
      void requestJson(config, token, `/api/dispatch/messages/${claimed.id}/renew-lease`, {
        method: 'POST',
        body: JSON.stringify({
          worker_id: config.worker_id,
          fencing_token: claimed.fencing_token,
          lease_duration_ms: config.lease_duration_ms,
        }),
      }).catch(error => {
        cancel.cancel();
        void log.error(`lease renewal failed for ${claimed.id}; cancelling leg`, error);
      });
    }, config.lease_renew_interval_ms);
    renewTimer.unref?.();

    let result: {
      resultBody: string;
      status: 'done' | 'failed';
      taskOutcome?: DispatchTaskOutcome | null;
    };
    try {
      result =
        agentConfig.kind === 'acp'
          ? await runAcpLeg(
              agentConfig,
              claimed,
              cancel,
              config.persist_reply_text,
              REPLY_TEXT_CAP_BYTES,
              log
            )
          : agentConfig.kind === 'mcp'
            ? await runMcpLeg(
                agentConfig,
                claimed,
                cancel,
                config.persist_reply_text,
                REPLY_TEXT_CAP_BYTES,
                log
              )
            : await runAgent(
                agentConfig,
                claimed,
                cancel,
                config.persist_reply_text,
                REPLY_TEXT_CAP_BYTES,
                log
              );
    } finally {
      clearInterval(renewTimer);
    }

    await requestJson(config, token, `/api/dispatch/messages/${claimed.id}/result`, {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.worker_id,
        fencing_token: claimed.fencing_token,
        result_body: result.resultBody,
        status: result.status,
        task_outcome: result.taskOutcome,
      }),
    });
  } catch (error) {
    await log.error(`dispatch-worker failed message ${queued.id}`, error);
  } finally {
    state.activeByAgent.set(agent, Math.max(0, (state.activeByAgent.get(agent) ?? 1) - 1));
  }
}

async function poll(
  config: NormalizedWorkerConfig,
  token: string,
  state: WorkerState,
  log: WorkerLog
): Promise<void> {
  for (const recipient of Object.keys(config.agents)) {
    const headers = config.board_delivery.allowed_principals.includes(recipient)
      ? boardDeliveryHeaders(config, recipient)
      : {};
    const messages = await requestJson<DispatchMessage[]>(
      config,
      token,
      `/api/dispatch/messages?recipient=${encodeURIComponent(recipient)}&status=queued`,
      { headers }
    );
    for (const message of messages) {
      if (state.stopping) return;
      void processMessage(config, token, state, message, log, recipient);
    }
  }
}

function boardDeliveryHeaders(
  config: NormalizedWorkerConfig,
  deliveryPrincipal: string
): Record<string, string> {
  if (
    !config.board_delivery.enabled ||
    !config.board_delivery.credential_id ||
    !config.board_delivery.allowed_principals.includes(deliveryPrincipal)
  ) {
    return {};
  }
  const token = process.env[config.board_delivery.token_env];
  if (!token) return {};
  return {
    'x-dispatch-worker-id': config.worker_id,
    'x-dispatch-worker-credential-id': config.board_delivery.credential_id,
    'x-dispatch-worker-token': token,
  };
}

async function main(): Promise<void> {
  const config = await readConfig(parseArgs());
  const log = createWorkerLog({ file: defaultLogFile(config.worker_id) });

  let lock: InstanceLockHandle;
  try {
    lock = await acquireInstanceLock({ lockFile: defaultLockFile(config.worker_id) });
  } catch (error) {
    await log.error('startup refused: another instance appears to be running', error);
    console.error(String(error));
    process.exit(1);
    return;
  }
  await log.info(`startup: acquired instance lock for worker_id=${config.worker_id}`);

  // M-131 Phase A: a seat worker must pass deterministic preflight before it
  // advertises, polls, or claims. Failure is typed and sanitized (code +
  // field only, never a path value or credential) and the worker exits
  // without registering.
  if (config.seat) {
    const commands = Object.fromEntries(
      Object.entries(config.agents).map(([name, agent]) => [name, agent.command])
    );
    const preflight = await runSeatPreflight(config.seat, commands, realSeatPreflightDeps());
    if (!preflight.ok) {
      const detail = `seat preflight failed: ${preflight.code} field=${preflight.field}`;
      await log.error(detail, new Error(preflight.code));
      console.error(detail);
      await lock.release();
      process.exit(1);
      return;
    }
    config.capabilities = {
      ...config.capabilities,
      seat_id: preflight.seatId,
      providers: preflight.providers,
      build_sha: preflight.buildSha,
    };
    await log.info(
      `seat preflight ok: seat_id=${preflight.seatId} providers=${preflight.providers.join(',')} build_sha=${preflight.buildSha}`
    );
  }

  const token = await resolveOperatorToken({
    envName: config.operator_token_env,
    tokenFile: config.operator_token_file,
  });
  const state: WorkerState = { stopping: false, activeByAgent: new Map() };

  const stop = (): void => {
    state.stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await register(config, token);
  await log.info('registered with drop-box server');
  const heartbeatTimer = setInterval(() => {
    if (!state.stopping)
      void heartbeat(config, token).catch(error => {
        void log.error('heartbeat failed', error);
      });
  }, config.heartbeat_interval_ms);
  heartbeatTimer.unref?.();

  try {
    while (!state.stopping) {
      await poll(config, token, state, log).catch(error => {
        void log.error('poll failed', error);
      });
      await Bun.sleep(config.poll_interval_ms);
    }
  } finally {
    clearInterval(heartbeatTimer);
    await log.info('shutting down: releasing instance lock');
    await lock.release();
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
