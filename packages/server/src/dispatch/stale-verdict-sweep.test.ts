/**
 * Tests for the stale-verdict sweep (bdc-harness #782 part 3).
 *
 * Headline stop condition: "the sweep enqueues once" -- one re-review per stale
 * candidate, and a second sweep over the same completion enqueues nothing.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { StandingVerdict } from '@archon/overseer/pr-review-check-ingest';
import {
  DEFAULT_STALE_SWEEP_MAX,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
  verdictIsStale,
  type LatestCheckCompletion,
  type StaleVerdictSweepDeps,
  type SweepCandidate,
} from './stale-verdict-sweep';
import { selectLatestCompletion } from './stale-verdict-sweep-wiring';

const HEAD = '5ac93b765ac93b765ac93b765ac93b765ac93b76';

function candidate(prNumber = 777, headSha = HEAD): SweepCandidate {
  return { owner: 'thinmansoftware', repo: 'bdc-harness', prNumber, headSha };
}

/** A CHANGES_REQUESTED verdict recorded BEFORE the check completion below. */
const STALE_VERDICT: StandingVerdict = {
  headSha: HEAD,
  disposition: 'changes_requested',
  summary: '[major] checks/test (windows-latest) failed',
  recordedAt: '2026-09-07T12:07:00.000Z',
};

/** The re-run that went green AFTER the verdict was recorded. */
const COMPLETION: LatestCheckCompletion = {
  checkId: 'check_run:555',
  checkName: 'test (windows-latest)',
  conclusion: 'success',
  completedAt: '2026-09-07T16:15:00.000Z',
};

interface Recorded {
  enqueued: { idempotencyKey: string; prNumber: number }[];
  githubReads: number;
}

function makeDeps(
  candidates: SweepCandidate[],
  recorded: Recorded,
  overrides: Partial<StaleVerdictSweepDeps> = {}
): StaleVerdictSweepDeps {
  const rows = new Map<string, string>();
  return {
    listCandidates: mock(async limit => candidates.slice(0, limit)),
    readStandingVerdict: mock(async () => STALE_VERDICT),
    readLatestCheckCompletion: mock(async () => {
      recorded.githubReads += 1;
      return COMPLETION;
    }),
    enqueueRecheckWork: mock(async input => {
      recorded.enqueued.push({
        idempotencyKey: input.idempotencyKey,
        prNumber: input.prNumber,
      });
      const existing = rows.get(input.idempotencyKey);
      if (existing) return { messageId: existing, alreadyExisted: true };
      const messageId = `msg-${rows.size + 1}`;
      rows.set(input.idempotencyKey, messageId);
      return { messageId, alreadyExisted: false };
    }),
    ...overrides,
  };
}

describe('runStaleVerdictSweep', () => {
  test('enqueues exactly one re-review for a stale check-caused verdict, and nothing on a second sweep', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded);

    const first = await runStaleVerdictSweep(deps, 3);
    expect(first.enqueued).toBe(1);
    expect(first.duplicates).toBe(0);
    expect(recorded.enqueued).toHaveLength(1);

    // Second sweep over the SAME completion: the shared idempotency key means
    // the row already exists. One re-review per (head, check), whichever path
    // notices it first.
    const second = await runStaleVerdictSweep(deps, 3);
    expect(second.enqueued).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(new Set(recorded.enqueued.map(row => row.idempotencyKey)).size).toBe(1);
  });

  test('honours the per-heartbeat bound', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const candidates = [1, 2, 3, 4, 5, 6].map(number => candidate(number, `head-${number}`));
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => ({
        ...STALE_VERDICT,
        headSha: input.headSha,
      })),
    });

    const result = await runStaleVerdictSweep(deps, 2);

    expect(result.enqueued).toBe(2);
    expect(recorded.enqueued).toHaveLength(2);
    // The bound is applied BEFORE the GitHub read, so an over-budget candidate
    // costs no rate budget at all.
    expect(recorded.githubReads).toBeLessThanOrEqual(3);
  });

  test('a bound of zero disables the sweep entirely', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded);
    const result = await runStaleVerdictSweep(deps, 0);
    expect(result).toEqual({ examined: 0, enqueued: 0, duplicates: 0 });
    expect(deps.listCandidates).not.toHaveBeenCalled();
  });

  test('an APPROVED verdict is never swept and costs no GitHub read', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded, {
      readStandingVerdict: mock(async () => ({
        headSha: HEAD,
        disposition: 'approved',
        summary: 'No blocking findings.',
        recordedAt: '2026-09-07T12:07:00.000Z',
      })),
    });

    const result = await runStaleVerdictSweep(deps, 3);
    expect(result.enqueued).toBe(0);
    expect(recorded.githubReads).toBe(0);
  });

  test('a CODE-caused rejection is never swept', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded, {
      readStandingVerdict: mock(async () => ({
        headSha: HEAD,
        disposition: 'changes_requested',
        summary: '[blocker] src/index.ts: unhandled promise rejection',
        recordedAt: '2026-09-07T12:07:00.000Z',
      })),
    });

    const result = await runStaleVerdictSweep(deps, 3);
    expect(result.enqueued).toBe(0);
    expect(recorded.githubReads).toBe(0);
  });

  test('a verdict NEWER than the completion is not stale', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded, {
      readStandingVerdict: mock(async () => ({
        ...STALE_VERDICT,
        recordedAt: '2026-09-07T18:00:00.000Z',
      })),
    });

    const result = await runStaleVerdictSweep(deps, 3);
    expect(result.examined).toBe(1);
    expect(result.enqueued).toBe(0);
  });

  test('a head with no completed check is skipped', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded, {
      readLatestCheckCompletion: mock(async () => null),
    });

    const result = await runStaleVerdictSweep(deps, 3);
    expect(result.enqueued).toBe(0);
  });

  test('one failing candidate does not abort the sweep', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    let calls = 0;
    const deps = makeDeps([candidate(1, 'head-1'), candidate(2, 'head-2')], recorded, {
      readStandingVerdict: mock(async input => {
        calls += 1;
        if (calls === 1) throw new Error('store_unavailable');
        return { ...STALE_VERDICT, headSha: input.headSha };
      }),
    });

    const result = await runStaleVerdictSweep(deps, 3);
    expect(result.enqueued).toBe(1);
  });

  test('a candidate-listing failure returns an empty result rather than throwing', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([], recorded, {
      listCandidates: mock(async () => {
        throw new Error('db_down');
      }),
    });

    await expect(runStaleVerdictSweep(deps, 3)).resolves.toEqual({
      examined: 0,
      enqueued: 0,
      duplicates: 0,
    });
  });
});

describe('verdictIsStale', () => {
  test('a verdict with no timestamp is never treated as stale', () => {
    expect(verdictIsStale({ ...STALE_VERDICT, recordedAt: null }, COMPLETION)).toBe(false);
    expect(verdictIsStale({ ...STALE_VERDICT, recordedAt: undefined }, COMPLETION)).toBe(false);
  });

  test('unparseable timestamps fail closed', () => {
    expect(verdictIsStale({ ...STALE_VERDICT, recordedAt: 'not-a-date' }, COMPLETION)).toBe(false);
    expect(verdictIsStale(STALE_VERDICT, { ...COMPLETION, completedAt: 'not-a-date' })).toBe(false);
  });

  test('an exactly-simultaneous completion is not stale', () => {
    expect(
      verdictIsStale(STALE_VERDICT, { ...COMPLETION, completedAt: STALE_VERDICT.recordedAt! })
    ).toBe(false);
  });
});

describe('resolveStaleSweepMax', () => {
  test('defaults to 3', () => {
    expect(resolveStaleSweepMax({})).toBe(DEFAULT_STALE_SWEEP_MAX);
    expect(DEFAULT_STALE_SWEEP_MAX).toBe(3);
  });

  test('reads the env override', () => {
    expect(resolveStaleSweepMax({ OVERSEER_STALE_VERDICT_SWEEP_MAX: '10' })).toBe(10);
    expect(resolveStaleSweepMax({ OVERSEER_STALE_VERDICT_SWEEP_MAX: '0' })).toBe(0);
  });

  test('rejects nonsense and caps the ceiling', () => {
    expect(resolveStaleSweepMax({ OVERSEER_STALE_VERDICT_SWEEP_MAX: 'many' })).toBe(
      DEFAULT_STALE_SWEEP_MAX
    );
    expect(resolveStaleSweepMax({ OVERSEER_STALE_VERDICT_SWEEP_MAX: '-4' })).toBe(
      DEFAULT_STALE_SWEEP_MAX
    );
    expect(resolveStaleSweepMax({ OVERSEER_STALE_VERDICT_SWEEP_MAX: '9999' })).toBe(50);
  });
});

describe('selectLatestCompletion', () => {
  test('picks the most recently completed run', () => {
    const latest = selectLatestCompletion([
      {
        id: 1,
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-07T10:00:00Z',
      },
      {
        id: 2,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-07T16:15:00Z',
      },
      { id: 3, name: 'build', status: 'in_progress', conclusion: null, completed_at: null },
    ]);
    expect(latest?.checkId).toBe('check_run:2');
    expect(latest?.checkName).toBe('test');
    expect(latest?.completedAt).toBe('2026-09-07T16:15:00Z');
  });

  test('returns null when nothing has completed', () => {
    expect(
      selectLatestCompletion([
        { id: 1, name: 'test', status: 'in_progress', conclusion: null, completed_at: null },
      ])
    ).toBeNull();
    expect(selectLatestCompletion([])).toBeNull();
  });

  test('skips runs with no usable completion timestamp', () => {
    expect(
      selectLatestCompletion([
        { id: 1, name: 'test', status: 'completed', conclusion: 'success', completed_at: 'nope' },
      ])
    ).toBeNull();
  });
});
