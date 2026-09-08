export type AgentKind = 'prompt' | 'fusion' | 'acp' | 'mcp';

/**
 * How the prompt body reaches a 'prompt'-kind CLI.
 *
 * 'stdin' (default): the CLI reads the prompt from stdin when no inline
 * prompt argument is given (claude -p, codex exec, cursor-agent --print).
 *
 * 'prompt-file': the CLI has no stdin-prompt mode and requires the prompt
 * as a file path argument (grok's `-p/--single <PROMPT>` is argv-only; its
 * `--prompt-file <PATH>` flag is the documented equivalent). When set,
 * PROMPT_FILE_PLACEHOLDER in `args` is replaced with a real temp file path
 * containing the prompt body, written before spawn, and nothing is piped
 * to stdin.
 */
export type PromptDelivery = 'stdin' | 'prompt-file';
export const PROMPT_FILE_PLACEHOLDER = '__DISPATCH_PROMPT_FILE__';

export interface AgentConfig {
  kind?: AgentKind;
  command: string;
  args: string[];
  /** Defaults to 'stdin'. Set to 'prompt-file' for CLIs with no stdin prompt mode. */
  promptDelivery?: PromptDelivery;
  /**
   * Absolute directory the agent process runs in. When unset (the default) the
   * worker creates a fresh mkdtemp scratch directory per dispatch, which is
   * what an agent that needs no repo context should get.
   *
   * John's directive 2026-09-08: a board seat answering a ballot in an empty
   * temp dir has no repo, no wiki, and no skills, so it reports "Oracle
   * unavailable / skill read blocked" every round. Pointing a seat at a real
   * checkout gives it the context the board packet assumes it has.
   *
   * The worker NEVER writes into or deletes a configured cwd -- the prompt
   * file still goes to a per-run temp directory. If the configured path does
   * not exist, the worker warns and falls back to mkdtemp rather than failing
   * the dispatch.
   */
  cwd?: string;
  /**
   * Extra environment variables merged over the worker's own environment for
   * this agent's child process (e.g. ORACLE_URL, or a read-only token issued
   * to one seat). Values are passed through unchanged; secrets belong in the
   * worker's environment or a token file, never in a git-tracked config.
   */
  env?: Record<string, string>;
  /**
   * ACP-only (kind: 'acp'), all optional with safe defaults.
   *
   * WO-HARNESS-ACP-DISPATCH-SLICE-01 / M-118: an ACP agent is spawned once per
   * dispatch message and driven over a live stdio session instead of a
   * one-shot CLI call. The `prompt` kind remains the compatibility fallback
   * the ruling requires us to keep (order 5).
   */
  acp?: {
    /** authMethodId sent in `authenticate`; omit to skip the call entirely. */
    authMethodId?: string;
    /** No session/update for this long -> cancel. */
    idleTimeoutMs?: number;
    /** Total run longer than this -> cancel. */
    wallClockMs?: number;
    /** Grace between session/cancel and the process-tree kill. */
    killGraceMs?: number;
  };
  /** MCP-only (kind: 'mcp'), all optional with the ACP reliability defaults. */
  mcp?: {
    idleTimeoutMs?: number;
    wallClockMs?: number;
    killGraceMs?: number;
    toolName?: string;
  };
}

export const ACP_DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const ACP_DEFAULT_WALL_CLOCK_MS = 1_800_000;
export const ACP_DEFAULT_KILL_GRACE_MS = 5_000;
export const MAX_PROMPT_STDIN_BYTES = 1_048_576;

export interface FusionReviewRequest {
  wo: string;
  diff: string;
  tests: string;
  manifest: string;
  ci?: boolean;
}

/**
 * Grok model id as exposed by Cursor. Verified live 2026-08-26 against
 * `cursor-agent --list-models` on the target host. Overridable by env because
 * Cursor's roster moves (Grok 4.3 -> 4.5 -> 4.6 inside two months); a moved id
 * must be a config change, not a code change.
 */
export const CURSOR_GROK_MODEL = process.env.CURSOR_GROK_MODEL ?? 'cursor-grok-4.6-high-fast';

export const defaultAgentConfigs: Record<string, AgentConfig> = {
  claude: {
    command: 'claude',
    args: ['--permission-mode', 'plan', '-p'],
  },
  codex: {
    command: 'codex',
    args: [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
    ],
  },
  grok: {
    command: 'grok',
    // grok's `-p/--single <PROMPT>` is argv-only with no stdin-prompt mode
    // (confirmed via `grok --help`, 2026-08-11). Deliver via `--prompt-file`
    // instead; runAgent substitutes PROMPT_FILE_PLACEHOLDER with a real temp
    // file path written before spawn.
    args: ['--permission-mode', 'plan', '--no-subagents', '--prompt-file', PROMPT_FILE_PLACEHOLDER],
    promptDelivery: 'prompt-file',
  },
  cursor: {
    command: 'cursor-agent',
    args: ['--print', '--mode', 'ask', '--trust'],
  },
  /**
   * WO-HARNESS-CURSOR-BUILD-SEAT-01: build-capable cursor leg for the M-131
   * cursor seat. Distinct from the read-only `cursor` entry above, which
   * passes `--mode ask` and therefore CANNOT write files -- correct for a
   * judge/Q&A call, useless for a build seat.
   *
   * Flags verified live against cursor-agent 2026.08.11-e8db854 on the target
   * host (`cursor-agent --help`, 2026-08-26):
   *  - `--print` is the non-interactive mode and per its own help text "Has
   *    access to all tools, including write and shell". No `--mode` is passed:
   *    the only two choices are `plan` and `ask` and BOTH are read-only.
   *  - `--force` is required for the agent to run commands without prompting.
   *  - `--trust` suppresses the Workspace Trust prompt. Without it the CLI
   *    prints the trust notice and exits 0 with EMPTY output -- a silent
   *    no-op that reads as success. Verified live: the seat MUST also treat
   *    empty output as failure (see cursorBuildResultIsEmpty).
   */
  'cursor-build': {
    command: 'cursor-agent',
    args: ['--print', '--force', '--trust'],
  },
  /**
   * WO-HARNESS-CURSOR-BUILD-SEAT-01 (transport half): reach the GROK seat
   * container-side THROUGH cursor-agent.
   *
   * Why this exists (rationale corrected 2026-08-27): originally built as an
   * outage workaround when the xAI API was defunded (2026-08-26), which made
   * Cursor the only container-side path to the grok seat. John confirmed
   * 2026-08-27 that Grok usage is BACK, so that premise no longer holds.
   *
   * What it is now: a funded ALTERNATIVE route to the grok seat -- it runs on
   * the Cursor Ultra subscription rather than xAI credits (cost lever), and it
   * is a second path if xAI goes dark again (failover). The `grok` and
   * `grok-acp` adapters above still cover the direct paths; all three are
   * admitted under the grok family, so a separately-installed Grok builder
   * slots in alongside these without changing this entry.
   *
   * Model id verified live 2026-08-26 via `cursor-agent --list-models` on the
   * target host, then proven end-to-end in a scratch container:
   *   cursor-agent -f -p --model cursor-grok-4.6-high-fast "..." -> rc 0,
   *   non-empty response. The 2026-07-22 feasibility doc had listed the exact
   *   Grok model-id string as UNCONFIRMED; this resolves it.
   *
   * Same three CLI traps as cursor-build apply (no --mode: both choices are
   * read-only; --force to run commands; --trust or the CLI exits 0 with EMPTY
   * output). Empty output MUST be treated as failure -- see
   * cursorBuildResultIsEmpty in seat-preflight.ts.
   */
  'grok-via-cursor': {
    command: 'cursor-agent',
    args: ['--print', '--force', '--trust', '--model', CURSOR_GROK_MODEL],
  },
  fusion: {
    kind: 'fusion',
    command: 'bun',
    args: [],
  },
  /**
   * ACP seats (M-118 vertical slice). Registered alongside -- not instead of --
   * the CLI entries above, which remain the ruling-mandated fallback.
   *
   * grok-acp: proven live on this machine (grok 0.2.118, cached_token auth,
   * full initialize/authenticate/session-new/session-prompt handshake) per
   * M-20260802-118.acp-compatibility-proof.md.
   *
   * claude-acp: M-126 T1 rejected the third-party wrapper for the credential
   * lane. This dark seat uses the BDC-owned adapter and official Claude Agent
   * SDK; operator conformance still gates promotion.
   */
  'grok-acp': {
    kind: 'acp',
    command: 'grok',
    args: ['agent', 'stdio'],
    acp: { authMethodId: 'cached_token' },
  },
  'claude-acp': {
    kind: 'acp',
    command: 'bun',
    args: ['scripts/dispatch-worker/claude-acp/main.ts'],
    acp: {},
  },
  'codex-mcp': {
    kind: 'mcp',
    command: 'codex',
    args: ['mcp-server'],
    mcp: {},
  },
};

/**
 * M-131 Phase A: restricts an agent registry to a seat's provider allowlist
 * so an isolated seat can only advertise and run the providers it honestly
 * owns (Grok-only for bdc-seat-grok). Unknown allowlist entries are simply
 * absent from the result; seat preflight reports the typed error.
 */
export function restrictAgentsToAllowlist(
  agents: Record<string, AgentConfig>,
  allowlist: string[]
): Record<string, AgentConfig> {
  return Object.fromEntries(Object.entries(agents).filter(([name]) => allowlist.includes(name)));
}

export function buildAgentInvocation(
  config: AgentConfig,
  // Retained for call-site/test compatibility; no longer used for argv substitution.
  _prompt: string
): { command: string; args: string[] } {
  return {
    command: config.command,
    args: [...config.args],
  };
}

export function parseFusionReviewBody(body: string): FusionReviewRequest {
  try {
    const value = JSON.parse(body) as Partial<FusionReviewRequest>;
    if (
      !value ||
      typeof value.wo !== 'string' ||
      typeof value.diff !== 'string' ||
      typeof value.tests !== 'string' ||
      typeof value.manifest !== 'string'
    ) {
      throw new Error('invalid shape');
    }
    return {
      wo: value.wo,
      diff: value.diff,
      tests: value.tests,
      manifest: value.manifest,
      ...(value.ci === true ? { ci: true } : {}),
    };
  } catch {
    throw new Error('fusion_review_body_invalid');
  }
}
