/**
 * Required status-check context resolution -- the 2026-09-07 forever-defer fix.
 *
 * Incident: the GitHub App installation client got HTTP 403 "Resource not
 * accessible by integration" on the branch-protection contexts endpoint every
 * tick, the adapter mapped that to `null`, checksAreTerminal failed closed, and
 * the review worker released with disposition checks_pending forever. Separately,
 * bdc-xo main is genuinely unprotected and its 404 also mapped to `null`.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  ATTEMPT_COUNTER_MAX_ENTRIES,
  ATTEMPT_COUNTER_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  NO_BASE_REF_SENTINEL,
  REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV,
  REQUIRED_CONTEXTS_OVERRIDE_ENV,
  inMemoryAttemptCounterStore,
  isBranchNotProtectedError,
  isPermissionFailure,
  parseRequiredContextsOverride,
  peekRequiredContextsAttempts,
  requiredContextsAttemptCounterSize,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsSourceLog,
  resolveMaxAttempts,
  resolveRequiredContexts,
} from '../adapters/required-contexts.ts';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import { checksAreTerminal, evaluatePullRequest } from '../pr-review-evaluator.ts';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const BASE = 'dev';
const HEAD = 'a'.repeat(40);

/** The exact error the container logged on every tick. */
function appPermissionError(): Error {
  return Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
}

/** The exact error bdc-xo main returns: a real unprotected branch. */
function branchNotProtectedError(): Error {
  return Object.assign(new Error('Branch not protected'), { status: 404 });
}

/** A permission-masked 404: same status, generic message, NOT positive evidence. */
function maskedNotFoundError(): Error {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    baseRef: BASE,
    headSha: HEAD,
    ...overrides,
  } as Parameters<typeof resolveRequiredContexts>[0];
}

beforeEach(() => {
  resetRequiredContextsAttemptCounters();
  resetRequiredContextsSourceLog();
});

describe('resolveRequiredContexts -- identity fallback (incident 2026-09-07)', () => {
  test('1 App 403 then PAT success yields the contexts from the PAT client', async () => {
    let appCalls = 0;
    let patCalls = 0;
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          appCalls += 1;
          throw appPermissionError();
        },
        fetchWithPatClient: async (request: { branch: string }) => {
          patCalls += 1;
          expect(request.branch).toBe(BASE);
          // The live values the PAT returns for bdc-harness/dev.
          return { data: ['docker-build', 'test (ubuntu-latest)'] };
        },
      }),
      {}
    );
    expect(appCalls).toBe(1);
    expect(patCalls).toBe(1);
    expect(resolution).toEqual({
      state: 'known',
      contexts: ['docker-build', 'test (ubuntu-latest)'],
      source: 'pat_client',
    });
  });

  test('2 the App client is preferred and the PAT is never called when it succeeds', async () => {
    let patCalls = 0;
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => ({ data: ['test'] }),
        fetchWithPatClient: async () => {
          patCalls += 1;
          return { data: ['should-not-be-used'] };
        },
      }),
      {}
    );
    expect(patCalls).toBe(0);
    expect(resolution).toEqual({ state: 'known', contexts: ['test'], source: 'app_client' });
  });

  test('3 a non-permission failure does NOT re-ask the other identity', async () => {
    // A 502 is not an identity problem. Re-asking as a different principal
    // would just double the load on an API that is already struggling.
    let patCalls = 0;
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw Object.assign(new Error('Bad gateway'), { status: 502 });
        },
        fetchWithPatClient: async () => {
          patCalls += 1;
          return { data: ['test'] };
        },
      }),
      {}
    );
    expect(patCalls).toBe(0);
    expect(resolution.state).toBe('unknown');
  });

  test('4 both identities failing on permission is UNKNOWN, never an empty set', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw appPermissionError();
        },
        fetchWithPatClient: async () => {
          throw appPermissionError();
        },
      }),
      {}
    );
    expect(resolution).toEqual({
      state: 'unknown',
      reason: 'permission_denied',
      failureKind: 'permission',
    });
  });

  test('5 contexts are trimmed and blanks dropped', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => ({ data: ['  test  ', '', '   ', 'build'] }),
      }),
      {}
    );
    expect(resolution).toEqual({
      state: 'known',
      contexts: ['test', 'build'],
      source: 'app_client',
    });
  });
});

describe('resolveRequiredContexts -- env override', () => {
  test('6 the env override wins over both API clients', async () => {
    let apiCalls = 0;
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          apiCalls += 1;
          return { data: ['from-api'] };
        },
      }),
      {
        [REQUIRED_CONTEXTS_OVERRIDE_ENV]: JSON.stringify({
          'thinmansoftware/bdc-harness@dev': ['docker-build', 'test (ubuntu-latest)'],
        }),
      }
    );
    expect(apiCalls).toBe(0);
    expect(resolution).toEqual({
      state: 'known',
      contexts: ['docker-build', 'test (ubuntu-latest)'],
      source: 'env_override',
    });
  });

  test('7 an override for a DIFFERENT branch does not apply', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => ({ data: ['from-api'] }),
      }),
      {
        [REQUIRED_CONTEXTS_OVERRIDE_ENV]: JSON.stringify({
          'thinmansoftware/bdc-harness@main': ['other-branch'],
        }),
      }
    );
    expect(resolution).toEqual({ state: 'known', contexts: ['from-api'], source: 'app_client' });
  });

  test('8 an override may assert an authoritative EMPTY set', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw appPermissionError();
        },
      }),
      {
        [REQUIRED_CONTEXTS_OVERRIDE_ENV]: JSON.stringify({ 'thinmansoftware/bdc-harness@dev': [] }),
      }
    );
    // An empty ARRAY entry is a real answer and must route to the heuristic.
    expect(resolution.state).toBe('known');
    if (resolution.state === 'known') expect(resolution.contexts).toEqual([]);
  });

  test('9 malformed override JSON is ignored, not fatal', () => {
    expect(parseRequiredContextsOverride('{not json')).toBeNull();
    expect(parseRequiredContextsOverride('[]')).toBeNull();
    expect(parseRequiredContextsOverride('')).toBeNull();
    expect(parseRequiredContextsOverride(undefined)).toBeNull();
    // A non-array entry is dropped; the rest of the map survives.
    const parsed = parseRequiredContextsOverride(
      JSON.stringify({ 'a/b@main': 'not-an-array', 'c/d@dev': ['ok'] })
    );
    expect(parsed?.get('c/d@dev')).toEqual(['ok']);
    expect(parsed?.has('a/b@main')).toBe(false);
  });
});

describe('resolveRequiredContexts -- genuinely unprotected branches (bdc-xo main)', () => {
  test('10 rules [] plus protected:false is POSITIVE evidence of an empty required set', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        baseRef: 'main',
        repo: 'bdc-xo',
        fetchWithAppClient: async () => {
          throw branchNotProtectedError();
        },
        fetchBranchRules: async () => ({ data: [] }),
        fetchBranch: async () => ({ data: { protected: false, protection: { enabled: false } } }),
      }),
      {}
    );
    expect(resolution).toEqual({ state: 'known', contexts: [], source: 'unprotected_branch' });
    // The whole point: an authoritative empty set routes to the heuristic, and
    // a completed reported check now makes the suite terminal.
    if (resolution.state === 'known') {
      expect(
        checksAreTerminal(
          [{ name: 'test', status: 'completed', conclusion: 'success' }],
          resolution.contexts
        )
      ).toBe(true);
    }
  });

  test('11 a 404 WITHOUT positive evidence stays UNKNOWN (null), never empty', async () => {
    // GitHub masks 403 as 404 on admin-scoped endpoints. With no rules/branch
    // probes available we cannot tell the two apart, so we must fail closed.
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw maskedNotFoundError();
        },
      }),
      {}
    );
    expect(resolution.state).toBe('unknown');
  });

  test('12 rules [] but protected:true is NOT unprotected -- the probes disagree', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw maskedNotFoundError();
        },
        fetchBranchRules: async () => ({ data: [] }),
        fetchBranch: async () => ({ data: { protected: true } }),
      }),
      {}
    );
    expect(resolution.state).toBe('unknown');
  });

  test('13 a NON-empty rules array is not unprotected', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw maskedNotFoundError();
        },
        fetchBranchRules: async () => ({ data: [{ type: 'required_status_checks' }] }),
        fetchBranch: async () => ({ data: { protected: false } }),
      }),
      {}
    );
    expect(resolution.state).toBe('unknown');
  });

  test('14 a failing unprotected probe degrades to UNKNOWN, not to empty', async () => {
    const resolution = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw branchNotProtectedError();
        },
        fetchBranchRules: async () => {
          throw new Error('rules endpoint exploded');
        },
        fetchBranch: async () => ({ data: { protected: false } }),
      }),
      {}
    );
    expect(resolution.state).toBe('unknown');
  });

  test('15 isBranchNotProtectedError separates the real 404 from the masked one', () => {
    expect(isBranchNotProtectedError(branchNotProtectedError())).toBe(true);
    expect(isBranchNotProtectedError(maskedNotFoundError())).toBe(false);
    expect(isBranchNotProtectedError(appPermissionError())).toBe(false);
    expect(isBranchNotProtectedError(null)).toBe(false);
  });
});

describe('resolveRequiredContexts -- bounded deferral ESCALATES, never downgrades', () => {
  const alwaysFails = () =>
    baseInput({
      fetchWithAppClient: async () => {
        throw appPermissionError();
      },
      fetchWithPatClient: async () => {
        throw appPermissionError();
      },
    });

  test('16 the first attempts fail closed, then the bound is reached and BLOCKS', async () => {
    const results = [];
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS; i += 1) {
      results.push(await resolveRequiredContexts(alwaysFails(), {}));
    }
    // Fail-closed default preserved below the bound: a transient blip defers.
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS - 1; i += 1) {
      expect(results[i]!.state).toBe('unknown');
    }
    const final = results[DEFAULT_MAX_ATTEMPTS - 1]!;
    expect(final.state).toBe('exhausted');
    if (final.state === 'exhausted') {
      expect(final.reason).toBe('required_contexts_unavailable_blocked');
      expect(final.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
      expect(final.failureKind).toBe('permission');
    }
  });

  test('17 the bound is configurable via env', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    expect((await resolveRequiredContexts(alwaysFails(), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(alwaysFails(), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(alwaysFails(), env)).state).toBe('exhausted');
  });

  test('18 EXHAUSTED never yields contexts and never routes to the heuristic', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '1' };
    const blocked = await resolveRequiredContexts(alwaysFails(), env);
    expect(blocked.state).toBe('exhausted');
    // The resolution carries NO contexts field at all -- there is nothing to
    // gate on, which is the whole reason the review is blocked.
    expect(blocked).not.toHaveProperty('contexts');
    // And the fail-closed contract at the evaluator is untouched: `null` still
    // means not-terminal no matter how green the reported checks look.
    expect(
      checksAreTerminal([{ name: 'test', status: 'completed', conclusion: 'success' }], null)
    ).toBe(false);
  });

  test('19 a new head restarts the bound rather than inheriting a stale count', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    await resolveRequiredContexts(alwaysFails(), env);
    await resolveRequiredContexts(alwaysFails(), env);
    // Same branch, new head: the previous head's failures say nothing about it.
    const fresh = await resolveRequiredContexts(
      baseInput({
        headSha: 'b'.repeat(40),
        fetchWithAppClient: async () => {
          throw appPermissionError();
        },
      }),
      env
    );
    expect(fresh.state).toBe('unknown');
  });

  test('20 a success clears the counter so a later blip defers again', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    await resolveRequiredContexts(alwaysFails(), env);
    await resolveRequiredContexts(alwaysFails(), env);
    await resolveRequiredContexts(
      baseInput({ fetchWithAppClient: async () => ({ data: ['test'] }) }),
      env
    );
    // Counter reset by the success: we are back to failing closed.
    expect((await resolveRequiredContexts(alwaysFails(), env)).state).toBe('unknown');
  });

  test('21 an absent base ref defers, and blocks under the same bound', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '2' };
    const input = baseInput({ baseRef: undefined });
    expect((await resolveRequiredContexts(input, env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(input, env)).state).toBe('exhausted');
  });

  test('22 no identity at all defers rather than assuming nothing is required', async () => {
    const resolution = await resolveRequiredContexts(baseInput(), {});
    expect(resolution).toEqual({
      state: 'unknown',
      reason: 'protection_api_unavailable',
      failureKind: 'permission',
    });
  });

  test('23 a TRANSIENT exhaustion is labelled transient, not permission', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '1' };
    const blocked = await resolveRequiredContexts(
      baseInput({
        fetchWithAppClient: async () => {
          throw Object.assign(new Error('Bad gateway'), { status: 502 });
        },
      }),
      env
    );
    expect(blocked.state).toBe('exhausted');
    // The PR comment tells a human whether to grant a scope or wait it out, so
    // the two causes must not be collapsed.
    if (blocked.state === 'exhausted') expect(blocked.failureKind).toBe('transient');
  });
});

/**
 * #777 review finding: the counter was keyed by owner/repo@base and merely
 * STORED a head, so two PRs on one base shared a slot. The review worker
 * interleaves their ticks, each arrival reset the slot to 1, and neither head
 * ever reached the bound -- reinstating the forever-defer this module bounds.
 */
describe('resolveRequiredContexts -- concurrent PRs on one base keep separate bounds', () => {
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);

  function failingFor(headSha: string, baseRef: string = BASE) {
    return baseInput({
      headSha,
      baseRef,
      fetchWithAppClient: async () => {
        throw appPermissionError();
      },
    });
  }

  test('32 interleaved heads on one base each reach the bound independently', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    // Alternating ticks, exactly as the review worker produces them. Under the
    // per-branch key this loop never exhausted either head.
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_B), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_B), env)).state).toBe('unknown');

    const exhaustedA = await resolveRequiredContexts(failingFor(HEAD_A), env);
    expect(exhaustedA.state).toBe('exhausted');
    if (exhaustedA.state === 'exhausted') expect(exhaustedA.attempts).toBe(3);

    const exhaustedB = await resolveRequiredContexts(failingFor(HEAD_B), env);
    expect(exhaustedB.state).toBe('exhausted');
    if (exhaustedB.state === 'exhausted') expect(exhaustedB.attempts).toBe(3);
  });

  test('33 processing another head does NOT reset this head counter', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '5' };
    await resolveRequiredContexts(failingFor(HEAD_A), env);
    await resolveRequiredContexts(failingFor(HEAD_A), env);
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(2);

    // A sibling PR's whole lifecycle -- deferrals AND a success -- must leave
    // head A's progress untouched.
    await resolveRequiredContexts(failingFor(HEAD_B), env);
    await resolveRequiredContexts(
      baseInput({ headSha: HEAD_B, fetchWithAppClient: async () => ({ data: ['test'] }) }),
      env
    );
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(2);
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_B)).toBe(0);

    // Head A therefore still exhausts on its own third, fourth and fifth ticks.
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('exhausted');
  });

  // #777 review finding [major]: the clear swept every BASE in the repository
  // for that head. Required contexts are base-specific, so the same commit
  // against two bases is two different questions -- and a base whose lookup
  // keeps succeeding would hold a base whose lookup never succeeds permanently
  // below its bound, which is the forever-deferral the bound exists to end.
  test('34 a success clears ONLY that base, not the same head on another base', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '5' };
    await resolveRequiredContexts(failingFor(HEAD_A), env);
    await resolveRequiredContexts(failingFor(HEAD_A, 'main'), env);
    await resolveRequiredContexts(failingFor(HEAD_B), env);
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(1);
    expect(peekRequiredContextsAttempts(OWNER, REPO, 'main', HEAD_A)).toBe(1);

    // Head A's lookup succeeds ON BASE `dev` ONLY.
    await resolveRequiredContexts(
      baseInput({ headSha: HEAD_A, fetchWithAppClient: async () => ({ data: ['test'] }) }),
      env
    );
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(0);
    // Under the base-blind clear this read was 0: the `dev` success wiped the
    // `main` question's progress, and repeating that every tick meant `main`
    // never reached its bound.
    expect(peekRequiredContextsAttempts(OWNER, REPO, 'main', HEAD_A)).toBe(1);
    // Head B, which never succeeded anywhere, is untouched either way.
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_B)).toBe(1);
  });

  test('34b the un-cleared base still reaches its own bound after the other base succeeds', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    await resolveRequiredContexts(failingFor(HEAD_A, 'main'), env);
    await resolveRequiredContexts(failingFor(HEAD_A, 'main'), env);
    expect(peekRequiredContextsAttempts(OWNER, REPO, 'main', HEAD_A)).toBe(2);

    // Repeated successes on `dev` for the same head, exactly as a healthy
    // sibling PR produces. None of them may touch the `main` counter.
    for (let tick = 0; tick < 3; tick += 1) {
      await resolveRequiredContexts(
        baseInput({ headSha: HEAD_A, fetchWithAppClient: async () => ({ data: ['test'] }) }),
        env
      );
    }
    expect(peekRequiredContextsAttempts(OWNER, REPO, 'main', HEAD_A)).toBe(2);

    // So `main` exhausts on its own third tick rather than deferring forever.
    const exhausted = await resolveRequiredContexts(failingFor(HEAD_A, 'main'), env);
    expect(exhausted.state).toBe('exhausted');
    if (exhausted.state === 'exhausted') expect(exhausted.attempts).toBe(3);
  });

  test('34c an unreadable base ref is its own counter, not a wildcard over real bases', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '5' };
    await resolveRequiredContexts(failingFor(HEAD_A), env);
    // The base ref could not be read at all -- a distinct question.
    await resolveRequiredContexts(baseInput({ headSha: HEAD_A, baseRef: null }), env);
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(1);
    expect(peekRequiredContextsAttempts(OWNER, REPO, NO_BASE_REF_SENTINEL, HEAD_A)).toBe(1);

    // A success on the real base must not clear the sentinel's count either.
    await resolveRequiredContexts(
      baseInput({ headSha: HEAD_A, fetchWithAppClient: async () => ({ data: ['test'] }) }),
      env
    );
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(0);
    expect(peekRequiredContextsAttempts(OWNER, REPO, NO_BASE_REF_SENTINEL, HEAD_A)).toBe(1);
  });

  test('35 the same head on different bases is bounded separately', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '2' };
    expect((await resolveRequiredContexts(failingFor(HEAD_A, BASE), env)).state).toBe('unknown');
    // A different base is a different question about the same commit; its first
    // lookup must not inherit the other base's count.
    expect((await resolveRequiredContexts(failingFor(HEAD_A, 'main'), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_A, BASE), env)).state).toBe('exhausted');
  });

  // #777 review finding [major]: the clear matched on the `#headSha` suffix
  // alone, so it swept EVERY repository's entry for that sha. Identical commits
  // routinely exist across forks and mirrors, so one repo's success reset
  // another repo's counter -- and a repo whose counter keeps being reset never
  // reaches the bound, which is the forever-deferral the bound exists to end.
  test('35b a success in one repo leaves another repo counter for the same head intact', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '3' };
    const OTHER_REPO = 'bdc-harness-fork';

    // The SAME head sha under two repositories -- a fork carrying the identical
    // commit. Both accumulate deferrals independently.
    await resolveRequiredContexts(failingFor(HEAD_A), env);
    await resolveRequiredContexts(
      baseInput({
        repo: OTHER_REPO,
        headSha: HEAD_A,
        fetchWithAppClient: async () => {
          throw appPermissionError();
        },
      }),
      env
    );
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(1);
    expect(peekRequiredContextsAttempts(OWNER, OTHER_REPO, BASE, HEAD_A)).toBe(1);

    // The fork's lookup succeeds. Only the fork's counter may clear.
    await resolveRequiredContexts(
      baseInput({
        repo: OTHER_REPO,
        headSha: HEAD_A,
        fetchWithAppClient: async () => ({ data: ['test'] }),
      }),
      env
    );
    expect(peekRequiredContextsAttempts(OWNER, OTHER_REPO, BASE, HEAD_A)).toBe(0);
    // Under the unscoped clear this read was 0: the fork's success wiped this
    // repo's progress, and repeating that every tick meant the bound never came.
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(1);

    // So this repo still reaches its own bound on its own second and third ticks.
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('unknown');
    expect((await resolveRequiredContexts(failingFor(HEAD_A), env)).state).toBe('exhausted');
  });

  test('36 stale counters are pruned by age, not by another head arriving', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '5' };
    const realNow = Date.now;
    try {
      let clock = realNow();
      Date.now = () => clock;
      await resolveRequiredContexts(failingFor(HEAD_A), env);
      expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(1);

      // Past the TTL, an abandoned head's counter is retired on the next write.
      clock += ATTEMPT_COUNTER_TTL_MS + 1;
      await resolveRequiredContexts(failingFor(HEAD_B), env);
      expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_A)).toBe(0);
      expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, HEAD_B)).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  test('37 retained counters stay under the ceiling as heads churn', async () => {
    const env = { [REQUIRED_CONTEXTS_MAX_ATTEMPTS_ENV]: '99' };
    for (let index = 0; index < ATTEMPT_COUNTER_MAX_ENTRIES + 25; index += 1) {
      await resolveRequiredContexts(failingFor(index.toString(16).padStart(40, '0')), env);
    }
    expect(requiredContextsAttemptCounterSize()).toBeLessThanOrEqual(ATTEMPT_COUNTER_MAX_ENTRIES);
    // The newest head is the one that must survive the eviction.
    const newest = (ATTEMPT_COUNTER_MAX_ENTRIES + 24).toString(16).padStart(40, '0');
    expect(peekRequiredContextsAttempts(OWNER, REPO, BASE, newest)).toBe(1);
  });
});

describe('createRealFetchExactHeadPullRequestEvidence -- adapter boundary', () => {
  const PR_NUMBER = 42;

  function octokitWith(repos: Record<string, unknown>): RealGitHubOctokitLike {
    return {
      pulls: {
        get: async () => ({
          data: { head: { sha: HEAD }, base: { sha: 'c'.repeat(40), ref: BASE } },
        }),
      },
      repos: {
        compareCommits: async () => ({ data: { files: [{ filename: 'a.ts', patch: '+ ok' }] } }),
        ...repos,
      },
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] },
        }),
      },
    } as unknown as RealGitHubOctokitLike;
  }

  test('25 the App 403 is rescued by the PAT client end to end', async () => {
    const appClient = octokitWith({
      getAllStatusCheckContexts: async () => {
        throw appPermissionError();
      },
    });
    const patClient = octokitWith({
      getAllStatusCheckContexts: async () => ({ data: ['docker-build', 'test (ubuntu-latest)'] }),
    });
    const evidence = await createRealFetchExactHeadPullRequestEvidence(
      appClient,
      patClient,
      inMemoryAttemptCounterStore
    )({
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: HEAD,
    });
    expect(evidence.requiredContexts).toEqual(['docker-build', 'test (ubuntu-latest)']);
  });

  test('26 an unprotected base branch yields an authoritative empty set', async () => {
    const client = octokitWith({
      getAllStatusCheckContexts: async () => {
        throw branchNotProtectedError();
      },
      getBranchRules: async () => ({ data: [] }),
      getBranch: async () => ({ data: { protected: false, protection: { enabled: false } } }),
    });
    const evidence = await createRealFetchExactHeadPullRequestEvidence(
      client,
      undefined,
      inMemoryAttemptCounterStore
    )({
      owner: OWNER,
      repo: 'bdc-xo',
      prNumber: PR_NUMBER,
      headSha: HEAD,
    });
    expect(evidence.requiredContexts).toEqual([]);
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(true);
  });

  test('27 UNKNOWN still surfaces as null at the adapter boundary', async () => {
    const client = octokitWith({
      getAllStatusCheckContexts: async () => {
        throw maskedNotFoundError();
      },
    });
    const evidence = await createRealFetchExactHeadPullRequestEvidence(
      client,
      undefined,
      inMemoryAttemptCounterStore
    )({
      owner: OWNER,
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: HEAD,
    });
    expect(evidence.requiredContexts).toBeNull();
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('28 past the bound the adapter flags BLOCKED and still reports null contexts', async () => {
    const client = octokitWith({
      getAllStatusCheckContexts: async () => {
        throw maskedNotFoundError();
      },
    });
    const fetchEvidence = createRealFetchExactHeadPullRequestEvidence(
      client,
      undefined,
      inMemoryAttemptCounterStore
    );
    const request = { owner: OWNER, repo: REPO, prNumber: PR_NUMBER, headSha: HEAD };
    let evidence = await fetchEvidence(request);
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS - 1; i += 1) {
      expect(evidence.requiredContexts).toBeNull();
      expect(evidence.requiredContextsBlocked).toBeUndefined();
      evidence = await fetchEvidence(request);
    }
    // The forever-defer loop is now bounded -- but bounded into a BLOCK, not
    // into an approval path. The contexts are still unknown, so the fail-closed
    // `null` is preserved and only the separate flag changes.
    expect(evidence.requiredContextsBlocked).toEqual({
      reason: 'required_contexts_unavailable_blocked',
      attempts: DEFAULT_MAX_ATTEMPTS,
      failureKind: 'permission',
    });
    expect(evidence.requiredContexts).toBeNull();
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);
  });

  test('29 NEGATIVE: green reported checks with unknown mandatory contexts never approve', async () => {
    // The fail-open trap this whole fix exists to avoid. The mocked check suite
    // reports exactly one check, completed and successful. If exhaustion ever
    // downgraded to the reported-checks heuristic, this PR would sail through
    // while its mandatory contexts (docker-build, test) never ran at all.
    const client = octokitWith({
      getAllStatusCheckContexts: async () => {
        throw appPermissionError();
      },
    });
    const fetchEvidence = createRealFetchExactHeadPullRequestEvidence(
      client,
      undefined,
      inMemoryAttemptCounterStore
    );
    const request = { owner: OWNER, repo: REPO, prNumber: PR_NUMBER, headSha: HEAD };
    let evidence = await fetchEvidence(request);
    for (let i = 0; i < DEFAULT_MAX_ATTEMPTS - 1; i += 1) {
      evidence = await fetchEvidence(request);
    }
    expect(evidence.checks).toEqual([{ name: 'test', status: 'completed', conclusion: 'success' }]);
    expect(evidence.requiredContextsBlocked).toBeDefined();
    // Terminality is still refused, so the model is never invoked and no
    // APPROVE can be produced from this evidence.
    expect(checksAreTerminal(evidence.checks, evidence.requiredContexts)).toBe(false);

    const result = await evaluatePullRequest(
      {
        owner: OWNER,
        repo: REPO,
        pr_number: PR_NUMBER,
        head_sha: HEAD,
      },
      {
        reviewer: { provider: 'anthropic', model: 'test-model' },
        fetchEvidence: async () => evidence,
        fetchAcceptanceCriteria: async () => null,
        invokeModel: async () => {
          throw new Error('the model must never be invoked on blocked evidence');
        },
      }
    );
    expect(result.verdict).toBe('CHECKS_UNAVAILABLE');
    expect(result.verdict).not.toBe('APPROVE');
    expect(result.findings).toEqual([]);
    expect(result.error).toContain('required_contexts_unavailable_blocked');
  });
});

describe('resolveRequiredContexts -- helpers', () => {
  test('30 resolveMaxAttempts falls back on invalid input', () => {
    expect(resolveMaxAttempts(undefined)).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts('')).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts('nonsense')).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts('0')).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts('-3')).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(resolveMaxAttempts('7')).toBe(7);
  });

  test('31 isPermissionFailure recognises the incident signature', () => {
    expect(isPermissionFailure(appPermissionError())).toBe(true);
    expect(isPermissionFailure(maskedNotFoundError())).toBe(true);
    expect(isPermissionFailure(Object.assign(new Error('Bad gateway'), { status: 502 }))).toBe(
      false
    );
    expect(isPermissionFailure(undefined)).toBe(false);
  });
});
