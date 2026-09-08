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
  createMemorySweepCursor,
  resolveStaleSweepMax,
  runStaleVerdictSweep,
  verdictIsStale,
  type LatestCheckCompletion,
  type StaleVerdictSweepDeps,
  type SweepCandidate,
} from './stale-verdict-sweep';
import { selectLatestCompletion } from './stale-verdict-sweep-wiring';

const HEAD = '5ac93b765ac93b765ac93b765ac93b765ac93b76';

/**
 * `cursorSeq` defaults to the PR number so a list of candidates built here is
 * strictly ascending, exactly as the keyset query returns them.
 */
function candidate(prNumber = 777, headSha = HEAD, cursorSeq = prNumber): SweepCandidate {
  return { owner: 'thinmansoftware', repo: 'bdc-harness', prNumber, headSha, cursorSeq };
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
    // KEYSET-aware, exactly like the real listing: rows strictly after the
    // given seq, ascending. A double that sliced by array index would hide the
    // very bug the keyset cursor exists to fix.
    listCandidates: mock(async (limit, afterSeq = 0) =>
      candidates.filter(row => row.cursorSeq > afterSeq).slice(0, limit)
    ),
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
    // EXACTLY the budget, not merely "no more than a multiple of it": the
    // budget is spent per candidate touched, so it caps GitHub reads directly.
    expect(recorded.githubReads).toBe(2);
    expect(result.examined).toBe(2);
  });

  // Overseer review finding, PR #786 @5b53b394. The budget used to be spent
  // only on a SUCCESSFUL enqueue, so a heartbeat that enqueued nothing never
  // advanced the stopping counter and walked the whole over-fetched candidate
  // list -- max*5 GitHub reads from a bound advertised as max.
  test('three non-stale candidates exhaust the budget with zero enqueues, and a fourth is never read', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const touched: number[] = [];
    const candidates = [1, 2, 3, 4].map(number => candidate(number, `head-${number}`));
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => {
        touched.push(input.prNumber);
        // Authorized (check-caused CHANGES_REQUESTED) but NOT stale: the
        // verdict postdates the completion, so nothing is ever enqueued.
        return { ...STALE_VERDICT, headSha: input.headSha, recordedAt: '2026-09-07T18:00:00.000Z' };
      }),
    });

    const result = await runStaleVerdictSweep(deps, 3);

    expect(result.enqueued).toBe(0);
    expect(recorded.enqueued).toHaveLength(0);
    // The budget was fully spent on candidates that produced nothing.
    expect(result.examined).toBe(3);
    expect(recorded.githubReads).toBe(3);
    // The fourth candidate is never touched at all -- not read from the store,
    // and certainly not read from GitHub.
    expect(touched).toEqual([1, 2, 3]);
    expect(touched).not.toContain(4);
  });

  test('duplicates also spend the budget, so a re-swept backlog cannot exceed it', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const candidates = [1, 2, 3, 4, 5].map(number => candidate(number, `head-${number}`));
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => ({ ...STALE_VERDICT, headSha: input.headSha })),
      // Every candidate is already queued by the webhook path.
      enqueueRecheckWork: mock(async () => ({ messageId: 'existing', alreadyExisted: true })),
    });

    const result = await runStaleVerdictSweep(deps, 2);

    expect(result.enqueued).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(recorded.githubReads).toBe(2);
  });

  test('completion-less candidates also spend the budget', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const candidates = [1, 2, 3, 4, 5].map(number => candidate(number, `head-${number}`));
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => ({ ...STALE_VERDICT, headSha: input.headSha })),
      readLatestCheckCompletion: mock(async () => {
        recorded.githubReads += 1;
        return null;
      }),
    });

    const result = await runStaleVerdictSweep(deps, 2);

    expect(result.enqueued).toBe(0);
    expect(result.examined).toBe(2);
    expect(recorded.githubReads).toBe(2);
  });

  test('an unsweepable candidate refunds its slot, because it costs no GitHub read', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    // Two approved PRs at the head of the list, then two genuinely stale ones.
    const candidates = [1, 2, 3, 4].map(number => candidate(number, `head-${number}`));
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input =>
        input.prNumber <= 2
          ? { headSha: input.headSha, disposition: 'approved', summary: null, recordedAt: null }
          : { ...STALE_VERDICT, headSha: input.headSha }
      ),
    });

    const result = await runStaleVerdictSweep(deps, 2);

    // The approved pair did not starve the budget: both stale PRs were swept.
    expect(result.enqueued).toBe(2);
    // And the refund never inflates the GitHub-read ceiling.
    expect(recorded.githubReads).toBe(2);
  });

  test('never lists more candidates than the budget plus a bounded lookahead', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const requested: number[] = [];
    const deps = makeDeps([], recorded, {
      listCandidates: mock(async limit => {
        requested.push(limit);
        return [];
      }),
    });

    await runStaleVerdictSweep(deps, 3);

    // Additive, never multiplicative: the old `max * 5` fetch is what made the
    // unbounded read count reachable in the first place.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toBeLessThanOrEqual(3 + 5);
    expect(requested[0]).toBeGreaterThanOrEqual(3);
  });

  test('a bound of zero disables the sweep entirely', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps([candidate()], recorded);
    const result = await runStaleVerdictSweep(deps, 0);
    expect(result).toEqual({ examined: 0, enqueued: 0, duplicates: 0, consumed: 0, afterSeq: 0 });
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
});

/**
 * Overseer review finding, PR #786 @939d42f7: THE BACKSTOP COULD STARVE
 * PERMANENTLY.
 *
 * The local eligibility check refunds its budget slot, so an ineligible
 * candidate costs no GitHub read -- but it still consumes a slot in the
 * `max + lookahead` FETCHED ARRAY. With a fixed window, a run of approved or
 * code-rejected PRs at the window's start exhausted the array with the budget
 * unspent, and every later heartbeat re-fetched the identical rows. An eligible
 * stale verdict past the window was never examined, on any heartbeat, ever.
 */
describe('cursor: the sweep window advances across heartbeats', () => {
  /**
   * 20 completed reviews. The first 8 -- the whole default fetch window of
   * max(3) + lookahead(5) -- are ineligible. The 9th is a checks-only
   * CHANGES_REQUESTED at a now-green head, i.e. exactly what the backstop
   * exists to find.
   */
  function starvationCandidates(): SweepCandidate[] {
    return Array.from({ length: 20 }, (_, index) => candidate(index + 1, `head-${index + 1}`));
  }

  const ELIGIBLE_PR = 9;

  function verdictFor(prNumber: number): StandingVerdict {
    if (prNumber === ELIGIBLE_PR) return { ...STALE_VERDICT, headSha: `head-${prNumber}` };
    // Ineligible: approved (first 8) or a code finding. Neither authorizes, and
    // both refund their slot without a GitHub read.
    return prNumber <= 8
      ? {
          headSha: `head-${prNumber}`,
          disposition: 'approved',
          summary: 'No blocking findings.',
          recordedAt: '2026-09-07T12:07:00.000Z',
        }
      : {
          headSha: `head-${prNumber}`,
          disposition: 'changes_requested',
          summary: '[blocker] src/index.ts: unhandled promise rejection',
          recordedAt: '2026-09-07T12:07:00.000Z',
        };
  }

  test('the 9th candidate is reached within a bounded number of heartbeats, never starved', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const candidates = starvationCandidates();
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => verdictFor(input.prNumber)),
    });

    const cursor = createMemorySweepCursor();
    const max = 3;
    const perHeartbeatReads: number[] = [];

    let enqueuedTotal = 0;
    // The documented bound: the window is max+5 = 8 wide and advances by what
    // it consumes, so candidate 9 is reached on the SECOND heartbeat.
    for (let heartbeat = 0; heartbeat < 2; heartbeat += 1) {
      const before = recorded.githubReads;
      const result = await runStaleVerdictSweep(deps, max, cursor);
      perHeartbeatReads.push(recorded.githubReads - before);
      enqueuedTotal += result.enqueued;
    }

    // THE REGRESSION GUARD: before the cursor this was 0 forever.
    expect(enqueuedTotal).toBe(1);
    expect(recorded.enqueued).toHaveLength(1);
    expect(recorded.enqueued[0]?.prNumber).toBe(ELIGIBLE_PR);
    // The GitHub-read bound is intact on every heartbeat.
    for (const reads of perHeartbeatReads) expect(reads).toBeLessThanOrEqual(max);
  });

  test('the first heartbeat spends no budget yet still advances the cursor', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps(starvationCandidates(), recorded, {
      readStandingVerdict: mock(async input => verdictFor(input.prNumber)),
    });
    const cursor = createMemorySweepCursor();

    const first = await runStaleVerdictSweep(deps, 3, cursor);

    // All 8 fetched candidates were ineligible: nothing examined, no GitHub
    // read, budget fully refunded -- and yet progress was made.
    expect(first.examined).toBe(0);
    expect(recorded.githubReads).toBe(0);
    expect(first.consumed).toBe(8);
    // The resume token is the 8th candidate's DATABASE position, not a count.
    expect(first.afterSeq).toBe(8);
    expect(await cursor.read()).toBe(8);
  });

  test('the cursor rewinds at the end of the store so the sweep never stops', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    // Fewer candidates than one window: the page is short, so the sweep is
    // already at the end and must rewind rather than walk off into positions
    // that return nothing and stop sweeping forever.
    const deps = makeDeps([candidate(1, 'head-1'), candidate(2, 'head-2')], recorded, {
      readStandingVerdict: mock(async input => ({
        headSha: input.headSha,
        disposition: 'approved',
        summary: 'No blocking findings.',
        recordedAt: '2026-09-07T12:07:00.000Z',
      })),
    });
    const cursor = createMemorySweepCursor();

    await runStaleVerdictSweep(deps, 3, cursor);
    expect(await cursor.read()).toBe(0);

    // And from a cursor already past the end, it rewinds rather than sticking.
    const past = createMemorySweepCursor(50);
    await runStaleVerdictSweep(deps, 3, past);
    expect(await past.read()).toBe(0);
  });

  test('a cursor whose read throws restarts the walk instead of failing the heartbeat', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const deps = makeDeps(starvationCandidates(), recorded, {
      readStandingVerdict: mock(async input => verdictFor(input.prNumber)),
    });
    const broken = {
      read: async (): Promise<number> => {
        throw new Error('db_down');
      },
      write: async (): Promise<void> => {
        throw new Error('db_down');
      },
    };

    // Must not throw: the sweep rides the review worker heartbeat that carries
    // the primary review path.
    const result = await runStaleVerdictSweep(deps, 3, broken);
    expect(result.consumed).toBe(8);
  });

  test('the GitHub-read bound holds on every heartbeat of a full walk', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    // Every candidate eligible AND stale: the worst case for read volume.
    const deps = makeDeps(starvationCandidates(), recorded, {
      readStandingVerdict: mock(async input => ({
        ...STALE_VERDICT,
        headSha: input.headSha,
      })),
    });
    const cursor = createMemorySweepCursor();
    const max = 3;

    for (let heartbeat = 0; heartbeat < 10; heartbeat += 1) {
      const before = recorded.githubReads;
      await runStaleVerdictSweep(deps, max, cursor);
      expect(recorded.githubReads - before).toBeLessThanOrEqual(max);
    }
  });

  test('successive heartbeats fetch DIFFERENT slices, never the same page twice', async () => {
    const recorded: Recorded = { enqueued: [], githubReads: 0 };
    const requestedAfterSeq: number[] = [];
    const candidates = starvationCandidates();
    const deps = makeDeps(candidates, recorded, {
      readStandingVerdict: mock(async input => verdictFor(input.prNumber)),
      listCandidates: mock(async (limit, afterSeq = 0) => {
        requestedAfterSeq.push(afterSeq);
        return candidates.filter(row => row.cursorSeq > afterSeq).slice(0, limit);
      }),
    });
    const cursor = createMemorySweepCursor();

    for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
      await runStaleVerdictSweep(deps, 3, cursor);
    }

    // THE REGRESSION GUARD for the second finding: with an in-memory offset
    // applied to a hard-capped page, every heartbeat asked for the same slice.
    expect(requestedAfterSeq).toEqual([0, 8, 16]);
    expect(new Set(requestedAfterSeq).size).toBe(requestedAfterSeq.length);
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
      consumed: 0,
      afterSeq: 0,
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
