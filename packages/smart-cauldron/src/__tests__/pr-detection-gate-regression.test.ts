/**
 * pr-detection-gate-regression.test.ts
 *
 * Regression coverage for WO-HARNESS-CASCADE-GATE-PR-DETECTION-01
 * (anchor: issue thinmansoftware/bdc-xo#1502).
 *
 * Incident (2026-08-11): WO-LSPRO-CE-COVER-PICKER-SCROLL-01, a mechanical fix at
 * the zero rung, opened lspro-react PRs #513/#515, yet the conductor recorded
 * "no PR opened after completed run" at every rung and climbed to a fable apex
 * run -- frontier price paid for work finished 4 rungs earlier.
 *
 * Root cause (verified against poll.ts + the workflow YAMLs, NOT the spec's
 * "archon/thread-* vs feat/wo-*" hypothesis, which does not match what the
 * workflow pushes): the pushed / PR-head branch is ALWAYS the workflow's
 * UNIQUE_BRANCH ("${BRANCH}-thread-${THREAD_ID}", BRANCH validated
 * ^(feat|fix|wip)/...), emitted as `unique_branch=<name>` by commit-and-push
 * (bdc-feature-development-zero.yaml:2316 + siblings). `archon/thread-<hash>` is
 * only the LOCAL worktree ref -- never the pushed branch. Attribution via
 * `unique_branch=` + `gh pr list --head` was already correct; the gap was that
 * findExistingPrForBranch fired that `gh pr list` ONCE, with no retry, after the
 * event-feed retries were exhausted. GitHub's eventual-consistency window on the
 * `gh pr list` REST path can outlive those event-feed retries, so a single-shot
 * lookup false-negatives and the ladder climbs on already-landed work.
 *
 * The fix adds retry/backoff to the branch lookup. These tests exercise:
 *   Scenario 1 (cascade): completed run opened a PR -> ladder wins on entry tier,
 *              does NOT climb.
 *   Scenario 2 (poll + cascade): PR exists but the FIRST `gh pr list` returns an
 *              empty list (eventual consistency) -> retry finds it -> no climb.
 *   Scenario 3 (poll): PR attributed via the pushed `unique_branch=` value ->
 *              found on first lookup.
 *   Scenario 4 (poll + cascade): a completed run that genuinely opened NO PR ->
 *              retries exhausted -> verdict stays no-PR and the ladder climbs
 *              (fail-closed; the fix must NOT fail-open).
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { pollForTerminal } from '../poll.js';
import { judgeGate } from '../judge.js';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult } from '../types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// A completed-run API response carrying the given events.
const completedRun = (events: unknown[], runId = 'run-1502') =>
  new Response(JSON.stringify({ run: { id: runId, status: 'completed', metadata: {} }, events }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// The open-pr node event (PR visible on the run's own event feed).
const openPrEvent = {
  event_type: 'node_completed',
  step_name: 'open-pr-if-needed',
  data: { output: 'PR_URL=https://github.com/thinmansoftware/lspro-react/pull/513' },
};

// The commit-and-push node event. Carries the pushed branch as unique_branch=,
// which is the value findExistingPrForBranch attributes the PR by. NOTE the
// branch is a feat/wo-...-thread-... UNIQUE_BRANCH, never archon/thread-*.
const commitPushEvent = (branch: string) => ({
  event_type: 'node_completed',
  step_name: 'commit-and-push',
  data: { output: `VERIFIED: origin/${branch} == local HEAD\nunique_branch=${branch}` },
});

const UNIQUE_BRANCH = 'feat/wo-lspro-ce-cover-picker-scroll-01-thread-abcd1234';

/**
 * Builds a `gh pr list --head` stub that simulates GitHub eventual consistency:
 * the branch's PR is invisible for the first `emptyResponses` calls, then
 * becomes visible. Records the branches it was asked about.
 */
function simulateEventualConsistency(emptyResponses: number, url: string) {
  const branchesSeen: string[] = [];
  let calls = 0;
  const lookup = async (branch: string): Promise<string | null> => {
    branchesSeen.push(branch);
    calls++;
    return calls <= emptyResponses ? null : url;
  };
  return {
    lookup,
    branchesSeen,
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// pollForTerminal-level: hermetic (gh pr list injected via ghPrListForBranch)
// ---------------------------------------------------------------------------

describe('findExistingPrForBranch retry/backoff (issue #1502)', () => {
  test('Scenario 2: PR list empty on first lookup, found on retry -> PR-found (eventual consistency)', async () => {
    // Run completed, pushed its branch, but opened no open-pr NODE event and the
    // gh pr list REST path is briefly empty. The event-feed retries find nothing;
    // the branch lookup must retry and then succeed.
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/515';
    const gh = simulateEventualConsistency(1, prUrl);

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: gh.lookup,
    });

    expect(result.prUrl).toBe(prUrl);
    // First call empty, second call found -> the fix retried instead of giving up.
    expect(gh.calls).toBe(2);
    // Gate must read this as a pass -> no climb.
    expect(judgeGate(result).pass).toBe(true);
  });

  test('Scenario 3: PR attributed to the run via the pushed unique_branch value', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/513';
    const gh = simulateEventualConsistency(0, prUrl);

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: gh.lookup,
    });

    expect(result.prUrl).toBe(prUrl);
    // Attribution used the exact pushed branch, not repo-wide recency.
    expect(gh.branchesSeen).toEqual([UNIQUE_BRANCH]);
    expect(judgeGate(result).pass).toBe(true);
  });

  test('Scenario 4: genuine no-PR after retries exhausted -> verdict stays no-PR (fail-closed)', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    // gh pr list is empty on EVERY attempt -- the run really opened no PR.
    let calls = 0;
    const lookup = async (): Promise<string | null> => {
      calls++;
      return null;
    };

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: lookup,
    });

    expect(result.prUrl).toBeNull();
    // The lookup was retried to exhaustion (3 attempts) before giving up.
    expect(calls).toBe(3);
    // The gate must still fail -- the fix must NOT fail-open on a true negative.
    const verdict = judgeGate(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('no PR opened after completed run');
  });
});

// ---------------------------------------------------------------------------
// Cascade-level: proves the LADDER does not climb (attempts.length === 1)
// ---------------------------------------------------------------------------

function makeFireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-1502', infraError: null };
}

// Fake WO ID: must NOT resolve to a real bdc-xo issue. The frontier gate-fail
// path (Scenario 4) reaches defaultSpecRepair, which shells out to `gh issue
// comment`/`gh issue edit` against a REAL repo -- so every cascade dep below
// ALSO injects a no-op specRepair stub. The fake id is defense in depth.
function baseOpts(deps: CascadeDeps): RunCascadeOptions {
  return {
    woId: 'WO-TEST-1502-PR-DETECTION-REGRESSION',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: '/tmp/smart-cauldron-1502-test-runs',
    token: 'test-token',
    project: 'lspro-react',
    deps,
  };
}

// No-op spec-repair: prevents the frontier gate-fail path from making real
// `gh issue comment` / `gh issue edit` GitHub mutations in unit tests.
const noopSpecRepair: NonNullable<CascadeDeps['specRepair']> = async () => ({
  posted: false,
  issueRepo: null,
  issueNumber: null,
});

// A poll dep that runs the REAL pollForTerminal (so detection + retry are
// exercised end to end) with test-fast delays and an injected gh lookup.
function realPollDep(ghLookup: (branch: string) => Promise<string | null>): CascadeDeps['poll'] {
  return async opts =>
    pollForTerminal({
      ...opts,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: ghLookup,
    });
}

describe('cascade does not climb when the completed run landed a PR (issue #1502)', () => {
  test('Scenario 1: PR present on the run event feed -> wins on entry tier, no climb', async () => {
    globalThis.fetch = (async () => completedRun([openPrEvent])) as unknown as typeof fetch;

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      poll: realPollDep(async () => null),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(baseOpts(deps));

    expect(result.status).toBe('won');
    expect(result.attempts).toHaveLength(1);
    expect(fireCalls).toBe(1);
  });

  test('Scenario 2: PR found only after the branch-lookup retry -> still wins on entry tier, no climb', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    // Eventual consistency: gh pr list is empty on the first call, then finds the PR.
    const gh = simulateEventualConsistency(
      1,
      'https://github.com/thinmansoftware/lspro-react/pull/515'
    );

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      poll: realPollDep(gh.lookup),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(baseOpts(deps));

    expect(result.status).toBe('won');
    expect(result.attempts).toHaveLength(1);
    expect(fireCalls).toBe(1);
  });

  test('Scenario 4: genuine no-PR -> ladder climbs (fail-closed, true negative preserved)', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      // gh pr list never finds a PR -- the run truly opened none.
      poll: realPollDep(async () => null),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(baseOpts(deps));

    // The fix must NOT fail-open: the entry tier gate-fails and the ladder climbs.
    expect(result.status).not.toBe('won');
    expect(result.attempts[0]?.outcome).toBe('gate-failed');
    expect(result.attempts[0]?.gateFailReason).toContain('no PR opened after completed run');
    expect(result.attempts.length).toBeGreaterThan(1);
    expect(fireCalls).toBeGreaterThan(1);
  });
});
