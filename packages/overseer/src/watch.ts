import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { createLogger } from '@archon/paths';
import { classifyError } from './classify';
import { decide } from './decide';
import { isPrMergeReady, isPrGreen, judgePullRequest } from './judge-pr';
import {
  discoverMergeCandidates,
  pullRequestKey,
  summarizeExclusions,
  type DiscoverMergeCandidatesOptions,
  type MergeCandidateDiscoveryResult,
} from './merge-candidate-discovery';
import type {
  GitHubClientDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

const log = createLogger('overseer/watch');

export const DEFAULT_WATCH_INTERVAL_MS = 60_000;
export const DEFAULT_WATCH_MAX_RUNS_PER_TICK = 25;

// The store retains every non-merged action, so an oldest-first slice would
// retry the same rows forever. A single watcher evaluates every terminal row
// once before beginning another pass.
const evaluatedRunIdsThisPass = new Set<string>();

export function resolveWatchMaxRunsPerTick(
  raw = process.env.OVERSEER_WATCH_MAX_RUNS_PER_TICK
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WATCH_MAX_RUNS_PER_TICK;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_WATCH_MAX_RUNS_PER_TICK;
}

/**
 * M-42 Slice 8 integration marker: single-watcher ownership for the
 * integrated candidate. Runtime still starts at most one watcher task.
 */
export const SLICE8_WATCHER_OWNERSHIP = 'single_watcher_fail_closed' as const;

function isTerminalStatus(status: string): status is WorkflowRunStatus {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

function newestEvent(events: OverseerWorkflowEvent[]): OverseerWorkflowEvent | undefined {
  return [...events].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')).at(-1);
}

function failedNodeIds(event: OverseerWorkflowEvent | undefined): string[] {
  const failedNodes = event?.data.failed_nodes;
  return Array.isArray(failedNodes)
    ? failedNodes.filter((nodeId): nodeId is string => typeof nodeId === 'string')
    : [];
}

export function selectFailureEvent(
  events: OverseerWorkflowEvent[]
): OverseerWorkflowEvent | undefined {
  const nodeFailedEvents = events.filter(event => event.event_type === 'node_failed');
  const workflowFailedEvent = newestEvent(
    events.filter(event => event.event_type === 'workflow_failed')
  );

  if (nodeFailedEvents.length > 0) {
    const [authoritativeFailedNode] = failedNodeIds(workflowFailedEvent);
    if (authoritativeFailedNode) {
      const matchingEvent = nodeFailedEvents.find(
        event => event.step_name === authoritativeFailedNode
      );
      if (matchingEvent) return matchingEvent;
    }
    return newestEvent(nodeFailedEvents);
  }

  if (workflowFailedEvent) return workflowFailedEvent;

  return newestEvent(events);
}

function eventMessage(event: OverseerWorkflowEvent | undefined): string {
  if (!event) return '';
  const data = event.data;
  const candidates = [data.error, data.message, data.stderr, data.output, data.reason];
  const found = candidates.find(value => typeof value === 'string');
  return typeof found === 'string' ? found : JSON.stringify(data);
}

/**
 * Say why a PR is not merge-ready without claiming more than was established.
 * "no PR" is only honest when the lookup actually ran and found nothing; when the
 * lookup broke, or the run carries no branch/WO identity to look it up by, the
 * truthful answer is that we do not know.
 */
function prNotMergeReadyDetail(evidence: PullRequestEvidence): string {
  if (evidence.exists) {
    return `state=${evidence.state} mergeable=${String(evidence.mergeable)}`;
  }
  if (evidence.lookupFailed) return 'PR lookup failed -- existence unknown';
  return 'no PR';
}

/**
 * Recover a run's head branch from its own events.
 *
 * Runs do not record their git identity: the engine writes only cost/token telemetry
 * into run metadata, so `headBranch` is absent on every terminal run in the live store.
 * The commit-and-push node does report its final target as `unique_branch=<name>`, which
 * makes the branch recoverable after the fact. Same signal smart-cauldron's
 * findExistingPrForBranch reads (poll.ts). Last writer wins -- a run may push more than
 * once, and the final push is the one a PR would be open against.
 *
 * Returns undefined when no event reports a branch. Absent stays absent.
 */
export function recoverHeadBranchFromEvents(events: OverseerWorkflowEvent[]): string | undefined {
  let branch: string | undefined;
  for (const event of events) {
    const output = typeof event.data.output === 'string' ? event.data.output : '';
    const match = /unique_branch=(\S+)/.exec(output);
    if (match?.[1]) branch = match[1];
  }
  return branch;
}

async function assessRun(
  run: OverseerRunRecord,
  deps: OverseerRunStoreDeps & GitHubClientDeps
): Promise<WatchedRunRecord> {
  if (!run.headBranch) {
    const recovered = recoverHeadBranchFromEvents(await deps.listRunEvents(run.id));
    if (recovered) run = { ...run, headBranch: recovered };
  }
  const prEvidence = await judgePullRequest(run, deps);

  if (prEvidence.state === 'merged') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      workingPath: run.workingPath,
      metadata: run.metadata,
      action: 'success',
      reason: 'PR is already merged; judging run successful by PR evidence',
      prEvidence,
    };
  }

  // THE MERGE DOOR. Any terminal run whose PR is green, open and mergeable is a
  // merge candidate -- regardless of the run's own status.
  //
  // This used to be gated on `status === 'failed'` alone, because the merge path was
  // built for exactly ONE scenario: the tail-node false-fail (run reports failure, PR
  // is actually fine). That scope assumption was never revisited when Overseer became
  // the merge steward, and it is why Overseer had merged NOTHING, ever -- verified
  // 2026-07-25 against the live event store: 57 overseer_actions, zero merge-class,
  // while 468 terminal runs sat in the watch queue (388 completed, 58 cancelled,
  // 22 escalated, ZERO failed). Every one of them walked past a door marked
  // "failed runs only".
  //
  // The status is not what makes a PR safe to merge -- the PR evidence is. So the
  // gate is isPrMergeReady (exists && open && mergeable && green), applied uniformly.
  // Every downstream guard still applies: merge provenance binds the PR to the run
  // that produced it, Grok judges the diff, and production-effect merges stay held
  // for John.
  //
  // On CANCELLED specifically: the conductor cancels on stall/runaway and then EXITS
  // (it is a CLI process), so work it already pushed has no owner. Anchor: run
  // 3ff3f773 was cancelled having produced a real commit, and the live log shows
  // Overseer reading it and returning action:"ignore". Detection stays with the
  // conductor; salvage belongs to Overseer, the persistent watcher.
  if (isPrMergeReady(prEvidence)) {
    const reason =
      run.status === 'cancelled'
        ? 'cancelled run left a green, mergeable PR -- salvaging orphaned work'
        : `terminal status ${run.status} with a green, mergeable PR -- merge candidate`;
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      workingPath: run.workingPath,
      metadata: run.metadata,
      errorClass: run.status === 'failed' ? 'tail_node_false_fail' : undefined,
      action: 'merge_ready',
      reason,
      prEvidence,
      decision: { decision: 'merge_ready', reason },
    };
  }

  if (run.status !== 'failed') {
    return {
      runId: run.id,
      woId: run.woId,
      repo: run.repo,
      owner: run.owner,
      status: run.status,
      headBranch: run.headBranch,
      workingPath: run.workingPath,
      metadata: run.metadata,
      // Reached only when the PR is NOT merge-ready (the door above already took
      // every green+mergeable case). A completed run with a green-but-unmergeable PR
      // -- e.g. conflicting, or draft -- is still a success; anything else is noise.
      action: run.status === 'completed' && isPrGreen(prEvidence) ? 'success' : 'ignore',
      reason:
        run.status === 'completed'
          ? `completed run; PR not merge-ready (${prNotMergeReadyDetail(prEvidence)})`
          : `terminal status ${run.status} with no merge-ready PR`,
      prEvidence,
    };
  }

  // (The former failed-only merge_ready block lived here. It is now redundant: the
  // merge door above handles every terminal status uniformly, including failed runs
  // with green PRs -- the original tail-node false-fail case -- and still tags them
  // errorClass: 'tail_node_false_fail'.)

  const events = await deps.listRunEvents(run.id);
  const lastEvent = selectFailureEvent(events);
  const errorClass = classifyError({
    message: eventMessage(lastEvent),
    nodeId: lastEvent?.step_name ?? undefined,
    exitCode: typeof lastEvent?.data.exitCode === 'number' ? lastEvent.data.exitCode : undefined,
  });
  const decision = decide({
    errorClass,
    attempt: 1,
    nodeId: lastEvent?.step_name ?? undefined,
    woId: run.woId,
  });

  return {
    runId: run.id,
    woId: run.woId,
    repo: run.repo,
    owner: run.owner,
    status: run.status,
    headBranch: run.headBranch,
    workingPath: run.workingPath,
    metadata: run.metadata,
    errorClass,
    action: 'escalate',
    reason: decision.reason,
    prEvidence,
    decision,
    lastEvent,
  };
}

/**
 * Minimal logger seam for the per-cycle heartbeat. The pino Logger returned by
 * createLogger satisfies it structurally, so production passes nothing and uses the
 * module logger; tests inject a spy to assert the heartbeat fired without a
 * process-global mock.module() (see CLAUDE.md mock-isolation rules).
 */
export interface WatchHeartbeatLogger {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface WatchOnceOptions {
  /** Injected logger for the heartbeat line; defaults to the module logger. */
  logger?: WatchHeartbeatLogger;
  /** Oldest-first per-tick cap; defaults to OVERSEER_WATCH_MAX_RUNS_PER_TICK (25). */
  maxRunsPerTick?: number;
  /**
   * PR-first discovery options (bdc-harness#758). Passed straight through to
   * discoverMergeCandidates; tests supply explicit repos/bases so the sweep is
   * deterministic without touching process.env.
   */
  discovery?: DiscoverMergeCandidatesOptions;
  /** Set false to skip the PR-first sweep entirely (used by narrow unit tests). */
  discoveryEnabled?: boolean;
}

/**
 * Which pull requests the run-derived pass already covered this tick, so the
 * PR-first sweep can report them as `already_a_run_candidate` instead of
 * building a second, competing record for the same PR.
 */
function coveredPullRequests(outcomes: readonly WatchedRunRecord[]): Set<string> {
  const covered = new Set<string>();
  for (const outcome of outcomes) {
    const pr = outcome.prEvidence?.pr;
    if (pr) covered.add(pullRequestKey(pr.owner, pr.repo, pr.number));
  }
  return covered;
}

export async function watchOnce(
  deps: OverseerRunStoreDeps & GitHubClientDeps,
  options: WatchOnceOptions = {}
): Promise<WatchedRunRecord[]> {
  const heartbeatLogger: WatchHeartbeatLogger = options.logger ?? log;
  const runs = await deps.listRunsForWatch();
  // listRunsForWatch is oldest-first. Filter non-terminal rows, then continue the
  // current fair pass so permanently unmerged old rows cannot hide later work.
  const maxRunsPerTick = options.maxRunsPerTick ?? resolveWatchMaxRunsPerTick();
  const allTerminalRuns = runs.filter(run => isTerminalStatus(run.status));
  let unevaluatedRuns = allTerminalRuns.filter(run => !evaluatedRunIdsThisPass.has(run.id));
  if (unevaluatedRuns.length === 0 && allTerminalRuns.length > 0) {
    evaluatedRunIdsThisPass.clear();
    unevaluatedRuns = allTerminalRuns;
  }
  const terminalRuns = unevaluatedRuns.slice(0, maxRunsPerTick);
  for (const run of terminalRuns) evaluatedRunIdsThisPass.add(run.id);
  const outcomes: WatchedRunRecord[] = [];
  for (const run of terminalRuns) {
    // Per-run isolation (bdc-xo#1366): assessRun calls out to GitHub (judgePullRequest)
    // and that call can throw (timeout, HttpError) instead of returning evidence. Before
    // this try/catch, that exception propagated out of watchOnce, out of watchLoop's
    // for(;;) body, and killed the entire watcher for every other run in the batch and
    // every future tick -- exactly the failure class #1348 already fixed one level
    // downstream in handleRecord. One bad run's lookup must never take down the watcher.
    try {
      outcomes.push(await assessRun(run, deps));
    } catch (error) {
      log.error(
        { err: error as Error, runId: run.id, woId: run.woId },
        'overseer.watch.assess_run_failed_isolated'
      );
    }
  }
  // PR-FIRST CANDIDATE DISCOVERY (bdc-harness#758).
  //
  // Everything above this line derives candidates from workflow RUNS, which can
  // only ever surface a PR that is still reachable backwards from an open,
  // unclosed run row. That is why 32 open PRs produced "total":2,"eligible":0 for
  // 19 straight heartbeats on 2026-09-04 while #730 and #731 sat APPROVED and
  // CLEAN: their runs had already been closed with a terminal overseer_actions
  // row, so no amount of PR-side greenness could put them back in the set.
  //
  // The sweep below asks GitHub directly for the open PRs on the watched bases
  // and evaluates every one. It changes only WHAT IS LOOKED AT -- every merge
  // authorization rule downstream (M-48 enablement, production-effect hold,
  // provenance, Review Gate exact-head approval, allowed bases, Grok judge) is
  // untouched and still applies to each candidate it produces.
  let discovery: MergeCandidateDiscoveryResult = {
    candidates: [],
    exclusions: [],
    evaluated: 0,
    fallbackReviewDecisions: 0,
    unavailable: true,
  };
  if (options.discoveryEnabled !== false) {
    try {
      discovery = await discoverMergeCandidates(deps, {
        ...options.discovery,
        alreadyCoveredPullRequests:
          options.discovery?.alreadyCoveredPullRequests ?? coveredPullRequests(outcomes),
      });
    } catch (error) {
      // A broken sweep must never take down the watch tick -- the run-derived
      // outcomes above are still valid work.
      log.error({ err: error as Error }, 'merge-coordinator.discovery_failed_isolated');
    }
  }

  // One line per excluded PR. #758's verification condition is that an excluded
  // PR names its reason rather than vanishing, so this is per-PR and greppable;
  // the aggregate counts ride the heartbeat below for at-a-glance reading.
  for (const exclusion of discovery.exclusions) {
    heartbeatLogger.info(
      {
        owner: exclusion.owner,
        repo: exclusion.repo,
        prNumber: exclusion.prNumber,
        reason: exclusion.reason,
        detail: exclusion.detail,
      },
      'merge-coordinator.candidate_excluded'
    );
  }

  for (const candidate of discovery.candidates) outcomes.push(candidate);

  // Merge-coordinator observability heartbeat
  // (WO-HARNESS-MERGE-MANAGER-WIRING-LAND-01). Fires on EVERY cycle regardless of how
  // many runs were evaluated -- a silent cycle is exactly what let "zero merge-manager
  // runtime log lines in 24h" go unnoticed while merge-ready PRs piled up. The
  // 'merge-coordinator.*' event key makes each evaluation cycle greppable in docker
  // logs and answers "is the coordinator running?" without needing a single eligible PR.
  //
  // `total` used to be runs.length -- the RUN count -- which is why it read 2
  // against 32 open PRs and looked like a filter bug rather than a source
  // mismatch (#758). The run and PR populations are now reported separately and
  // named, because they are different populations and always were.
  heartbeatLogger.info(
    {
      evaluated: terminalRuns.length + discovery.evaluated,
      total: runs.length + discovery.evaluated,
      runsEvaluated: terminalRuns.length,
      runsTotal: runs.length,
      prsEvaluated: discovery.evaluated,
      prCandidates: discovery.candidates.length,
      prDiscoveryUnavailable: discovery.unavailable,
      // Non-zero means GitHub's aggregate review decision was unavailable and
      // the stricter REST fallback ran instead, so approved PRs may be sitting
      // excluded. Reads as a DEGRADED GATE rather than a quiet backlog; the
      // matching per-tick warn line is
      // 'merge-coordinator.review_decision_graphql_unavailable'.
      prsFallbackDecision: discovery.fallbackReviewDecisions,
      exclusionsByReason: summarizeExclusions(discovery.exclusions),
      eligible: outcomes.filter(outcome => outcome.action === 'merge_ready').length,
    },
    'merge-coordinator.heartbeat_evaluated'
  );
  return outcomes;
}

export async function watchLoop(
  deps: OverseerRunStoreDeps & GitHubClientDeps,
  onRecord: (record: WatchedRunRecord) => Promise<void>,
  options: {
    intervalMs?: number;
    once?: boolean;
    signal?: AbortSignal;
    /**
     * Forwarded to watchOnce. Production passes nothing and the sweep reads its
     * repos/bases from env; tests supply explicit values so an integration test
     * can drive the real watchLoop -> onRecord path deterministically instead of
     * reimplementing the dispatch it is trying to verify.
     */
    discovery?: WatchOnceOptions['discovery'];
    discoveryEnabled?: boolean;
  } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const watchOptions: WatchOnceOptions = {
    ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
    ...(options.discoveryEnabled === undefined
      ? {}
      : { discoveryEnabled: options.discoveryEnabled }),
  };
  for (;;) {
    if (options.signal?.aborted) return;
    const records = await watchOnce(deps, watchOptions);
    for (const record of records) {
      if (options.signal?.aborted) return;
      await onRecord(record);
    }
    if (options.once) return;
    await new Promise<void>(resolve => {
      const signal = options.signal;
      let settled = false;
      const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer.id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        finish();
      };
      timer.id = setTimeout(finish, intervalMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the narrow race where the signal aborts between the loop's
      // pre-check and listener registration.
      if (signal?.aborted) onAbort();
    });
    if (options.signal?.aborted) return;
  }
}
