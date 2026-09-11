import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {
  CanaryVerdict,
  LifecycleCanaryReport,
  LifecycleLegId,
  LifecycleLegReport,
} from './types';
import { LIFECYCLE_LEGS } from './types';

// Canary scratch-path convention. Single source of truth shared by the probe,
// the live-run tooling, and the operator. See
// .archon/canaries/lifecycle-scratch/README.md for the full contract.
export const LIFECYCLE_SCRATCH_DIR = '.archon/canaries/lifecycle-scratch';
// A CLI-controlled runId is joined into an artifact filesystem path
// (writeLifecycleCanaryArtifacts). Validated at BOTH CLI-parse time (cli.ts)
// and again inside the artifact writer (defense in depth -- never trust the
// caller) against this strict allowlist pattern to prevent path traversal.
export const LIFECYCLE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidLifecycleRunId(runId: string): boolean {
  return LIFECYCLE_RUN_ID_PATTERN.test(runId);
}
// The planted defect is an unambiguous, greppable wrong-constant. Leg 3 asserts
// Overseer names this literal; Leg 4 asserts remediation removes it.
export const LIFECYCLE_PLANTED_DEFECT_LITERAL = 'WRONG_VALUE';

// A bare content-addressed placeholder (no readable text). Leg 8 fails if a
// dispatch reply body is only this shape instead of real text.
const BARE_SHA256_PLACEHOLDER = /^sha256:[0-9a-f]{64}(\s+bytes=\d+)?$/i;

// ---------------------------------------------------------------------------
// Clock + polling (injectable so tests run deterministically with no real waits)
// ---------------------------------------------------------------------------

export interface LifecycleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: LifecycleClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
};

interface PollResult<T> {
  readonly satisfied: boolean;
  readonly value: T;
  readonly attempts: number;
}

// Races a promise against a real wall-clock timeout so a single hanging
// artifact-source call (e.g. a wedged `gh`/`git` subprocess) cannot block the
// suite forever, regardless of the injected LifecycleClock used for polling
// cadence. Uses real setTimeout deliberately -- this is a genuine process-level
// deadline, not simulated time.
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`timeout_after_${ms}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, ms));
    }, ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function pollUntil<T>(
  clock: LifecycleClock,
  timeoutMs: number,
  intervalMs: number,
  attempt: () => Promise<{ satisfied: boolean; value: T }>
): Promise<PollResult<T>> {
  const start = clock.now();
  // Attempt cap is a safety backstop against a non-advancing clock; the
  // time-based deadline is the primary exit condition.
  const maxAttempts = intervalMs > 0 ? Math.ceil(timeoutMs / intervalMs) + 2 : 1;
  let attempts = 1;
  let last = await attempt();
  while (!last.satisfied && clock.now() - start < timeoutMs && attempts < maxAttempts) {
    await clock.sleep(intervalMs);
    attempts += 1;
    last = await attempt();
  }
  return { satisfied: last.satisfied, value: last.value, attempts };
}

// ---------------------------------------------------------------------------
// Artifact shapes (subset of gh/git/sqlite output the legs assert against)
// ---------------------------------------------------------------------------

export interface TmJournalFireRow {
  readonly id: number | string;
  readonly proposal_type: string;
  readonly target: string;
  readonly created_at: string;
}

export interface PrSummary {
  readonly number: number;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
}

export interface PrReview {
  readonly state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
  readonly body: string;
  readonly submittedAt: string; // ISO
  readonly authorLogin: string;
  // The head commit SHA the review was submitted against. Required to prove a
  // review is pinned to the post-remediation head, not merely timestamped
  // after it (a review can be re-requested/backdated against a stale head).
  readonly commitId: string;
}

export interface PrView {
  readonly number: number;
  readonly state: string; // OPEN | MERGED | CLOSED
  readonly mergedByLogin: string | null;
  readonly commitCount: number;
  readonly mergeCommitOid: string | null;
}

export interface RunReviewRow {
  readonly head_sha: string;
  readonly action: string;
  readonly created_at: string;
}

export interface IssueView {
  readonly number: number;
  readonly state: string; // OPEN | CLOSED
  readonly stateReason: string | null;
}

// The single artifact-access concern for the whole wheel. Every method reads a
// pipeline artifact (event-store row, gh field, git state) and performs no
// mutation. Fully mockable for unit tests; the default implementation shells
// out (bun:sqlite for the event store, gh/git for GitHub + repo state).
export interface LifecycleArtifactSource {
  // Leg 1
  queryTmJournalFireCauldron(sinceIso: string): Promise<readonly TmJournalFireRow[]>;
  // Leg 2
  listPrsForBranch(headBranch: string): Promise<readonly PrSummary[]>;
  // Legs 2/4/6
  viewPr(prNumber: number): Promise<PrView>;
  // Legs 3/5
  listPrReviews(prNumber: number): Promise<readonly PrReview[]>;
  // Leg 4
  countDiffMatches(prNumber: number, literal: string): Promise<number>;
  // Leg 5 (a) trigger evidence
  queryRunReview(headSha: string): Promise<readonly RunReviewRow[]>;
  // Leg 6 merge actor (from issue timeline)
  mergedActorLogin(prNumber: number): Promise<string | null>;
  // Leg 7
  viewIssue(issueNumber: number): Promise<IssueView>;
  // Leg 8
  dispatchResultBody(messageId: string): Promise<string | null>;
  // Leg 9
  readDutyOfficerReport(): Promise<string>;
  // Leg 10 residue: content diff of the scratch path ON THE BASE BRANCH between
  // the revision captured before the run started and the post-run base tip.
  // Diffing the worktree against the current base tip would report clean once a
  // canary marker is merged into both, so the pre-run revision is the anchor.
  scratchResidueDiff(baseBranch: string, preRunRevision: string): Promise<string>;
  countRevertCommits(runId: string): Promise<number>;
  // Invariant 2 diff-scope
  listPrChangedFiles(prNumber: number): Promise<readonly string[]>;
  // Leg 5 head refresh: the live PR head sha + its commit timestamp, read AFTER
  // Leg 4 observes remediation on the PR. Leg 5 must validate against this real
  // post-remediation head, not the sha captured at initiation (which predates
  // Legs 2-4 and is stale by the time remediation lands).
  getPrHead(prNumber: number): Promise<{ readonly sha: string; readonly committedAtIso: string }>;
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function titleFor(legId: LifecycleLegId): string {
  return LIFECYCLE_LEGS.find(leg => leg.id === legId)?.title ?? legId;
}

function leg(
  legId: LifecycleLegId,
  verdict: CanaryVerdict,
  reasonCodes: readonly string[],
  evidenceRefs: readonly string[],
  gap?: string
): LifecycleLegReport {
  return { legId, title: titleFor(legId), verdict, reasonCodes, evidenceRefs, gap };
}

// A leg whose upstream prerequisite (e.g. a PR number) was never produced.
// Reported blocked (not failed) so a Leg-2 no-PR does not masquerade as a
// downstream defect, and never as a false pass.
function upstreamBlocked(legId: LifecycleLegId, reason: string): LifecycleLegReport {
  return leg(legId, 'blocked', [reason], [`upstream_missing=${reason}`]);
}

// ---------------------------------------------------------------------------
// Leg checks (each is an independently testable graded assertion)
// ---------------------------------------------------------------------------

export interface LegPollConfig {
  readonly clock: LifecycleClock;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

export async function checkLeg1TaskmasterFires(input: {
  readonly source: Pick<LifecycleArtifactSource, 'queryTmJournalFireCauldron'>;
  readonly sinceIso: string;
  readonly targetIssue?: number;
  readonly fallbackUsed: boolean;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const rows = await input.source.queryTmJournalFireCauldron(input.sinceIso);
    const match = rows.find(
      row =>
        row.proposal_type === 'fire_cauldron' &&
        (input.targetIssue === undefined || row.target.includes(String(input.targetIssue)))
    );
    return { satisfied: match !== undefined, value: match };
  });
  if (result.satisfied && result.value) {
    return leg(
      'taskmaster-fire',
      'passed',
      [],
      ['tm_journal.proposal_type=fire_cauldron', `tm_journal.target=${result.value.target}`]
    );
  }
  // Absence of a fire is a documented gap (bdc-xo#1843), not a false pass.
  return leg(
    'taskmaster-fire',
    'blocked',
    ['taskmaster_never_fires'],
    ['tm_journal.fire_cauldron_rows=0', `polled_attempts=${result.attempts}`],
    input.fallbackUsed
      ? 'taskmaster-never-fired, fallback: fire.ps1 used'
      : 'taskmaster-never-fired'
  );
}

export async function checkLeg2CodexLaneOpensPr(input: {
  readonly source: Pick<LifecycleArtifactSource, 'listPrsForBranch'>;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly poll: LegPollConfig;
}): Promise<{ report: LifecycleLegReport; prNumber?: number }> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const prs = await input.source.listPrsForBranch(input.headBranch);
    const onBase = prs.filter(pr => pr.baseRefName === input.baseBranch);
    return { satisfied: onBase.length >= 1, value: onBase };
  });
  const onBase = result.value ?? [];
  if (onBase.length === 1) {
    const pr = onBase[0];
    return {
      report: leg(
        'codex-lane-build-pr',
        'passed',
        [],
        [`pr=${pr.number}`, `base=${pr.baseRefName}`]
      ),
      prNumber: pr.number,
    };
  }
  if (onBase.length > 1) {
    return {
      report: leg(
        'codex-lane-build-pr',
        'failed',
        ['codex_lane_multiple_prs'],
        [`pr_count=${onBase.length}`, `branch=${input.headBranch}`]
      ),
    };
  }
  return {
    report: leg(
      'codex-lane-build-pr',
      'failed',
      ['codex_lane_no_pr'],
      ['pr_count=0', `branch=${input.headBranch}`, `polled_attempts=${result.attempts}`]
    ),
  };
}

export async function checkLeg3OverseerCatchesDefect(input: {
  readonly source: Pick<LifecycleArtifactSource, 'listPrReviews'>;
  readonly prNumber: number;
  readonly defectSignature: string;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const reviews = await input.source.listPrReviews(input.prNumber);
    const naming = reviews.find(
      review => review.state === 'CHANGES_REQUESTED' && review.body.includes(input.defectSignature)
    );
    return { satisfied: naming !== undefined, value: { reviews, naming } };
  });
  if (result.satisfied && result.value?.naming) {
    return leg(
      'overseer-catch-defect',
      'passed',
      [],
      ['review.state=CHANGES_REQUESTED', `defect_named=${input.defectSignature}`]
    );
  }
  return leg(
    'overseer-catch-defect',
    'failed',
    ['overseer_missed_planted_defect'],
    [
      `reviews_seen=${result.value?.reviews.length ?? 0}`,
      `defect_signature=${input.defectSignature}`,
    ]
  );
}

export async function checkLeg4RemediationReachesPr(input: {
  readonly source: Pick<LifecycleArtifactSource, 'countDiffMatches'>;
  readonly prNumber: number;
  readonly literal: string;
  readonly autoRemediationAvailable: boolean;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const count = await input.source.countDiffMatches(input.prNumber, input.literal);
    return { satisfied: count === 0, value: count };
  });
  // The auto-remediation path (Overseer verdict -> Taskmaster candidate) does
  // not yet exist (bdc-xo#1835). Record the manual/subagent path as a gap even
  // when the defect is successfully removed.
  const gap = input.autoRemediationAvailable
    ? undefined
    : 'auto-remediation-missing-#1835, manual/subagent path used';
  if (result.satisfied) {
    return leg(
      'remediation-reaches-pr',
      'passed',
      [],
      ['diff_matches_after=0', `literal=${input.literal}`],
      gap
    );
  }
  return leg(
    'remediation-reaches-pr',
    'failed',
    ['remediation_not_applied'],
    [`diff_matches_after=${result.value ?? 'unknown'}`, `literal=${input.literal}`],
    gap
  );
}

export async function checkLeg5OverseerReapproves(input: {
  readonly source: Pick<LifecycleArtifactSource, 'queryRunReview' | 'listPrReviews'>;
  readonly prNumber: number;
  readonly remediationSha: string;
  readonly remediationCommitIso: string;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const remediationMs = Date.parse(input.remediationCommitIso);
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    // (a) trigger fired: a run_review row for the synchronize event.
    const rows = await input.source.queryRunReview(input.remediationSha);
    const triggered = rows.some(
      row => row.action === 'synchronize' && row.head_sha === input.remediationSha
    );
    // (b) verdict correct: the LATEST review must be APPROVED and pinned to
    // the post-remediation head sha. Filtering "any APPROVED review after the
    // remediation timestamp" is not sufficient -- it lets a stale APPROVED
    // review (submitted late but against an older head) satisfy the leg even
    // when the current, correct verdict is a CHANGES_REQUESTED against the
    // remediation head. Require commit_id == remediationSha, then take the
    // most recently submitted review among those pinned to that head and
    // check its state.
    const reviews = await input.source.listPrReviews(input.prNumber);
    const reviewsOnRemediationHead = reviews
      .filter(review => review.commitId === input.remediationSha)
      .filter(review => Number.isFinite(Date.parse(review.submittedAt)));
    const latestOnHead = [...reviewsOnRemediationHead].sort(
      (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt)
    )[0];
    const approvedAfter =
      latestOnHead?.state === 'APPROVED' &&
      (!Number.isFinite(remediationMs) || Date.parse(latestOnHead.submittedAt) >= remediationMs);
    return { satisfied: triggered && approvedAfter, value: { triggered, approvedAfter } };
  });
  const { triggered, approvedAfter } = result.value ?? {};
  if (triggered && approvedAfter) {
    return leg(
      'overseer-reapprove',
      'passed',
      [],
      [
        'run_review.action=synchronize',
        `run_review.head_sha=${input.remediationSha}`,
        'review.state=APPROVED',
      ]
    );
  }
  if (!triggered) {
    return leg(
      'overseer-reapprove',
      'failed',
      ['overseer_resync_trigger_not_firing'],
      ['run_review.synchronize_rows=0', `head_sha=${input.remediationSha}`]
    );
  }
  return leg(
    'overseer-reapprove',
    'failed',
    ['overseer_no_reapproval'],
    ['run_review.action=synchronize', 'approved_after_remediation=false']
  );
}

export async function checkLeg6AutonomousMerge(input: {
  readonly source: Pick<LifecycleArtifactSource, 'viewPr' | 'mergedActorLogin'>;
  readonly prNumber: number;
  readonly mergeIdentity: string;
  readonly humanLogins: readonly string[];
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const view = await input.source.viewPr(input.prNumber);
    return { satisfied: view.state === 'MERGED', value: view };
  });
  const view = result.value;
  if (view?.state !== 'MERGED') {
    return leg(
      'autonomous-merge',
      'failed',
      ['merge_manager_did_not_merge'],
      [`pr.state=${view?.state ?? 'unknown'}`]
    );
  }
  const actor = (await input.source.mergedActorLogin(input.prNumber)) ?? view.mergedByLogin;
  if (actor && input.humanLogins.includes(actor)) {
    return leg(
      'autonomous-merge',
      'failed',
      ['human_merged_not_autonomous'],
      [`merged_by=${actor}`]
    );
  }
  if (actor !== input.mergeIdentity) {
    return leg(
      'autonomous-merge',
      'failed',
      ['merge_manager_did_not_merge'],
      [`merged_by=${actor ?? 'unknown'}`, `expected=${input.mergeIdentity}`]
    );
  }
  return leg(
    'autonomous-merge',
    'passed',
    [],
    ['pr.state=MERGED', `merged_by=${actor}`, `merge_commit=${view.mergeCommitOid ?? 'unknown'}`]
  );
}

export async function checkLeg7ReconcileClosesIssue(input: {
  readonly source: Pick<LifecycleArtifactSource, 'viewIssue'>;
  readonly issueNumber: number;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const view = await input.source.viewIssue(input.issueNumber);
    return { satisfied: view.state === 'CLOSED', value: view };
  });
  const view = result.value;
  if (view?.state === 'CLOSED') {
    return leg(
      'reconcile-closes-issue',
      'passed',
      [],
      [
        `issue=${input.issueNumber}`,
        'issue.state=CLOSED',
        `state_reason=${view.stateReason ?? '-'}`,
      ]
    );
  }
  return leg(
    'reconcile-closes-issue',
    'failed',
    ['reconcile_did_not_close'],
    [`issue=${input.issueNumber}`, `issue.state=${view?.state ?? 'unknown'}`]
  );
}

export async function checkLeg8DispatchReadableReply(input: {
  readonly source: Pick<LifecycleArtifactSource, 'dispatchResultBody'>;
  readonly messageId: string;
  readonly expectedSubstring: string;
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const body = await input.source.dispatchResultBody(input.messageId);
    const readable =
      body !== null &&
      body.trim().length > 0 &&
      !BARE_SHA256_PLACEHOLDER.test(body.trim()) &&
      body.includes(input.expectedSubstring);
    return { satisfied: readable, value: body };
  });
  if (result.satisfied) {
    return leg(
      'dispatch-readable-reply',
      'passed',
      [],
      [`message=${input.messageId}`, 'result_body_readable=true']
    );
  }
  const body = result.value;
  const bare = body !== null && BARE_SHA256_PLACEHOLDER.test(body.trim());
  return leg(
    'dispatch-readable-reply',
    'failed',
    ['dispatch_reply_unreadable'],
    [
      `message=${input.messageId}`,
      body === null ? 'result_body=null' : `result_body_is_bare_sha256=${bare}`,
    ]
  );
}

export async function checkLeg9DutyOfficerReports(input: {
  readonly source: Pick<LifecycleArtifactSource, 'readDutyOfficerReport'>;
  readonly runId: string;
  readonly staleFlagMarkers: readonly string[];
  readonly poll: LegPollConfig;
}): Promise<LifecycleLegReport> {
  const { clock, timeoutMs, intervalMs } = input.poll;
  const result = await pollUntil(clock, timeoutMs, intervalMs, async () => {
    const report = await input.source.readDutyOfficerReport();
    const sawRun = report.includes(input.runId);
    return { satisfied: sawRun, value: report };
  });
  const report = result.value ?? '';
  if (!report.includes(input.runId)) {
    return leg(
      'duty-officer-reports',
      'failed',
      ['do_did_not_see_run'],
      [`run_id=${input.runId}`, 'report_mentions_run=false']
    );
  }
  // A false-positive stale nudge on the canary's own arc is itself a defect.
  const flaggedStale = input.staleFlagMarkers.some(marker => report.includes(marker));
  if (flaggedStale) {
    return leg(
      'duty-officer-reports',
      'failed',
      ['do_flagged_canary_stale'],
      [`run_id=${input.runId}`, 'flagged_stale=true']
    );
  }
  return leg(
    'duty-officer-reports',
    'passed',
    [],
    [`run_id=${input.runId}`, 'report_mentions_run=true', 'flagged_stale=false']
  );
}

export async function checkLeg10CanaryReverts(input: {
  readonly source: Pick<LifecycleArtifactSource, 'scratchResidueDiff' | 'countRevertCommits'>;
  readonly baseBranch: string;
  readonly runId: string;
  // Base-branch revision captured BEFORE the run mutated anything.
  readonly preRunRevision: string;
  readonly poll: LegPollConfig;
  // Performs the actual revert. Invoked here -- not merely observed -- so Leg 10
  // grades the outcome of a real cleanup operation (Invariant 3).
  readonly cleanup?: () => Promise<void>;
  // Bounds each residue-check attempt so a single hung artifact-source call
  // (scratchResidueDiff/countRevertCommits) cannot hang Leg 10 indefinitely.
  // Defaults to the leg's own poll timeoutMs.
  readonly attemptTimeoutMs?: number;
}): Promise<LifecycleLegReport> {
  let cleanupError: string | undefined;
  if (input.cleanup) {
    try {
      await input.cleanup();
    } catch (error) {
      cleanupError = (error as Error).message;
    }
  }
  const cleanupEvidence = cleanupError
    ? `cleanup=failed:${cleanupError}`
    : `cleanup=${input.cleanup ? 'ran' : 'not_configured'}`;

  const { clock, timeoutMs, intervalMs } = input.poll;
  const attemptTimeoutMs = input.attemptTimeoutMs ?? timeoutMs;
  const result = await pollUntil(
    clock,
    timeoutMs,
    intervalMs,
    (): Promise<{
      satisfied: boolean;
      value: { diff: string; reverts: number };
    }> =>
      withTimeout(
        (async (): Promise<{ satisfied: boolean; value: { diff: string; reverts: number } }> => {
          const diff = await input.source.scratchResidueDiff(
            input.baseBranch,
            input.preRunRevision
          );
          const reverts = await input.source.countRevertCommits(input.runId);
          // Clean when the base branch's scratch path is byte-identical to its
          // pre-run revision.
          const clean = diff.trim().length === 0;
          return { satisfied: clean, value: { diff, reverts } };
        })(),
        attemptTimeoutMs,
        'leg10-residue-check'
      )
  );
  const { diff, reverts } = result.value;

  if (cleanupError) {
    // The revert operation itself errored: fail closed even if residue reads
    // clean, because the cleanup path is unproven.
    return leg(
      'canary-reverts',
      'failed',
      ['canary_cleanup_failed'],
      [
        cleanupEvidence,
        `scratch_residue_diff_bytes=${diff.trim().length}`,
        `revert_commits=${reverts}`,
      ]
    );
  }
  if (diff.trim().length === 0) {
    return leg(
      'canary-reverts',
      'passed',
      [],
      ['scratch_residue_diff=empty', `revert_commits=${reverts}`, cleanupEvidence]
    );
  }
  // Highest-severity class: the canary polluted the shared base branch.
  return leg(
    'canary-reverts',
    'failed',
    ['canary_left_residue_on_dev'],
    [
      `scratch_residue_diff_bytes=${diff.trim().length}`,
      `revert_commits=${reverts}`,
      cleanupEvidence,
    ]
  );
}

// Invariant 2: the merged PR diff must touch ONLY the canary scratch path.
export async function checkInvariantDiffScope(input: {
  readonly source: Pick<LifecycleArtifactSource, 'listPrChangedFiles'>;
  readonly prNumber: number;
  readonly scratchDir: string;
}): Promise<{ violated: boolean; offendingFiles: readonly string[] }> {
  const files = await input.source.listPrChangedFiles(input.prNumber);
  const root = input.scratchDir.replace(/\/+$/, '');
  const prefix = `${root}/`;
  const offending = files.filter(file => {
    const normalized = file.replaceAll('\\', '/');
    // A bare prefix test would accept sibling paths such as "<root>-evil/x.ts",
    // so require the "/" boundary separator explicitly.
    if (!normalized.startsWith(prefix)) return true;
    // Reject any traversal segment that could escape the scratch directory.
    return normalized
      .slice(prefix.length)
      .split('/')
      .some(segment => segment === '..');
  });
  return { violated: offending.length > 0, offendingFiles: offending };
}

// ---------------------------------------------------------------------------
// Suite orchestration
// ---------------------------------------------------------------------------

export interface LifecycleFireResult {
  readonly issueNumber?: number;
  readonly prNumber?: number;
  readonly headBranch: string;
  readonly fallbackUsed: boolean;
  // Remediation commit metadata, populated by the run harness once the
  // remediation lands (auto or manual/subagent path).
  readonly remediationSha?: string;
  readonly remediationCommitIso?: string;
  // Dispatch message id sent during the run for Leg 8.
  readonly dispatchMessageId?: string;
}

export interface LifecycleTimeouts {
  readonly leg1Ms: number;
  readonly leg2Ms: number;
  readonly leg3Ms: number;
  readonly leg4Ms: number;
  readonly leg5Ms: number;
  readonly leg6Ms: number;
  readonly leg7Ms: number;
  readonly leg8Ms: number;
  readonly leg9Ms: number;
  readonly leg10Ms: number;
}

export const DEFAULT_LIFECYCLE_TIMEOUTS: LifecycleTimeouts = {
  leg1Ms: 10 * 60_000,
  leg2Ms: 20 * 60_000,
  leg3Ms: 15 * 60_000,
  leg4Ms: 15 * 60_000,
  leg5Ms: 15 * 60_000,
  leg6Ms: 10 * 60_000,
  leg7Ms: 5 * 60_000,
  leg8Ms: 5 * 60_000,
  leg9Ms: 30 * 60_000,
  leg10Ms: 15 * 60_000,
};

export interface LifecycleCanaryDeps {
  readonly runId: string;
  readonly githubRepo: string;
  readonly baseBranch: string;
  readonly source: LifecycleArtifactSource;
  // Creates the canary issue/branch and returns the initial coordinates. MUST
  // NOT invoke the fire.ps1 fallback -- the suite waits out the Leg 1
  // Taskmaster window itself and only then escalates via fireFallback.
  readonly initiate: () => Promise<LifecycleFireResult>;
  // Invoked ONLY after the Leg 1 Taskmaster window elapses with no
  // fire_cauldron row. Returns any coordinates the fallback path discovered.
  readonly fireFallback?: () => Promise<Partial<LifecycleFireResult>>;
  // Reverts the canary's scratch changes. Always invoked before Leg 10 grades
  // residue, including after an upstream exception (Invariant 3).
  readonly cleanup?: () => Promise<void>;
  // Base-branch revision captured BEFORE the run mutated anything. Leg 10
  // anchors residue detection to this rather than the moving base tip.
  readonly preRunRevision: string;
  readonly clock?: LifecycleClock;
  readonly timeouts?: LifecycleTimeouts;
  readonly pollIntervalMs?: number;
  readonly runStartIso: string;
  readonly mergeIdentity: string;
  readonly humanLogins?: readonly string[];
  readonly autoRemediationAvailable?: boolean;
  readonly defectSignature?: string;
  readonly plantedLiteral?: string;
  readonly scratchDir?: string;
  readonly dispatchExpectedSubstring?: string;
  readonly staleFlagMarkers?: readonly string[];
  // Wall-clock ceiling on each leg's execution (independent of that leg's own
  // poll timeoutMs -- this bounds the whole leg, including a hung
  // artifact-source call inside the poll loop). Defaults to
  // DEFAULT_LEG_WALL_CLOCK_TIMEOUT_MS.
  readonly legWallClockTimeoutMs?: number;
  // Wall-clock ceiling on cleanup() inside Leg 10, so a hanging revert cannot
  // hang the whole process. Defaults to DEFAULT_CLEANUP_TIMEOUT_MS.
  readonly cleanupTimeoutMs?: number;
}

// A leg's own poll timeoutMs governs how long it waits for a condition to
// become true; this is the OUTER ceiling on the leg's entire execution
// (including a single hung underlying call), corresponding to
// --leg-timeout-ms on the CLI. Default: 20 minutes.
export const DEFAULT_LEG_WALL_CLOCK_TIMEOUT_MS = 20 * 60_000;
// Ceiling on the Leg 10 cleanup() call, corresponding to --cleanup-timeout-ms
// on the CLI. Default: 5 minutes.
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5 * 60_000;

function overallVerdict(
  legs: readonly LifecycleLegReport[],
  invariantViolations: readonly string[]
): CanaryVerdict {
  if (invariantViolations.length > 0) return 'failed';
  if (legs.some(l => l.verdict === 'failed')) return 'failed';
  if (legs.some(l => l.verdict === 'blocked')) return 'blocked';
  return 'passed';
}

export async function runLifecycleCanarySuite(
  deps: LifecycleCanaryDeps
): Promise<LifecycleCanaryReport> {
  const clock = deps.clock ?? realClock;
  const timeouts = deps.timeouts ?? DEFAULT_LIFECYCLE_TIMEOUTS;
  const intervalMs = deps.pollIntervalMs ?? 30_000;
  const scratchDir = deps.scratchDir ?? LIFECYCLE_SCRATCH_DIR;
  const plantedLiteral = deps.plantedLiteral ?? LIFECYCLE_PLANTED_DEFECT_LITERAL;
  const defectSignature = deps.defectSignature ?? plantedLiteral;
  const source = deps.source;
  const poll = (timeoutMs: number): LegPollConfig => ({ clock, timeoutMs, intervalMs });
  const legWallClockMs = deps.legWallClockTimeoutMs ?? DEFAULT_LEG_WALL_CLOCK_TIMEOUT_MS;
  const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  // Bounds every leg step (including deps.initiate/fireFallback) by the outer
  // per-leg wall-clock ceiling so a single hung underlying call cannot hang
  // the whole suite, regardless of that step's own poll timeoutMs.
  const bounded = <T>(label: string, promise: Promise<T>): Promise<T> =>
    withTimeout(promise, legWallClockMs, label);

  const legs: LifecycleLegReport[] = [];
  const invariantViolations: string[] = [];

  let fired: LifecycleFireResult = { headBranch: '', fallbackUsed: false };
  let orchestrationError: Error | undefined;

  try {
    fired = await bounded('initiate', deps.initiate());

    // Leg 1 -- wait out the Taskmaster window FIRST; escalate to the documented
    // fire.ps1 fallback only after it elapses with no fire_cauldron row.
    let leg1 = await bounded(
      'leg1-taskmaster-fire',
      checkLeg1TaskmasterFires({
        source,
        sinceIso: deps.runStartIso,
        targetIssue: fired.issueNumber,
        fallbackUsed: false,
        poll: poll(timeouts.leg1Ms),
      })
    );
    if (leg1.verdict !== 'passed' && deps.fireFallback) {
      const fallback = await bounded('leg1-fire-fallback', deps.fireFallback());
      fired = {
        ...fired,
        issueNumber: fallback.issueNumber ?? fired.issueNumber,
        prNumber: fallback.prNumber ?? fired.prNumber,
        headBranch: fallback.headBranch ?? fired.headBranch,
        remediationSha: fallback.remediationSha ?? fired.remediationSha,
        remediationCommitIso: fallback.remediationCommitIso ?? fired.remediationCommitIso,
        dispatchMessageId: fallback.dispatchMessageId ?? fired.dispatchMessageId,
        fallbackUsed: true,
      };
      leg1 = { ...leg1, gap: 'taskmaster-never-fired, fallback: fire.ps1 used' };
    }
    legs.push(leg1);

    // Leg 2
    const leg2 = await bounded(
      'leg2-codex-lane-build-pr',
      checkLeg2CodexLaneOpensPr({
        source,
        headBranch: fired.headBranch,
        baseBranch: deps.baseBranch,
        poll: poll(timeouts.leg2Ms),
      })
    );
    legs.push(leg2.report);
    const prNumber = leg2.prNumber ?? fired.prNumber;

    if (prNumber === undefined) {
      // No PR: legs 3-9 cannot proceed against a real PR. Report them blocked
      // (honest, never a false pass), then still run Leg 10 cleanup independently.
      legs.push(upstreamBlocked('overseer-catch-defect', 'no_pr'));
      legs.push(upstreamBlocked('remediation-reaches-pr', 'no_pr'));
      legs.push(upstreamBlocked('overseer-reapprove', 'no_pr'));
      legs.push(upstreamBlocked('autonomous-merge', 'no_pr'));
      legs.push(upstreamBlocked('reconcile-closes-issue', 'no_pr'));
    } else {
      // Leg 3
      legs.push(
        await bounded(
          'leg3-overseer-catch-defect',
          checkLeg3OverseerCatchesDefect({
            source,
            prNumber,
            defectSignature,
            poll: poll(timeouts.leg3Ms),
          })
        )
      );

      // Leg 4
      const leg4 = await bounded(
        'leg4-remediation-reaches-pr',
        checkLeg4RemediationReachesPr({
          source,
          prNumber,
          literal: plantedLiteral,
          autoRemediationAvailable: deps.autoRemediationAvailable ?? false,
          poll: poll(timeouts.leg4Ms),
        })
      );
      legs.push(leg4);

      // Leg 5 needs the REAL post-remediation head, not the sha captured at
      // initiation (or by the Leg-1 fallback) -- both predate Legs 2-4, so by
      // the time remediation lands on the PR those values are stale and Leg 5
      // would otherwise report a false "no_remediation_commit" block on every
      // live run. Once Leg 4 confirms remediation reached the PR, refresh the
      // head sha + its commit timestamp from the live PR and use THAT for Leg 5.
      if (leg4.verdict === 'passed') {
        try {
          const head = await bounded('leg4-refresh-pr-head', source.getPrHead(prNumber));
          fired = { ...fired, remediationSha: head.sha, remediationCommitIso: head.committedAtIso };
        } catch {
          // Refresh failed: fall through to whatever fired.remediationSha/
          // remediationCommitIso already holds (initiate/fallback value, if
          // any) rather than aborting the whole suite over a read failure.
        }
      }

      // Leg 5
      if (fired.remediationSha && fired.remediationCommitIso) {
        legs.push(
          await bounded(
            'leg5-overseer-reapprove',
            checkLeg5OverseerReapproves({
              source,
              prNumber,
              remediationSha: fired.remediationSha,
              remediationCommitIso: fired.remediationCommitIso,
              poll: poll(timeouts.leg5Ms),
            })
          )
        );
      } else {
        legs.push(upstreamBlocked('overseer-reapprove', 'no_remediation_commit'));
      }

      // Invariant 2 (diff scope) gates merge acceptance.
      const scope = await bounded(
        'invariant-diff-scope',
        checkInvariantDiffScope({ source, prNumber, scratchDir })
      );
      if (scope.violated) {
        invariantViolations.push(`canary_diff_scope_violation: ${scope.offendingFiles.join(', ')}`);
      }

      // Leg 6
      legs.push(
        await bounded(
          'leg6-autonomous-merge',
          checkLeg6AutonomousMerge({
            source,
            prNumber,
            mergeIdentity: deps.mergeIdentity,
            humanLogins: deps.humanLogins ?? [],
            poll: poll(timeouts.leg6Ms),
          })
        )
      );

      // Leg 7
      if (fired.issueNumber !== undefined) {
        legs.push(
          await bounded(
            'leg7-reconcile-closes-issue',
            checkLeg7ReconcileClosesIssue({
              source,
              issueNumber: fired.issueNumber,
              poll: poll(timeouts.leg7Ms),
            })
          )
        );
      } else {
        legs.push(upstreamBlocked('reconcile-closes-issue', 'no_issue'));
      }
    }

    // Leg 8
    if (fired.dispatchMessageId) {
      legs.push(
        await bounded(
          'leg8-dispatch-readable-reply',
          checkLeg8DispatchReadableReply({
            source,
            messageId: fired.dispatchMessageId,
            expectedSubstring: deps.dispatchExpectedSubstring ?? deps.runId,
            poll: poll(timeouts.leg8Ms),
          })
        )
      );
    } else {
      legs.push(upstreamBlocked('dispatch-readable-reply', 'no_dispatch_message'));
    }

    // Leg 9
    legs.push(
      await bounded(
        'leg9-duty-officer-reports',
        checkLeg9DutyOfficerReports({
          source,
          runId: deps.runId,
          staleFlagMarkers: deps.staleFlagMarkers ?? [],
          poll: poll(timeouts.leg9Ms),
        })
      )
    );
  } catch (error) {
    orchestrationError = error as Error;
  }

  // Leg 10 -- cleanup on an independent, bounded timeout. ALWAYS runs, including
  // after an upstream exception or a leg timeout, so the canary never leaves
  // residue (Invariant 3). The cleanup call itself is wrapped so a hanging
  // revert cannot hang the whole process; whatever it could not accomplish is
  // reported as a failed Leg 10 rather than swallowed or left hanging.
  try {
    legs.push(
      await checkLeg10CanaryReverts({
        source,
        baseBranch: deps.baseBranch,
        runId: deps.runId,
        preRunRevision: deps.preRunRevision,
        cleanup: ((): (() => Promise<void>) | undefined => {
          const cleanupFn = deps.cleanup;
          return cleanupFn
            ? (): Promise<void> => withTimeout(cleanupFn(), cleanupTimeoutMs, 'leg10-cleanup')
            : undefined;
        })(),
        poll: poll(timeouts.leg10Ms),
        attemptTimeoutMs: legWallClockMs,
      })
    );
  } catch (error) {
    legs.push(
      leg(
        'canary-reverts',
        'failed',
        ['canary_cleanup_threw'],
        [`error=${(error as Error).message}`]
      )
    );
  }

  if (orchestrationError) {
    invariantViolations.push(`canary_orchestration_error: ${orchestrationError.message}`);
  }

  // Order legs canonically for the report.
  const ordered = LIFECYCLE_LEGS.map(
    def => legs.find(l => l.legId === def.id) ?? upstreamBlocked(def.id, 'not_run')
  );

  return {
    schemaVersion: 1,
    suiteRunId: deps.runId,
    generatedAt: deps.runStartIso,
    verdict: overallVerdict(ordered, invariantViolations),
    reasonCodes: [...new Set(ordered.flatMap(l => l.reasonCodes))],
    invariantViolations,
    legs: ordered,
  };
}

// ---------------------------------------------------------------------------
// Default artifact source (shells out; runs only in the live phase)
// ---------------------------------------------------------------------------

async function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// Captures the base-branch tip. Read-only: it must be called BEFORE any canary
// mutation so Leg 10 has a trustworthy residue anchor.
export async function resolveBaseRevision(repoDir: string, baseBranch: string): Promise<string> {
  await runCommand('git', ['fetch', 'origin', baseBranch], repoDir);
  const { stdout, exitCode } = await runCommand(
    'git',
    ['rev-parse', `origin/${baseBranch}`],
    repoDir
  );
  if (exitCode !== 0 || stdout.trim().length === 0) {
    throw new Error(`lifecycle_canary_cannot_resolve_base_revision: origin/${baseBranch}`);
  }
  return stdout.trim();
}

// The mutating side of a live run, kept separate from the read-only artifact
// source. Supplying these is what makes a run production-adjacent (it opens a
// real issue/PR against the base branch), so the CLI never defaults them.
export interface LifecycleMutationHooks {
  readonly initiate: LifecycleCanaryDeps['initiate'];
  readonly fireFallback?: LifecycleCanaryDeps['fireFallback'];
  readonly cleanup?: LifecycleCanaryDeps['cleanup'];
}

export interface DefaultArtifactSourceConfig {
  readonly dbPath: string;
  readonly githubRepo: string;
  readonly repoDir: string;
  readonly scratchDir: string;
  readonly dutyOfficerReportPath: string | null;
}

function queryRows<T>(dbPath: string, sql: string, params: readonly SQLQueryBindings[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

export function createDefaultArtifactSource(
  config: DefaultArtifactSourceConfig
): LifecycleArtifactSource {
  const repo = config.githubRepo;
  // Arrow-function properties in a contextually-typed object literal so each
  // method inherits its signature from LifecycleArtifactSource.
  return {
    queryTmJournalFireCauldron: async sinceIso =>
      queryRows<TmJournalFireRow>(
        config.dbPath,
        "SELECT id, proposal_type, target, created_at FROM tm_journal WHERE proposal_type = 'fire_cauldron' AND created_at > ? ORDER BY id DESC LIMIT 10",
        [sinceIso]
      ),
    listPrsForBranch: async (headBranch): Promise<PrSummary[]> => {
      const { stdout } = await runCommand('gh', [
        'pr',
        'list',
        '--repo',
        repo,
        '--head',
        headBranch,
        '--state',
        'all',
        '--json',
        'number,headRefName,baseRefName,state',
      ]);
      return JSON.parse(stdout || '[]') as PrSummary[];
    },
    viewPr: async (prNumber): Promise<PrView> => {
      const { stdout } = await runCommand('gh', [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,state,mergedBy,commits,mergeCommit',
      ]);
      const raw = JSON.parse(stdout || '{}') as {
        number?: number;
        state?: string;
        mergedBy?: { login?: string } | null;
        commits?: unknown[];
        mergeCommit?: { oid?: string } | null;
      };
      return {
        number: raw.number ?? prNumber,
        state: raw.state ?? 'UNKNOWN',
        mergedByLogin: raw.mergedBy?.login ?? null,
        commitCount: Array.isArray(raw.commits) ? raw.commits.length : 0,
        mergeCommitOid: raw.mergeCommit?.oid ?? null,
      };
    },
    listPrReviews: async (prNumber): Promise<PrReview[]> => {
      const { stdout } = await runCommand('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews`]);
      const raw = JSON.parse(stdout || '[]') as {
        state?: string;
        body?: string;
        submitted_at?: string;
        user?: { login?: string };
        commit_id?: string;
      }[];
      return raw.map(review => ({
        state: review.state ?? 'UNKNOWN',
        body: review.body ?? '',
        submittedAt: review.submitted_at ?? '',
        authorLogin: review.user?.login ?? '',
        commitId: review.commit_id ?? '',
      }));
    },
    countDiffMatches: async (prNumber, literal): Promise<number> => {
      const { stdout } = await runCommand('gh', ['pr', 'diff', String(prNumber), '--repo', repo]);
      // Count only added lines that still contain the literal.
      return stdout
        .split('\n')
        .filter(line => line.startsWith('+') && !line.startsWith('+++') && line.includes(literal))
        .length;
    },
    queryRunReview: async headSha =>
      queryRows<RunReviewRow>(
        config.dbPath,
        'SELECT head_sha, action, created_at FROM run_review WHERE head_sha = ? ORDER BY created_at DESC LIMIT 10',
        [headSha]
      ),
    mergedActorLogin: async (prNumber): Promise<string | null> => {
      const { stdout } = await runCommand('gh', [
        'api',
        `repos/${repo}/issues/${prNumber}/timeline`,
      ]);
      const events = JSON.parse(stdout || '[]') as {
        event?: string;
        actor?: { login?: string };
      }[];
      const merged = events.find(event => event.event === 'merged');
      return merged?.actor?.login ?? null;
    },
    viewIssue: async (issueNumber): Promise<IssueView> => {
      const { stdout } = await runCommand('gh', [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'number,state,stateReason',
      ]);
      const raw = JSON.parse(stdout || '{}') as {
        number?: number;
        state?: string;
        stateReason?: string | null;
      };
      return {
        number: raw.number ?? issueNumber,
        // gh returns state as OPEN/CLOSED (uppercase) for --json state.
        state: (raw.state ?? 'UNKNOWN').toUpperCase(),
        stateReason: raw.stateReason ?? null,
      };
    },
    dispatchResultBody: async (messageId): Promise<string | null> => {
      const rows = queryRows<{ result_body: string | null }>(
        config.dbPath,
        'SELECT result_body FROM agent_dispatch_messages WHERE id = ? LIMIT 1',
        [messageId]
      );
      return rows[0]?.result_body ?? null;
    },
    readDutyOfficerReport: async (): Promise<string> => {
      if (!config.dutyOfficerReportPath) return '';
      try {
        return await Bun.file(config.dutyOfficerReportPath).text();
      } catch {
        return '';
      }
    },
    scratchResidueDiff: async (baseBranch, preRunRevision): Promise<string> => {
      // Refresh the remote ref so the comparison sees the post-run base tip.
      // A missing remote, auth failure, or other git error here must fail the
      // check CLOSED (throw), never fall through to an empty-stdout "clean"
      // read -- Leg 10 is the safety-critical guard against residue on the
      // shared base branch.
      const fetchResult = await runCommand('git', ['fetch', 'origin', baseBranch], config.repoDir);
      if (fetchResult.exitCode !== 0) {
        throw new Error(
          `lifecycle_canary_scratch_residue_fetch_failed: exitCode=${fetchResult.exitCode} stderr=${fetchResult.stderr.trim()}`
        );
      }
      const diffResult = await runCommand(
        'git',
        ['diff', preRunRevision, `origin/${baseBranch}`, '--', config.scratchDir],
        config.repoDir
      );
      if (diffResult.exitCode !== 0) {
        throw new Error(
          `lifecycle_canary_scratch_residue_diff_failed: exitCode=${diffResult.exitCode} stderr=${diffResult.stderr.trim()}`
        );
      }
      if (diffResult.stderr.trim().length > 0) {
        throw new Error(
          `lifecycle_canary_scratch_residue_diff_stderr: ${diffResult.stderr.trim()}`
        );
      }
      return diffResult.stdout;
    },
    countRevertCommits: async (runId): Promise<number> => {
      const { stdout } = await runCommand(
        'git',
        ['log', '--oneline', `--grep=canary/lifecycle-${runId} revert`],
        config.repoDir
      );
      return stdout.split('\n').filter(line => line.trim().length > 0).length;
    },
    listPrChangedFiles: async (prNumber): Promise<string[]> => {
      const { stdout } = await runCommand('gh', [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'files',
      ]);
      const raw = JSON.parse(stdout || '{}') as { files?: { path?: string }[] };
      return (raw.files ?? []).map(file => file.path ?? '').filter(path => path.length > 0);
    },
    getPrHead: async (prNumber): Promise<{ sha: string; committedAtIso: string }> => {
      const { stdout, exitCode, stderr } = await runCommand('gh', [
        'api',
        `repos/${repo}/pulls/${prNumber}`,
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `lifecycle_canary_get_pr_head_failed: exitCode=${exitCode} stderr=${stderr.trim()}`
        );
      }
      const raw = JSON.parse(stdout || '{}') as {
        head?: { sha?: string };
      };
      const sha = raw.head?.sha;
      if (!sha) {
        throw new Error('lifecycle_canary_get_pr_head_no_sha');
      }
      // The head commit's own author/committer date, not the PR's updated_at,
      // so Leg 5's Date.parse comparison anchors to the commit that actually
      // carries the remediation.
      const {
        stdout: commitStdout,
        exitCode: commitExitCode,
        stderr: commitStderr,
      } = await runCommand('gh', ['api', `repos/${repo}/commits/${sha}`]);
      if (commitExitCode !== 0) {
        throw new Error(
          `lifecycle_canary_get_pr_head_commit_failed: exitCode=${commitExitCode} stderr=${commitStderr.trim()}`
        );
      }
      const commitRaw = JSON.parse(commitStdout || '{}') as {
        commit?: { committer?: { date?: string }; author?: { date?: string } };
      };
      const committedAtIso =
        commitRaw.commit?.committer?.date ?? commitRaw.commit?.author?.date ?? '';
      if (!committedAtIso) {
        throw new Error('lifecycle_canary_get_pr_head_no_commit_date');
      }
      return { sha, committedAtIso };
    },
  };
}
