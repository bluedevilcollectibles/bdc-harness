/**
 * Taskmaster Slice 1 loop (WO-HARNESS-TASKMASTER-SLICE1-01, M-133 CARRIED 3-0).
 *
 * Always-on deterministic loop that moves stalled work forward by sending
 * messages: delivering undelivered ratified rulings, nudging idle threads,
 * and escalating unclaimed P0s. All sends go through the dispatch DAL
 * (createAuthenticatedMessage) -- there is no second messaging path.
 *
 * Tick order (spec Section 8): pause state + epoch -> headroom -> reads ->
 * classify -> propose -> two-tick confirm -> guard -> journal ROW FIRST ->
 * epoch re-check -> createAuthenticatedMessage -> journal outcome + proof deadline.
 *
 * Budgets (ratified Q1): max 10 effects/tick, 1 effect/item/tick, max 3
 * automated interventions per item per 24h.
 */
import { createHash } from 'crypto';
import { createLogger } from '@archon/paths';
import { getDatabase } from '@archon/core';
import { runCascade } from '@archon/smart-cauldron/cascade';
import {
  createAuthenticatedMessage,
  getMessage,
  listMessages,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
  type DispatchSenderContext,
} from '@archon/core/db/dispatch';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import {
  adoptionContentHash,
  classifyThread,
  computeNextAction,
  isSuppressedByNoise,
  type ActionProposal,
  type ThreadSnapshot,
  type ThreadPriority,
  type TmActionType,
  usefulRateFloorBreached,
} from './rules';
import { validateProposal, type TmAllowedRecipient } from './guard';
import { checkFireEligibility, type FireEligibilityResult } from './fire-eligibility';
import { currentHeadroom, type HeadroomReading } from './ledger';
import { decideFireLane } from './lane-budget';
import { fireBackoffDecision } from './backoff';
import {
  createDeadmanState,
  recordTickAttempt,
  recordTickHeartbeat,
  tickHealth,
  type DeadmanState,
  type TickHealth,
} from './deadman';

const log = createLogger('taskmaster/loop');

/** Ratified Q1 budgets. */
export const MAX_EFFECTS_PER_TICK = 10;
/** Conservative faucet bound for newly eligible work, within the shared cap. */
export const MAX_FIRES_PER_TICK = 3;

/**
 * Pause effect-delivery gate (WO-HARNESS-TASKMASTER-PAUSE-GATE-ENFORCE-01).
 *
 * When the control row is paused with scope='effects', ZERO effects leave the
 * process -- nothing is exempt, including P0 escalations and the digest. A
 * pause with any non-'effects' scope keeps the legacy watching-never-dark
 * exemption for escalate_p0 and the digest. Callers must still check
 * pause_state !== 'RUNNING' before consulting this helper.
 */
export function isPauseEffectsExempt(proposalType: string, pauseScope: string | null): boolean {
  if (pauseScope === 'effects') return false;
  return proposalType === 'escalate_p0' || proposalType === 'digest';
}

/** Journal lookback used for dedupe and per-item budgets. */
const JOURNAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_DEADLINE_MS = 24 * 60 * 60 * 1000;

export interface TaskmasterState {
  deadman: DeadmanState;
  tickIndex: number;
  /** Two-tick confirmation ledger: proposal key -> {tickIndex, epoch}. */
  pendingConfirm: Map<string, { tickIndex: number; epoch: number }>;
  /** Restart reconciliation runs once per process. */
  reconciled: boolean;
  /** Last tick on which a budget hold was made visible. */
  lastHoldMonitorTick: number | null;
}

export function createTaskmasterState(intervalMs: number): TaskmasterState {
  return {
    deadman: createDeadmanState(intervalMs),
    tickIndex: 0,
    pendingConfirm: new Map(),
    reconciled: false,
    lastHoldMonitorTick: null,
  };
}

type TaskmasterDal = Pick<
  typeof taskmasterDb,
  | 'recordAction'
  | 'updateActionOutcome'
  | 'getActionsSince'
  | 'getPauseState'
  | 'setPauseState'
  | 'expireParkedActions'
  | 'gradeAction'
  | 'getActionByIdempotencyKey'
  | 'beginAdoptionSnapshot'
  | 'upsertAdoptionRow'
  | 'commitAdoptionSnapshot'
  | 'abandonAdoptionSnapshot'
  | 'getAdoption'
  | 'getAdoptionMeta'
> &
  // Suppression accessors (M-155 WO 3) are optional on injected DALs so
  // pre-WO3 test doubles keep compiling; when absent, durable suppression
  // writes are inert (the pure grade-based check still applies).
  Partial<Pick<typeof taskmasterDb, 'getSuppression' | 'setSuppression' | 'clearSuppression'>>;

export interface GithubIssueEvidence {
  state: 'open' | 'closed';
  updatedAt: string;
  labels: string[];
  assigneeCount: number;
  closedAt: string | null;
  assignedAt: string | null;
  activeStatusAt: string | null;
  progressRecordedAt: string | null;
  /** First assignee login; null when unassigned (UNKNOWN -- never guessed). */
  ownerLogin: string | null;
  latestMarkerKind: 'PROGRESS' | 'BLOCKED' | null;
  /** Marker comment body, trimmed, capped at 500 chars. */
  latestMarkerText: string | null;
  latestMarkerAt: string | null;
  lastMovementAt: string | null;
  lastMovementKind: 'closed' | 'assigned' | 'status_label' | 'progress_comment' | null;
}

export interface TaskmasterDeps {
  now?: () => Date;
  db?: TaskmasterDal;
  createTask?: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => ReturnType<typeof createAuthenticatedMessage>;
  listUndeliveredRulings?: () => Promise<ThreadSnapshot[]>;
  listThreads?: () => Promise<ThreadSnapshot[]>;
  headroom?: () => Promise<HeadroomReading>;
  /** External-SOR check: does a dispatch row exist for this key, and when was it sent? */
  findEffectByIdempotencyKey?: (
    key: string
  ) => Promise<{ id: string; status: string; createdAt: string } | null>;
  getDispatchMessageById?: (id: string) => Promise<DispatchMessage | null>;
  getGithubIssueEvidence?: (
    threadRef: string,
    sinceIso: string
  ) => Promise<GithubIssueEvidence | null>;
  checkFireEligibility?: (issueTitle: string) => Promise<FireEligibilityResult>;
  runCascade?: typeof runCascade;
  getFireRunEvidence?: (
    woId: string,
    cascadeId: string
  ) => Promise<{ status: string; prOpened?: boolean } | null>;
  getHealthSample?: typeof taskmasterDb.getHealthSample;
  /** Test/monitor observer invoked whenever the periodic budget-hold warning is emitted. */
  onFireBudgetHolding?: (tickIndex: number, reason: string) => void;
}

export interface TickResult {
  ran: boolean;
  successful: boolean;
  pauseState: taskmasterDb.TmPauseState;
  epoch: number;
  headroomState: HeadroomReading['state'];
  proposals: number;
  effects: number;
  parked: number;
  deferred: number;
  rejected: number;
  expired: number;
  failed: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface TaskmasterEffectRow {
  id: string;
  status: string;
  created_at: string;
}
type TaskmasterEffectQuery = (
  sql: string,
  params: unknown[]
) => Promise<{ rows: readonly TaskmasterEffectRow[] }>;

export async function defaultFindEffectByIdempotencyKey(
  key: string,
  query: TaskmasterEffectQuery = (sql, params) =>
    getDatabase().query<TaskmasterEffectRow>(sql, params)
): Promise<{ id: string; status: string; createdAt: string } | null> {
  const result = await query(
    `SELECT id, status, created_at FROM agent_dispatch_messages
     WHERE idempotency_key = $1
       AND sender_principal_id = 'system:taskmaster'
     LIMIT 1`,
    [key]
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, createdAt: row.created_at } : null;
}

/** Undelivered ratified rulings: queued board-motion mailbox rows not yet acknowledged. */
async function defaultListUndeliveredRulings(): Promise<ThreadSnapshot[]> {
  const queued: DispatchMessage[] = await listMessages({ status: 'queued', limit: 200 });
  return queued
    .filter(m => m.task_type === 'board_motion' && m.acknowledged_at === null)
    .map(m => ({
      ref: `dispatch:${m.id}`,
      priority: 'P1' as ThreadPriority,
      lastActivityAt: m.created_at,
      undeliveredRulingId: m.id,
      recipient: m.resolved_recipient ?? m.recipient,
    }));
}

function priorityFromLabels(labels: string[]): ThreadPriority {
  for (const p of ['P0', 'P1', 'P2', 'P3'] as const) {
    if (
      labels.some(label => {
        const match = /^(?:prio:|priority:)?p([0-3])$/i.exec(label.trim());
        return match?.[1] === p.slice(1);
      })
    )
      return p;
  }
  return 'P2';
}

interface GithubIssue {
  number: number;
  title?: string;
  updated_at: string;
  labels: ({ name?: string } | string)[];
  assignees?: { login?: string }[];
  pull_request?: unknown;
}

/**
 * Both work labels the spec names (Section 8: "gh issues (label wo/arc)").
 * The GitHub issues API treats `labels=a,b` as AND (issues carrying BOTH
 * labels), so each label is queried separately and results are deduped by
 * issue number -- OR semantics, never requiring both simultaneously.
 */
const WORK_LABELS = ['wo', 'project', 'arc'] as const;
const GITHUB_RATE_LIMIT_FLOOR = 5;

/**
 * Default max evidence enrichments per adoption refresh tick.
 * Rate-limit math (authenticated REST = 5,000 req/hour rolling):
 *   each evidence fetch = 3 requests; listThreads ~= 3/label/repo.
 *   budget 10 => 3 + 30 = 33 req/tick * 60 ticks/hr ~= 1,980/hr (fits under 5k).
 *   budget 30 would be ~5,580/hr and would stall against the floor.
 * Overridable at runtime via TASKMASTER_ADOPTION_EVIDENCE_BUDGET
 * (see resolveAdoptionEvidenceBudgetPerTick).
 */
export const ADOPTION_EVIDENCE_BUDGET_PER_TICK = 10;

export function resolveAdoptionEvidenceBudgetPerTick(
  raw: string | undefined = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return ADOPTION_EVIDENCE_BUDGET_PER_TICK;
}

/** Historical org rename (M-141, 2026-08-14): pre-rename journal rows still exist. */
const THREAD_REF_ORG_ALIASES: Record<string, string> = {
  bluedevilcollectibles: 'thinmansoftware',
};

/**
 * Canonicalize a thread ref so pre- and post-rename org eras collapse.
 * Non-gh refs (digest:, dispatch:) return byte-identical.
 */
export function canonicalizeThreadRef(ref: string): string {
  const match = /^gh:([^/]+)\/([^#]+)#(\d+)$/.exec(ref);
  if (!match) return ref;
  const org = match[1];
  const repo = match[2];
  const num = match[3];
  const canonicalOrg = THREAD_REF_ORG_ALIASES[org] ?? org;
  return `gh:${canonicalOrg}/${repo}#${num}`;
}

/**
 * Owner-login -> dispatch mailbox routing (M-155 WO 3). Named and testable,
 * but every entry deliberately resolves to 'xo' in this WO: of the allowlisted
 * recipients only 'xo' (XO's session-start reflex) and 'operator' (John) have
 * a consumer that drains the mailbox. Routing nudges to 'major-build' or
 * 'captain-ci' would manufacture a second dead-letter box -- exactly the
 * failure M-155 exists to end (920 unread 'xo' messages).
 *
 * PRECONDITION FOR WIDENING: a documented drain path for the target mailbox
 * (who reads it, on what cadence, verified). Widening is then a data change
 * here plus a follow-on WO -- never a silent edit.
 */
export const OWNER_RECIPIENT_MAP: Record<string, TmAllowedRecipient> = {
  xo: 'xo',
  'major-build': 'xo',
  'captain-ci': 'xo',
  operator: 'xo',
};

/** Resolve an issue owner login to the dispatch mailbox for ordinary nudges. */
export function resolveRecipient(ownerLogin: string | null | undefined): TmAllowedRecipient {
  const key = (ownerLogin ?? '').trim().toLowerCase();
  return OWNER_RECIPIENT_MAP[key] ?? 'xo';
}

/**
 * Same-subject repeat reasons, passed UNCONDITIONALLY per verb (M-155 WO 3).
 * dispatch.ts throws 'repeat_reason_required' when a prior row with the same
 * subject_key is terminal/handled and no repeat_reason was supplied; passing
 * the literal unconditionally is safe (stored only when a prior row matches)
 * and avoids a conditional whose edge case would surface as a journal outcome
 * of 'failed' rather than 'rejected' -- which matters immediately after the
 * WO 3 dead-letter script sets addressed_at on ~920 'xo' rows.
 */
export const TM_REPEAT_REASON_BY_TYPE: Record<TmActionType, string> = {
  nudge: 'tm:nudge:follow-up',
  escalate_p0: 'tm:escalate_p0:repeated',
  deliver_ruling: 'tm:deliver_ruling:repeated',
  digest: 'tm:digest:repeated',
  fire_cauldron: 'tm:fire_cauldron:repeated',
};

/** Listed work-SOR thread with optional adoption fields carried from the issue payload. */
export interface ListedThread extends ThreadSnapshot {
  title?: string | null;
  ownerLogin?: string | null;
  labels?: string[];
}

export interface AdoptionRefreshResult {
  ran: boolean;
  failed: boolean;
  error: string | null;
  snapshotId: string | null;
  rowCount: number;
  enrichedCount: number;
}

class GithubRateLimitBackoffError extends Error {}

function assertGithubRateLimit(response: Response, context: string): void {
  const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
  if (Number.isInteger(remaining) && remaining < GITHUB_RATE_LIMIT_FLOOR) {
    log.warn({ context, remaining }, 'taskmaster.github_rate_limit_backoff');
    throw new GithubRateLimitBackoffError(`taskmaster_github_rate_limit_backoff:${remaining}`);
  }
}

/**
 * Work-SOR read: open GitHub issues labeled wo, project, or arc across the configured
 * repos (one request per label -- see WORK_LABELS). Rate-limit-aware (Claude
 * seat amendment): honors x-ratelimit-remaining and backs off rather than
 * spinning. An incomplete or failed read throws so the tick cannot advance its
 * success heartbeat on a partial source snapshot. Exported for tests;
 * production callers use the tick() default. `fetchImpl` is injectable for
 * tests only.
 */
export async function defaultListThreads(fetchImpl: typeof fetch = fetch): Promise<ListedThread[]> {
  const repos = (process.env.TASKMASTER_GH_REPOS ?? 'thinmansoftware/bdc-xo')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const threads: ListedThread[] = [];
  for (const repo of repos) {
    const seen = new Set<number>();
    for (const label of WORK_LABELS) {
      try {
        const response = await fetchImpl(
          `https://api.github.com/repos/${repo}/issues?state=open&labels=${label}&per_page=100`,
          {
            headers: {
              accept: 'application/vnd.github+json',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
          }
        );
        assertGithubRateLimit(response, `work-sor:${repo}:${label}`);
        if (!response.ok) {
          log.warn({ repo, label, status: response.status }, 'taskmaster.github_read_failed');
          throw new Error(`taskmaster_github_work_sor_read_failed:${response.status}`);
        }
        const issues = (await response.json()) as GithubIssue[];
        for (const issue of issues) {
          if (issue.pull_request) continue;
          if (seen.has(issue.number)) continue; // carried both labels
          seen.add(issue.number);
          const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? '')));
          const priority = priorityFromLabels(labels);
          const normalizedLabels = labels.map(label => label.trim().toLowerCase());
          const hasClaimStatus = normalizedLabels.some(label =>
            ['status:building', 'status:review'].includes(label)
          );
          const ownerLogin = issue.assignees?.[0]?.login ?? null;
          const isUnclaimed = (issue.assignees ?? []).length === 0 && !hasClaimStatus;
          threads.push({
            ref: canonicalizeThreadRef(`gh:${repo}#${issue.number}`),
            priority,
            isCustomerFacing: labels.some(l => l.toLowerCase() === 'customer'),
            lastActivityAt: issue.updated_at,
            isBlocked: normalizedLabels.some(label =>
              ['blocked', 'status:blocked'].includes(label)
            ),
            isHeld: normalizedLabels.some(label => ['hold', 'status:hold'].includes(label)),
            isUnclaimed,
            isUnclaimedP0: priority === 'P0' && isUnclaimed,
            recipient: resolveRecipient(ownerLogin),
            title: issue.title ?? null,
            ownerLogin,
            labels,
          });
        }
      } catch (error) {
        log.warn({ err: error as Error, repo, label }, 'taskmaster.github_read_error');
        throw error;
      }
    }
  }
  return threads;
}

interface GithubIssueDetail extends GithubIssue {
  state: 'open' | 'closed';
  closed_at?: string | null;
}

interface GithubIssueComment {
  created_at: string;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}

interface GithubIssueEvent {
  event?: string;
  created_at: string;
  label?: { name?: string } | null;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Human (non-bot) comment that starts with [PROGRESS] or [BLOCKED] plus
 * non-whitespace. Regex and bot-check appear exactly once in this file.
 */
function isHumanMarkerComment(comment: GithubIssueComment): boolean {
  const login = comment.user?.login?.toLowerCase() ?? '';
  const isBot = comment.user?.type === 'Bot' || login.endsWith('[bot]') || login === 'taskmaster';
  return !isBot && /^\s*\[(?:PROGRESS|BLOCKED)\]\s+\S/i.test(comment.body ?? '');
}

function markerKindFromBody(body: string | null | undefined): 'PROGRESS' | 'BLOCKED' | null {
  // Kind is derived from a body already accepted by isHumanMarkerComment;
  // the marker regex must remain a single occurrence in this file.
  const open = (body ?? '').indexOf('[');
  if (open < 0) return null;
  const close = (body ?? '').indexOf(']', open + 1);
  if (close < 0) return null;
  const kind = (body ?? '')
    .slice(open + 1, close)
    .trim()
    .toUpperCase();
  if (kind === 'PROGRESS' || kind === 'BLOCKED') return kind;
  return null;
}

function truncateMarkerText(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
}

function computeLastMovement(
  closedAt: string | null,
  assignedAt: string | null,
  activeStatusAt: string | null,
  progressRecordedAt: string | null
): {
  lastMovementAt: string | null;
  lastMovementKind: 'closed' | 'assigned' | 'status_label' | 'progress_comment' | null;
} {
  const candidates: {
    at: string;
    kind: 'closed' | 'assigned' | 'status_label' | 'progress_comment';
  }[] = [];
  if (closedAt) candidates.push({ at: closedAt, kind: 'closed' });
  if (assignedAt) candidates.push({ at: assignedAt, kind: 'assigned' });
  if (activeStatusAt) candidates.push({ at: activeStatusAt, kind: 'status_label' });
  if (progressRecordedAt) candidates.push({ at: progressRecordedAt, kind: 'progress_comment' });
  if (candidates.length === 0) return { lastMovementAt: null, lastMovementKind: null };
  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { lastMovementAt: candidates[0].at, lastMovementKind: candidates[0].kind };
}

export async function defaultGetGithubIssueEvidence(
  threadRef: string,
  sinceIso: string,
  fetchImpl: typeof fetch = fetch
): Promise<GithubIssueEvidence | null> {
  const match = /^gh:([^#]+)#(\d+)$/.exec(threadRef);
  if (!match) return null;
  const repo = match[1];
  const issueNumber = match[2];
  const issueResponse = await fetchImpl(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
    { headers: githubHeaders() }
  );
  assertGithubRateLimit(issueResponse, `evidence:issue:${repo}#${issueNumber}`);
  if (!issueResponse.ok) {
    throw new Error(`taskmaster_github_issue_evidence_read_failed:${issueResponse.status}`);
  }
  const issue = (await issueResponse.json()) as GithubIssueDetail;
  // Fetch full comment list (no since=). Grading still filters post-since in
  // memory; adoption needs the latest marker regardless of age.
  const commentsResponse = await fetchImpl(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
    { headers: githubHeaders() }
  );
  assertGithubRateLimit(commentsResponse, `evidence:comments:${repo}#${issueNumber}`);
  if (!commentsResponse.ok) {
    throw new Error(
      `taskmaster_github_issue_evidence_read_failed:comments:${commentsResponse.status}`
    );
  }
  const comments = (await commentsResponse.json()) as GithubIssueComment[];
  const eventsResponse = await fetchImpl(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/events?per_page=100`,
    { headers: githubHeaders() }
  );
  assertGithubRateLimit(eventsResponse, `evidence:events:${repo}#${issueNumber}`);
  if (!eventsResponse.ok) {
    throw new Error(`taskmaster_github_issue_evidence_read_failed:events:${eventsResponse.status}`);
  }
  const events = (await eventsResponse.json()) as GithubIssueEvent[];
  const humanMarkers = comments
    .filter(isHumanMarkerComment)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latestMarker = humanMarkers[0] ?? null;
  const progress = humanMarkers.find(c => Date.parse(c.created_at) >= Date.parse(sinceIso));
  const postSendEvents = events.filter(
    event => Date.parse(event.created_at) >= Date.parse(sinceIso)
  );
  const latestEventAt = (predicate: (event: GithubIssueEvent) => boolean): string | null =>
    postSendEvents
      .filter(predicate)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]?.created_at ?? null;
  // Adoption last-movement uses the same four evidence fields, computed over
  // the full event/marker history (not only post-since) so a fresh enrichment
  // still surfaces older assignment/close/status/progress movement.
  const allLatestEventAt = (predicate: (event: GithubIssueEvent) => boolean): string | null =>
    events.filter(predicate).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
      ?.created_at ?? null;
  const closedAt = latestEventAt(event => event.event === 'closed');
  const assignedAt = latestEventAt(event => event.event === 'assigned');
  const activeStatusAt = latestEventAt(
    event =>
      event.event === 'labeled' &&
      ['status:building', 'status:review'].includes(event.label?.name?.trim().toLowerCase() ?? '')
  );
  const progressRecordedAt = progress?.created_at ?? null;
  const adoptionClosedAt = allLatestEventAt(event => event.event === 'closed');
  const adoptionAssignedAt = allLatestEventAt(event => event.event === 'assigned');
  const adoptionActiveStatusAt = allLatestEventAt(
    event =>
      event.event === 'labeled' &&
      ['status:building', 'status:review'].includes(event.label?.name?.trim().toLowerCase() ?? '')
  );
  const adoptionProgressAt = latestMarker?.created_at ?? null;
  const movement = computeLastMovement(
    adoptionClosedAt,
    adoptionAssignedAt,
    adoptionActiveStatusAt,
    adoptionProgressAt
  );
  return {
    state: issue.state,
    updatedAt: issue.updated_at,
    labels: issue.labels.map(label => (typeof label === 'string' ? label : (label.name ?? ''))),
    assigneeCount: issue.assignees?.length ?? 0,
    closedAt,
    assignedAt,
    activeStatusAt,
    progressRecordedAt,
    ownerLogin: issue.assignees?.[0]?.login ?? null,
    latestMarkerKind: latestMarker ? markerKindFromBody(latestMarker.body) : null,
    latestMarkerText: latestMarker ? truncateMarkerText(latestMarker.body) : null,
    latestMarkerAt: latestMarker?.created_at ?? null,
    lastMovementAt: movement.lastMovementAt,
    lastMovementKind: movement.lastMovementKind,
  };
}

function digestProposal(actions24h: taskmasterDb.TmJournalEntry[], nowMs: number): ActionProposal {
  const dateKey = new Date(nowMs).toISOString().slice(0, 10);
  const counts: Record<string, number> = {};
  for (const action of actions24h) {
    counts[`${action.action_type}:${action.outcome}`] =
      (counts[`${action.action_type}:${action.outcome}`] ?? 0) + 1;
  }
  const summary =
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || 'no actions in the last 24h';
  return {
    type: 'digest',
    threadRef: `digest:${dateKey}`,
    recipient: 'operator',
    body:
      `Taskmaster daily digest for ${dateKey}: ${summary}. ` +
      'Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
    idempotencyKey: `tm:digest:${dateKey}`,
    actsImmediately: true,
  };
}

/**
 * Restart reconciliation (Section 11 test 4): a journal row left 'pending'
 * (in-flight marker) is resolved against the external SOR. If the dispatch
 * row exists, the effect happened -- mark 'sent' WITHOUT a second
 * createAuthenticatedMessage. If it does not, expire the row so a future tick may
 * re-propose fresh. No key is ever re-sent from reconciliation.
 */
async function reconcilePendingActions(
  dal: TaskmasterDal,
  findEffect: NonNullable<TaskmasterDeps['findEffectByIdempotencyKey']>,
  nowMs: number
): Promise<void> {
  const since = new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString();
  const actions = await dal.getActionsSince(since);
  for (const action of actions) {
    if (action.outcome !== 'pending' || !action.idempotency_key) continue;
    const effect = await findEffect(action.idempotency_key);
    if (effect) {
      await dal.updateActionOutcome(action.id, 'sent');
      log.info(
        { journalId: action.id, idempotencyKey: action.idempotency_key },
        'taskmaster.reconcile_pending_marked_sent'
      );
    } else {
      await dal.updateActionOutcome(action.id, 'expired');
      log.info(
        { journalId: action.id, idempotencyKey: action.idempotency_key },
        'taskmaster.reconcile_pending_expired'
      );
    }
  }
}

/**
 * Grade sent actions against action-specific external SOR evidence recorded
 * after the outbound dispatch send. The outbound row alone never proves
 * usefulness.
 */
async function gradeSentActions(
  actions: taskmasterDb.TmJournalEntry[],
  dal: TaskmasterDal,
  findEffect: NonNullable<TaskmasterDeps['findEffectByIdempotencyKey']>,
  getDispatchById: NonNullable<TaskmasterDeps['getDispatchMessageById']>,
  getIssueEvidence: NonNullable<TaskmasterDeps['getGithubIssueEvidence']>,
  nowMs: number,
  getFireRunEvidence: NonNullable<TaskmasterDeps['getFireRunEvidence']>
): Promise<number> {
  let failures = 0;
  for (const action of actions) {
    if (action.outcome !== 'sent' || action.grade !== null || !action.idempotency_key) continue;
    try {
      if (action.action_type === 'fire_cauldron') {
        const proposal = JSON.parse(action.proposal_json) as ActionProposal & {
          cascadeId?: string;
        };
        const woId = proposal.fireEvidence?.woId;
        const cascadeId = proposal.cascadeId;
        if (!woId || !cascadeId) continue;
        const run = await getFireRunEvidence(woId, cascadeId);
        const issue = await getIssueEvidence(action.thread_ref, action.created_at);
        const buildingAtMs = issue?.activeStatusAt ? Date.parse(issue.activeStatusAt) : NaN;
        const deadlineMs = action.proof_deadline_at ? Date.parse(action.proof_deadline_at) : NaN;
        if (
          run?.status === 'completed' ||
          run?.prOpened === true ||
          (Number.isFinite(buildingAtMs) &&
            buildingAtMs >= Date.parse(action.created_at) &&
            (!Number.isFinite(deadlineMs) || buildingAtMs <= deadlineMs))
        ) {
          await dal.gradeAction(action.id, 'useful');
        } else if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
          await dal.gradeAction(action.id, 'noise');
        }
        continue;
      }
      const effect = await findEffect(action.idempotency_key);
      if (!effect) continue;
      if (effect.status === 'cancelled') {
        await dal.gradeAction(action.id, 'noise');
        continue;
      }
      if (action.action_type === 'digest') continue;

      const sentAtMs = Date.parse(effect.createdAt);
      if (!Number.isFinite(sentAtMs)) {
        failures += 1;
        log.warn({ journalId: action.id }, 'taskmaster.effect_send_time_missing');
        continue;
      }
      const deadlineMs = action.proof_deadline_at ? Date.parse(action.proof_deadline_at) : NaN;
      let usefulAtMs: number | null = null;
      if (action.action_type === 'deliver_ruling') {
        const rulingId = action.thread_ref.startsWith('dispatch:')
          ? action.thread_ref.slice('dispatch:'.length)
          : '';
        const ruling = rulingId ? await getDispatchById(rulingId) : null;
        const addressedAtMs = ruling?.addressed_at ? Date.parse(ruling.addressed_at) : NaN;
        const expectedRecipient = ruling?.resolved_recipient ?? ruling?.recipient;
        if (
          ruling &&
          ruling.addressed_by === expectedRecipient &&
          Number.isFinite(addressedAtMs) &&
          addressedAtMs >= sentAtMs
        ) {
          usefulAtMs = addressedAtMs;
        }
      } else {
        const issue = await getIssueEvidence(action.thread_ref, effect.createdAt);
        if (issue) {
          const closedAtMs = issue.closedAt ? Date.parse(issue.closedAt) : NaN;
          const assignedAtMs = issue.assignedAt ? Date.parse(issue.assignedAt) : NaN;
          const activeStatusAtMs = issue.activeStatusAt ? Date.parse(issue.activeStatusAt) : NaN;
          const progressAtMs = issue.progressRecordedAt
            ? Date.parse(issue.progressRecordedAt)
            : NaN;
          if (Number.isFinite(closedAtMs) && closedAtMs >= sentAtMs) usefulAtMs = closedAtMs;
          if (Number.isFinite(progressAtMs) && progressAtMs >= sentAtMs) {
            usefulAtMs = progressAtMs;
          }
          if (action.action_type === 'escalate_p0') {
            if (Number.isFinite(assignedAtMs) && assignedAtMs >= sentAtMs) {
              usefulAtMs = assignedAtMs;
            }
            if (Number.isFinite(activeStatusAtMs) && activeStatusAtMs >= sentAtMs) {
              usefulAtMs = activeStatusAtMs;
            }
          }
        }
      }

      if (usefulAtMs !== null && (!Number.isFinite(deadlineMs) || usefulAtMs <= deadlineMs)) {
        await dal.gradeAction(action.id, 'useful');
      } else if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
        await dal.gradeAction(action.id, 'noise');
      }
    } catch (error) {
      failures += 1;
      log.warn({ err: error as Error, journalId: action.id }, 'taskmaster.grade_failed');
      if (error instanceof GithubRateLimitBackoffError) break;
    }
  }
  return failures;
}

function proofPredicate(proposal: ActionProposal): string {
  if (proposal.type === 'deliver_ruling') {
    return 'original ruling row is addressed by its resolved recipient after the reminder dispatch send';
  }
  if (proposal.type === 'nudge') {
    return 'source issue closes or records a post-send [PROGRESS] or [BLOCKED] comment by a non-bot';
  }
  if (proposal.type === 'escalate_p0') {
    return 'source issue closes, gains an assignee or active status, or records post-send progress';
  }
  if (proposal.type === 'fire_cauldron') {
    return 'created Cauldron run completes or opens a PR, or the source issue gains status:building before the proof deadline';
  }
  return 'digest delivery only; never qualifies as an SC7 useful action';
}

function parseGhRef(ref: string): { repo: string; issueNumber: number } | null {
  const match = /^gh:([^#]+)#(\d+)$/.exec(ref);
  if (!match) return null;
  return { repo: match[1], issueNumber: Number(match[2]) };
}

/**
 * Rebuild the adoption projection for the current open-work set.
 * Takes the already-fetched thread list -- must NOT call defaultListThreads.
 * On any failure: abandon the in-flight snapshot, log, report failed, return
 * normally (never rethrow past tick()).
 */
export async function refreshAdoption(
  threads: ListedThread[],
  deps: TaskmasterDeps = {}
): Promise<AdoptionRefreshResult> {
  const dal = deps.db ?? taskmasterDb;
  const getIssueEvidence = deps.getGithubIssueEvidence ?? defaultGetGithubIssueEvidence;
  const now = deps.now ?? ((): Date => new Date());
  const nowMs = now().getTime();
  const nowIso = new Date(nowMs).toISOString();

  let snapshotId: string | null = null;
  try {
    snapshotId = await dal.beginAdoptionSnapshot();

    // Prior committed evidence ages for staleness ordering (NULL first).
    const priorRows = (await dal.getAdoption()) ?? [];
    const priorEvidenceAt = new Map<string, string | null>();
    for (const row of priorRows) {
      priorEvidenceAt.set(row.thread_ref, row.evidence_observed_at);
    }

    // Attempt counts: read journal without threadRef filter, group by canonical ref.
    const journalSince = new Date(0).toISOString();
    const allActions = await dal.getActionsSince(journalSince);
    const attemptsTotal = new Map<string, number>();
    const attempts24h = new Map<string, number>();
    const since24h = nowMs - DAY_MS;
    for (const action of allActions) {
      if (action.outcome !== 'sent') continue;
      const key = canonicalizeThreadRef(action.thread_ref);
      attemptsTotal.set(key, (attemptsTotal.get(key) ?? 0) + 1);
      if (Date.parse(action.created_at) >= since24h) {
        attempts24h.set(key, (attempts24h.get(key) ?? 0) + 1);
      }
    }

    // Staleness order: oldest evidence_observed_at first, NULL first.
    const ordered = [...threads].sort((a, b) => {
      const aRef = canonicalizeThreadRef(a.ref);
      const bRef = canonicalizeThreadRef(b.ref);
      const aAt = priorEvidenceAt.get(aRef) ?? null;
      const bAt = priorEvidenceAt.get(bRef) ?? null;
      if (aAt === null && bAt === null) return 0;
      if (aAt === null) return -1;
      if (bAt === null) return 1;
      return Date.parse(aAt) - Date.parse(bAt);
    });

    const budget = resolveAdoptionEvidenceBudgetPerTick();
    const enrichSet = new Set(ordered.slice(0, budget).map(t => canonicalizeThreadRef(t.ref)));
    let enrichedCount = 0;
    let rowCount = 0;

    // Epoch sinceIso so evidence fields cover full history for adoption.
    const adoptionSinceIso = new Date(0).toISOString();

    for (const thread of ordered) {
      const ref = canonicalizeThreadRef(thread.ref);
      const parsed = parseGhRef(ref);
      if (!parsed) continue;

      const base = {
        thread_ref: ref,
        repo: parsed.repo,
        issue_number: parsed.issueNumber,
        title: thread.title ?? null,
        priority: thread.priority,
        labels_json: JSON.stringify(thread.labels ?? []),
        owner_login: thread.ownerLogin ?? null,
        is_blocked: thread.isBlocked ? 1 : 0,
        blocked_reason: null as string | null,
        next_action: null as string | null,
        latest_marker_kind: null as 'PROGRESS' | 'BLOCKED' | null,
        latest_marker_at: null as string | null,
        state: null as string | null,
        last_movement_at: null as string | null,
        last_movement_kind: null as
          | 'closed'
          | 'assigned'
          | 'status_label'
          | 'progress_comment'
          | null,
        attempts_24h: attempts24h.get(ref) ?? 0,
        attempts_total: attemptsTotal.get(ref) ?? 0,
        evidence_observed_at: null as string | null,
        source_updated_at: thread.lastActivityAt,
      };

      if (enrichSet.has(ref)) {
        const evidence = await getIssueEvidence(ref, adoptionSinceIso);
        if (evidence) {
          base.owner_login = evidence.ownerLogin;
          base.state = evidence.state;
          base.labels_json = JSON.stringify(evidence.labels ?? thread.labels ?? []);
          base.source_updated_at = evidence.updatedAt || thread.lastActivityAt;
          base.latest_marker_kind = evidence.latestMarkerKind;
          base.latest_marker_at = evidence.latestMarkerAt;
          base.last_movement_at = evidence.lastMovementAt;
          base.last_movement_kind = evidence.lastMovementKind;
          base.evidence_observed_at = nowIso;
          if (evidence.latestMarkerKind === 'BLOCKED') {
            base.is_blocked = 1;
            base.blocked_reason = evidence.latestMarkerText;
            base.next_action = null;
          } else if (evidence.latestMarkerKind === 'PROGRESS') {
            base.next_action = evidence.latestMarkerText;
            // keep list-level isBlocked for label-based blocked; marker text goes next_action
          }
          // Prefer list title; evidence path does not re-fetch title separately.
          enrichedCount += 1;
        }
      }

      await dal.upsertAdoptionRow(snapshotId, base);
      rowCount += 1;
    }

    await dal.commitAdoptionSnapshot(snapshotId);
    return {
      ran: true,
      failed: false,
      error: null,
      snapshotId,
      rowCount,
      enrichedCount,
    };
  } catch (error) {
    if (snapshotId) {
      try {
        await dal.abandonAdoptionSnapshot(snapshotId);
      } catch (abandonError) {
        log.warn({ err: abandonError as Error, snapshotId }, 'taskmaster.adoption_abandon_failed');
      }
    }
    log.warn({ err: error as Error }, 'taskmaster.adoption_refresh_failed');
    return {
      ran: true,
      failed: true,
      error: error instanceof Error ? error.message : String(error),
      snapshotId,
      rowCount: 0,
      enrichedCount: 0,
    };
  }
}

export async function tick(state: TaskmasterState, deps: TaskmasterDeps = {}): Promise<TickResult> {
  const now = deps.now ?? ((): Date => new Date());
  const dal = deps.db ?? taskmasterDb;
  const createTask = deps.createTask ?? createAuthenticatedMessage;
  const findEffect = deps.findEffectByIdempotencyKey ?? defaultFindEffectByIdempotencyKey;
  const getDispatchById = deps.getDispatchMessageById ?? getMessage;
  const getIssueEvidence = deps.getGithubIssueEvidence ?? defaultGetGithubIssueEvidence;
  const eligibilityCheck = deps.checkFireEligibility ?? checkFireEligibility;
  const executeCascade = deps.runCascade ?? runCascade;
  const getFireRunEvidence =
    deps.getFireRunEvidence ??
    (async (woId: string): Promise<{ status: string; prOpened?: boolean } | null> => {
      const result = await getDatabase().query<{ status: string; metadata: string | null }>(
        `SELECT status, metadata FROM remote_agent_workflow_runs
         WHERE user_message LIKE $1 ORDER BY started_at DESC LIMIT 1`,
        [`%${woId}%`]
      );
      const row = result.rows[0];
      if (!row) return null;
      let prOpened = false;
      try {
        const metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
        prOpened = Boolean(metadata.prUrl ?? metadata.pr_url ?? metadata.pullRequestUrl);
      } catch {
        // Malformed metadata is no proof; status and issue evidence remain usable.
      }
      return { status: row.status, prOpened };
    });
  const nowMs = now().getTime();

  state.tickIndex += 1;
  recordTickAttempt(state.deadman, nowMs);
  let tickFailures = 0;

  // 1. Pause state + epoch captured.
  let control = await dal.getPauseState();
  const epoch = control.epoch;

  // Drop confirmations from a previous epoch: resume expires stale
  // proposals rather than replaying them.
  for (const [key, entry] of state.pendingConfirm) {
    if (entry.epoch !== epoch) state.pendingConfirm.delete(key);
  }

  // 2. Headroom -- own ledger reading; failure is UNKNOWN, never capacity.
  //    Slice 1 verbs are all dispatch messages (no model spend), so headroom
  //    is recorded and surfaced, not used to suppress messaging.
  let headroom: HeadroomReading;
  try {
    headroom = await (deps.headroom ?? ((): Promise<HeadroomReading> => currentHeadroom()))();
  } catch (error) {
    log.warn({ err: error as Error }, 'taskmaster.headroom_read_failed');
    headroom = {
      state: 'UNKNOWN',
      tokensRemaining: null,
      isUnknown: true,
      source: 'none',
      observedAt: new Date(nowMs).toISOString(),
    };
  }

  // 3. Restart reconciliation (once per process, before any new effect).
  if (!state.reconciled) {
    state.reconciled = true;
    try {
      await reconcilePendingActions(dal, findEffect, nowMs);
    } catch (error) {
      tickFailures += 1;
      log.warn({ err: error as Error }, 'taskmaster.reconcile_failed');
    }
  }

  // 4. Journal lookback: dedupe set + per-item 24h intervention counts.
  const lookback = await dal.getActionsSince(new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString());
  const actionsByKey = new Map<string, taskmasterDb.TmJournalEntry>();
  const interventions24hByThread = new Map<string, number>();
  const since24h = nowMs - DAY_MS;
  for (const action of lookback) {
    if (action.idempotency_key && !actionsByKey.has(action.idempotency_key))
      actionsByKey.set(action.idempotency_key, action);
    if (action.outcome === 'sent' && Date.parse(action.created_at) >= since24h) {
      interventions24hByThread.set(
        action.thread_ref,
        (interventions24hByThread.get(action.thread_ref) ?? 0) + 1
      );
    }
  }
  const actions24h = lookback.filter(a => Date.parse(a.created_at) >= since24h);
  const readHealth = deps.getHealthSample ?? taskmasterDb.getHealthSample;
  let codexHealth: taskmasterDb.TmHealthSample | null = null;
  let xaiHealth: taskmasterDb.TmHealthSample | null = null;
  try {
    [codexHealth, xaiHealth] = await Promise.all([readHealth('codex'), readHealth('xai')]);
  } catch (error) {
    log.warn({ err: error as Error }, 'taskmaster.lane_health_read_failed');
  }
  const laneDecision = decideFireLane(headroom, { codex: codexHealth, xai: xaiHealth });

  // Grade previously sent actions against the external SOR.
  tickFailures += await gradeSentActions(
    actions24h,
    dal,
    findEffect,
    getDispatchById,
    getIssueEvidence,
    nowMs,
    getFireRunEvidence
  );

  // M-155 Q3: useful-rate floor with auto-PAUSE. Counted AFTER
  // gradeSentActions so grades written this tick are included. Writing
  // PAUSED here is sufficient to withhold THIS tick's effects too: the
  // send loop re-reads pause state fresh immediately before every effect
  // and pause-parks on the fresh scope.
  if (control.pause_state === 'RUNNING') {
    try {
      const gradedWindow = await dal.getActionsSince(
        new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString()
      );
      let usefulCount = 0;
      let noiseCount = 0;
      for (const a of gradedWindow) {
        if (a.grade === 'useful') usefulCount += 1;
        else if (a.grade === 'noise') noiseCount += 1;
      }
      if (usefulRateFloorBreached(usefulCount, noiseCount)) {
        const graded = usefulCount + noiseCount;
        await dal.setPauseState({
          pause_state: 'PAUSED',
          pause_scope: 'effects',
          pause_reason:
            `M-155 useful-rate floor auto-pause: ${usefulCount} useful of ` +
            `${graded} graded (${Math.round((usefulCount / graded) * 100)}%) in the ` +
            '7-day lookback is below the ratified 40% floor. Resume requires an ' +
            'operator decision, not a timer.',
          pause_actor: 'taskmaster:useful-rate-floor',
        });
        log.warn({ usefulCount, noiseCount }, 'taskmaster.useful_rate_floor_auto_paused');
      }
    } catch (error) {
      tickFailures += 1;
      log.warn({ err: error as Error }, 'taskmaster.useful_rate_floor_check_failed');
    }
  }

  // 5. Reads -> classify -> propose.
  const result: TickResult = {
    ran: true,
    successful: true,
    pauseState: control.pause_state,
    epoch,
    headroomState: headroom.state,
    proposals: 0,
    effects: 0,
    parked: 0,
    deferred: 0,
    rejected: 0,
    expired: 0,
    failed: 0,
  };

  let rulings: ThreadSnapshot[] = [];
  let threads: ThreadSnapshot[] = [];
  try {
    rulings = await (deps.listUndeliveredRulings ?? defaultListUndeliveredRulings)();
  } catch (error) {
    tickFailures += 1;
    log.warn({ err: error as Error }, 'taskmaster.rulings_read_failed');
  }
  try {
    threads = await (deps.listThreads ?? defaultListThreads)();
  } catch (error) {
    tickFailures += 1;
    log.warn({ err: error as Error }, 'taskmaster.threads_read_failed');
  }

  // Adoption projection refresh (M-155 WO 1). Uses the already-fetched
  // thread list; must not re-list. Failures suppress heartbeat via
  // tickFailures but never abort the send/grade phase.
  {
    const adoptionResult = await refreshAdoption(threads, deps);
    if (adoptionResult.failed) tickFailures += 1;
  }

  // M-155 WO 3: adoption content index + durable noise-suppression state
  // (one read each per tick), plus a fresh grade grouping taken AFTER
  // gradeSentActions so grades written this tick count.
  const adoptionByRef = new Map<string, taskmasterDb.TmAdoptionRow>();
  for (const row of await dal.getAdoption()) {
    adoptionByRef.set(canonicalizeThreadRef(row.thread_ref), row);
  }
  const suppressionByRef: Map<string, taskmasterDb.TmSuppressionRow> = dal.getSuppression
    ? await dal.getSuppression()
    : new Map<string, taskmasterDb.TmSuppressionRow>();
  const gradesByRef = new Map<string, taskmasterDb.TmJournalEntry[]>();
  {
    const journalForGrades = await dal.getActionsSince(
      new Date(nowMs - JOURNAL_LOOKBACK_MS).toISOString()
    );
    for (const action of journalForGrades) {
      const key = canonicalizeThreadRef(action.thread_ref);
      const list = gradesByRef.get(key);
      if (list) list.push(action);
      else gradesByRef.set(key, [action]);
    }
  }

  // Suppression maintenance. tm_suppression is durable -- NEVER touched by
  // the adoption snapshot cycle (Section 9). Lift (delete) when the content
  // hash moved; create after two consecutive graded 'noise' sends.
  for (const [ref, adoptionRow] of adoptionByRef) {
    const liveHash = adoptionContentHash(adoptionRow);
    const existing = suppressionByRef.get(ref);
    if (existing) {
      if (existing.suppressed_until_hash !== liveHash) {
        // The work moved: suppression lifts. Chosen behavior: delete the row.
        if (dal.clearSuppression) await dal.clearSuppression(ref);
        suppressionByRef.delete(ref);
      }
      continue;
    }
    if (isSuppressedByNoise(ref, gradesByRef.get(ref) ?? [], adoptionRow) && dal.setSuppression) {
      await dal.setSuppression(ref, liveHash);
      suppressionByRef.set(ref, {
        thread_ref: ref,
        suppressed_until_hash: liveHash,
        suppressed_at: new Date(nowMs).toISOString(),
        noise_grade_count: 2,
      });
    }
  }

  const proposals: ActionProposal[] = [];
  for (const item of [...rulings, ...threads]) {
    const canonRef = canonicalizeThreadRef(item.ref);
    const adoptionRow = adoptionByRef.get(canonRef);
    const classification = classifyThread(item, nowMs);
    let fireResult: FireEligibilityResult = { eligible: false };
    const backoff = fireBackoffDecision(
      lookback,
      item.ref,
      state.tickIndex,
      state.deadman.intervalMs,
      nowMs
    );
    if (
      resolveFireVerbEnabled() &&
      backoff.kind === 'ready' &&
      (item.isUnclaimed ?? item.isUnclaimedP0) &&
      !item.isBlocked &&
      !item.isHeld &&
      typeof (item as ListedThread).title === 'string'
    ) {
      try {
        fireResult = await eligibilityCheck((item as ListedThread).title ?? '');
      } catch (error) {
        tickFailures += 1;
        log.warn(
          { err: error as Error, threadRef: item.ref },
          'taskmaster.fire_eligibility_failed'
        );
      }
    }
    const proposal = computeNextAction(item, classification, {
      interventionsLast24h: interventions24hByThread.get(item.ref) ?? 0,
      nowMs,
      // Content policy gates on what the projection KNOWS. A titleless row is
      // a ref-only skeleton (the list read carries titles for every real
      // issue), so it is handed over as "no adoption content" rather than as
      // a content-bearing row.
      adoption: adoptionRow?.title ? adoptionRow : undefined,
      grades: gradesByRef.get(canonRef),
      suppression: suppressionByRef.get(canonRef),
      fireEligible: fireResult.eligible && Boolean(fireResult.evidence?.expectedSpec),
      fireLane: laneDecision.lane,
      fireHolding: laneDecision.holding,
      fireEscalate: backoff.kind === 'escalate',
      customerP0Exempt:
        item.priority === 'P0' &&
        (item.isCustomerFacing === true ||
          ((item as ListedThread).labels ?? []).some(label =>
            [
              'customer-facing',
              'customer',
              'security',
              'data-loss',
              'prod-recovery',
              'production-recovery',
            ].includes(label.toLowerCase())
          )),
      fireEvidence: fireResult.evidence,
    });
    if (proposal) {
      proposals.push(proposal);
    }
  }

  if (
    laneDecision.holding &&
    (state.lastHoldMonitorTick === null || state.tickIndex - state.lastHoldMonitorTick >= 96)
  ) {
    state.lastHoldMonitorTick = state.tickIndex;
    log.warn(
      { tickIndex: state.tickIndex, reason: laneDecision.reason },
      'taskmaster.fire_budget_holding'
    );
    deps.onFireBudgetHolding?.(state.tickIndex, laneDecision.reason);
  }

  // Daily digest: one summary message per UTC day through the same path.
  const digest = digestProposal(actions24h, nowMs);
  proposals.push(digest);

  // Exceptions first so the per-tick budget can never starve them.
  const priorityByRef = new Map([...rulings, ...threads].map(item => [item.ref, item.priority]));
  const priorityRank: Record<ThreadPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const proposalRank = (proposal: ActionProposal): number => {
    if (proposal.type === 'deliver_ruling') return 0;
    if (proposal.type === 'escalate_p0') return 1;
    if (proposal.type === 'fire_cauldron') {
      return 2 + priorityRank[priorityByRef.get(proposal.threadRef) ?? 'P3'];
    }
    if (proposal.type === 'nudge') return 6;
    return 7;
  };
  proposals.sort((a, b) => {
    const immediate = Number(b.actsImmediately) - Number(a.actsImmediately);
    if (immediate !== 0) return immediate;
    return proposalRank(a) - proposalRank(b);
  });
  result.proposals = proposals.length;

  const touchedThisTick = new Set<string>();
  let firesThisTick = 0;

  for (const proposal of proposals) {
    let existingAction =
      actionsByKey.get(proposal.idempotencyKey) ??
      (await dal.getActionByIdempotencyKey(proposal.idempotencyKey));
    if (existingAction) actionsByKey.set(proposal.idempotencyKey, existingAction);

    if (
      existingAction &&
      ['sent', 'pending', 'rejected', 'expired', 'parked'].includes(existingAction.outcome)
    ) {
      continue;
    }
    if (existingAction && ['failed', 'deferred'].includes(existingAction.outcome)) {
      const deadlineMs = existingAction.proof_deadline_at
        ? Date.parse(existingAction.proof_deadline_at)
        : NaN;
      if (!Number.isFinite(deadlineMs) || nowMs >= deadlineMs) {
        await dal.updateActionOutcome(existingAction.id, 'expired');
        existingAction.outcome = 'expired';
        result.expired += 1;
        continue;
      }
    }
    const retrying = existingAction?.outcome === 'failed' || existingAction?.outcome === 'deferred';

    // Two-consecutive-tick confirmation for ordinary nudges. Exceptions
    // (rulings, unclaimed P0s, digest) act on the confirming tick.
    if (!proposal.actsImmediately && !retrying) {
      const pending = state.pendingConfirm.get(proposal.idempotencyKey);
      if (pending?.tickIndex !== state.tickIndex - 1) {
        state.pendingConfirm.set(proposal.idempotencyKey, {
          tickIndex: state.tickIndex,
          epoch,
        });
        continue;
      }
      state.pendingConfirm.delete(proposal.idempotencyKey);
    }

    // Guard: allowlist + content guard. Reject = journal only; a forbidden
    // effect additionally HARD-PAUSES effects (tighten, never KILL).
    const guardResult = validateProposal(proposal);
    if (!guardResult.allowed) {
      result.rejected += 1;
      await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify({ ...proposal, guardReason: guardResult.reason }),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        outcome: 'rejected',
      });
      if (guardResult.forbiddenEffect && control.pause_state === 'RUNNING') {
        control = await dal.setPauseState({
          pause_state: 'HARD_PAUSE',
          pause_scope: 'effects',
          pause_reason: `auto-circuit: ${guardResult.reason ?? 'forbidden effect'}`,
          pause_actor: 'taskmaster:auto-circuit',
        });
        result.pauseState = control.pause_state;
      }
      continue;
    }

    // Mode matrix: a pause with scope='effects' withholds EVERY effect (parked
    // with reason='paused'); a non-'effects' pause keeps P0 escalation and the
    // digest alive so watching never goes dark.
    if (
      control.pause_state !== 'RUNNING' &&
      !isPauseEffectsExempt(proposal.type, control.pause_scope)
    ) {
      result.parked += 1;
      await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify({ ...proposal, parked: true, reason: 'paused' }),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        outcome: 'parked',
      });
      continue;
    }

    // Budgets: max 10 effects/tick, 1 effect/item/tick. Overflow is
    // journaled as deferred, not dropped.
    if (
      result.effects >= MAX_EFFECTS_PER_TICK ||
      (proposal.type === 'fire_cauldron' && firesThisTick >= MAX_FIRES_PER_TICK) ||
      touchedThisTick.has(proposal.threadRef)
    ) {
      result.deferred += 1;
      if (!existingAction) {
        existingAction = await dal.recordAction({
          thread_ref: proposal.threadRef,
          action_type: proposal.type,
          proposal_json: JSON.stringify({ ...proposal, deferred: true }),
          idempotency_key: proposal.idempotencyKey,
          before_hash: sha256(proposal.body),
          proof_predicate: proofPredicate(proposal),
          proof_deadline_at: new Date(nowMs + PROOF_DEADLINE_MS).toISOString(),
          outcome: 'deferred',
        });
        actionsByKey.set(proposal.idempotencyKey, existingAction);
      }
      continue;
    }

    // ROW FIRST, always -- then the effect.
    let journalRow: taskmasterDb.TmJournalEntry;
    if (existingAction && retrying) {
      const reused = await dal.updateActionOutcome(existingAction.id, 'pending');
      if (!reused) throw new Error(`taskmaster_retry_row_missing:${existingAction.id}`);
      journalRow = reused;
    } else {
      journalRow = await dal.recordAction({
        thread_ref: proposal.threadRef,
        action_type: proposal.type,
        proposal_json: JSON.stringify(proposal),
        idempotency_key: proposal.idempotencyKey,
        before_hash: sha256(proposal.body),
        proof_predicate: proofPredicate(proposal),
        proof_deadline_at: new Date(nowMs + PROOF_DEADLINE_MS).toISOString(),
        outcome: 'pending',
      });
    }
    actionsByKey.set(proposal.idempotencyKey, journalRow);

    // Re-check pause epoch immediately before the effect. Recompute the
    // effects-exempt test against the FRESH scope so a pause that lands
    // mid-tick is caught even for escalate_p0/digest.
    const fresh = await dal.getPauseState();
    const freshPauseWithhold =
      fresh.pause_state !== 'RUNNING' && !isPauseEffectsExempt(proposal.type, fresh.pause_scope);
    if (fresh.epoch !== epoch || freshPauseWithhold) {
      // A pause that landed mid-tick (fresh scope withholds this effect) is a
      // pause-park, not an ordinary stale-epoch/resume expiry: re-tag the
      // ROW-FIRST row as parked with reason='paused' so it is indistinguishable
      // from a site-1 pause-park and is counted in result.parked (the withheld
      // total). A pure epoch mismatch (resume/stale) stays 'expired'.
      if (freshPauseWithhold) {
        result.parked += 1;
        await dal.updateActionOutcome(
          journalRow.id,
          'parked',
          JSON.stringify({ ...proposal, parked: true, reason: 'paused' })
        );
      } else {
        result.expired += 1;
        await dal.updateActionOutcome(journalRow.id, 'expired');
      }
      continue;
    }

    try {
      if (proposal.type === 'fire_cauldron' && proposal.fireEvidence) {
        let resolveAdmission: ((record: Awaited<ReturnType<typeof runCascade>>) => void) | null =
          null;
        let rejectAdmission: ((error: unknown) => void) | null = null;
        const admission = new Promise<Awaited<ReturnType<typeof runCascade>>>((resolve, reject) => {
          resolveAdmission = resolve;
          rejectAdmission = reject;
        });
        const cascadePromise = executeCascade({
          woId: proposal.fireEvidence.woId,
          expectedSpec: proposal.fireEvidence.expectedSpec,
          project: proposal.fireEvidence.project,
          dispatchId: proposal.idempotencyKey,
          token: process.env.ARCHON_OPERATOR_TOKEN ?? '',
          onAdmission: record => resolveAdmission?.(record),
        });
        void cascadePromise.catch((error: unknown) => {
          rejectAdmission?.(error);
          log.error(
            { err: error, woId: proposal.fireEvidence?.woId },
            'taskmaster.fire_cascade_failed'
          );
        });
        const admitted = await admission;
        await dal.updateActionOutcome(
          journalRow.id,
          'sent',
          JSON.stringify({ ...proposal, cascadeId: admitted.cascadeId, runId: admitted.cascadeId })
        );
      } else {
        await createTask(
          { kind: 'system', sender: 'taskmaster' },
          {
            correlation_id: `tm-${journalRow.id}`,
            idempotency_key: proposal.idempotencyKey,
            task_type: 'agent_message',
            recipient: proposal.recipient,
            body: proposal.body,
            // Same-subject grouping + unconditional per-verb repeat reason
            // (M-155 WO 3): see TM_REPEAT_REASON_BY_TYPE for why unconditional.
            subject_key: canonicalizeThreadRef(proposal.threadRef),
            repeat_reason: TM_REPEAT_REASON_BY_TYPE[proposal.type],
          }
        );
        await dal.updateActionOutcome(journalRow.id, 'sent');
      }
      journalRow.outcome = 'sent';
      touchedThisTick.add(proposal.threadRef);
      result.effects += 1;
      if (proposal.type === 'fire_cauldron') firesThisTick += 1;
      log.info(
        {
          actionType: proposal.type,
          threadRef: proposal.threadRef,
          idempotencyKey: proposal.idempotencyKey,
        },
        'taskmaster.effect_sent'
      );
    } catch (error) {
      await dal.updateActionOutcome(journalRow.id, 'failed');
      journalRow.outcome = 'failed';
      tickFailures += 1;
      log.error({ err: error as Error, threadRef: proposal.threadRef }, 'taskmaster.effect_failed');
    }
  }

  // Report how many effects a pause withheld this tick. result.parked is
  // incremented ONLY by the two pause-park sites (site 1 at tick-start scope,
  // site 2 at the mid-tick fresh re-check), so it is the exact withheld count.
  // Gate on result.parked (not the tick-start `control`) so a pause that lands
  // mid-tick -- where `control` was still RUNNING at tick start -- is still
  // logged instead of going dark.
  if (result.parked > 0) {
    log.info(
      { withheld: result.parked, pauseState: control.pause_state, epoch },
      'taskmaster.tick_paused_withheld'
    );
  }

  result.failed = tickFailures;
  result.successful = tickFailures === 0;
  if (result.successful) recordTickHeartbeat(state.deadman, nowMs);
  return result;
}

// ---------------------------------------------------------------------------
// Scheduler singleton (skeleton cloned from the provider-wait scheduler in
// packages/server/src/routes/api.ts).
// ---------------------------------------------------------------------------

export interface TaskmasterRuntime {
  state: TaskmasterState;
  intervalMs: number;
  ownerId: string;
  lastTickResult: TickResult | null;
}

let taskmasterTimer: ReturnType<typeof setInterval> | undefined;
let taskmasterRuntime: TaskmasterRuntime | undefined;

export function stopTaskmaster(): void {
  if (taskmasterTimer) clearInterval(taskmasterTimer);
  taskmasterTimer = undefined;
  taskmasterRuntime = undefined;
}

export function getTaskmasterRuntime(): TaskmasterRuntime | undefined {
  return taskmasterRuntime;
}

export function getTickHealth(nowMs: number = Date.now()): TickHealth {
  if (!taskmasterRuntime) return 'not_running';
  return tickHealth(taskmasterRuntime.state.deadman, nowMs);
}

/**
 * Parse TASKMASTER_INTERVAL_MS: integer > 0 enables the loop at that
 * interval; 0 is KILLED (no tick); anything else falls back to 60000.
 */
export function resolveTaskmasterIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return 60_000;
}

export function resolveFireVerbEnabled(
  raw: string | undefined = process.env.TASKMASTER_FIRE_VERB_ENABLED
): boolean {
  return raw?.trim().toLowerCase() === 'true' || raw?.trim() === '1';
}

/**
 * Start the taskmaster loop. Module-scope singleton: subsequent calls are
 * no-ops while a timer exists. TASKMASTER_INTERVAL_MS=0 disables (KILLED).
 */
export function startTaskmaster(ownerIdSuffix: string, deps: TaskmasterDeps = {}): void {
  if (taskmasterTimer !== undefined) return;
  const intervalMs = resolveTaskmasterIntervalMs(process.env.TASKMASTER_INTERVAL_MS);
  if (intervalMs === 0) {
    log.info({}, 'taskmaster.disabled_by_interval_env');
    return;
  }
  const state = createTaskmasterState(intervalMs);
  taskmasterRuntime = {
    state,
    intervalMs,
    ownerId: `taskmaster:${ownerIdSuffix}`,
    lastTickResult: null,
  };
  let inFlight = false;
  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const tickResult = await tick(state, deps);
      if (taskmasterRuntime) taskmasterRuntime.lastTickResult = tickResult;
      if (tickResult.effects > 0 || tickResult.rejected > 0) {
        log.info(tickResult, 'taskmaster.tick_completed');
      }
    } catch (error) {
      log.error({ err: error as Error }, 'taskmaster.tick_failed');
    } finally {
      inFlight = false;
    }
  };
  taskmasterTimer = setInterval(() => void runTick(), intervalMs);
  taskmasterTimer.unref?.();
  void runTick();
}
