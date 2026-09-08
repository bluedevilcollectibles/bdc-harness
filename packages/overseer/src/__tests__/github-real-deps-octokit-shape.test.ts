/**
 * The adapter's octokit method NAMES, checked against the REAL Octokit class.
 *
 * #777 review raised this class of defect: `RealGitHubOctokitLike` is a
 * hand-written structural stand-in, the real clients reach it through
 * `as unknown as RealGitHubOctokitLike`, and every other test in this package
 * supplies a HAND MOCK. So a name we invent -- or a name Octokit renames out
 * from under us -- is invisible three ways over: the cast suppresses the type
 * error, the mocks implement whatever we invented, and the only symptom at
 * runtime is `bindRepoMethod` returning `undefined`. That silently disables
 * positive unprotected-branch detection, so the probe never answers, the
 * attempt counter climbs, and a genuinely unprotected base branch gets BLOCKED
 * instead of resolving to an authoritative empty context set.
 *
 * These tests therefore deliberately use NO mock for the shape assertions: they
 * instantiate the real `Octokit` and interrogate what it actually exposes.
 *
 * The review that prompted this file asserted the correct name was
 * `getRulesForBranch`. That is NOT true of the installed client, and adopting it
 * would have introduced the exact bug described. Verified 2026-09-08 against
 * @octokit/rest 22.0.1 / plugin-rest-endpoint-methods 17.0.0, both by reading
 * the generated endpoints and by the runtime assertions below. These tests are
 * the durable record of that check: if a future Octokit really does rename the
 * method, test 3 fails loudly instead of the reviewer being right by accident.
 *
 * A compile-time guard (`BOUND_REPOS_METHODS` in github-real-deps.ts) covers the
 * same ground statically; this file covers it at runtime, because the cast means
 * only one of those two is load-bearing on its own.
 */
import { describe, expect, test } from 'bun:test';
import { Octokit } from '@octokit/rest';
import {
  BOUND_REPOS_METHODS,
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import { inMemoryAttemptCounterStore } from '../adapters/required-contexts.ts';

/**
 * Imported, never re-declared. A local copy of the list could drift from the one
 * the adapter actually binds, and then these tests would be asserting about
 * names nothing uses -- the same "the test checks the mock, not the code"
 * failure that let the original defect through.
 */
const BOUND_METHODS = BOUND_REPOS_METHODS;

/** A real client. The token is never used -- nothing here performs a request. */
function realOctokit(): Octokit {
  return new Octokit({ auth: 'test-token-never-sent' });
}

describe('adapter octokit method names -- against the real Octokit, not a mock', () => {
  test('1 every bound repos method exists as a function on the real client', () => {
    const repos = realOctokit().repos as unknown as Record<string, unknown>;
    for (const method of BOUND_METHODS) {
      // A missing name here is the #777 failure mode: bindRepoMethod would
      // return undefined and the capability would be silently dead.
      expect(typeof repos[method]).toBe('function');
    }
  });

  test('2 the branch-rules method points at the rules endpoint the resolver needs', () => {
    const repos = realOctokit().repos as unknown as Record<
      string,
      { endpoint?: { DEFAULTS?: { method?: string; url?: string } } }
    >;
    const defaults = repos.getBranchRules?.endpoint?.DEFAULTS;
    // Positive unprotected evidence depends on THIS route specifically. A method
    // that exists but addresses something else would fail just as quietly.
    expect(defaults?.method).toBe('GET');
    expect(defaults?.url).toBe('/repos/{owner}/{repo}/rules/branches/{branch}');
  });

  test('3 getRulesForBranch is NOT the name on this client', () => {
    const repos = realOctokit().repos as unknown as Record<string, unknown>;
    // Pinned deliberately. If a future @octokit/rest introduces or renames to
    // getRulesForBranch, this fails and forces the adapter to be updated
    // together with the compile-time guard -- rather than the rename silently
    // disabling unprotected-branch detection again.
    expect(repos.getRulesForBranch).toBeUndefined();
    expect(typeof repos.getBranchRules).toBe('function');
  });

  test('4 the adapter binds real methods when built over a real Octokit instance', async () => {
    // The end-to-end shape check: construct the adapter exactly as production
    // does -- real client, same cast -- and prove the bound probes actually
    // reach the client instead of being undefined.
    const client = realOctokit();
    const calls: string[] = [];
    const repos = client.repos as unknown as Record<string, unknown>;
    for (const method of BOUND_METHODS) {
      const original = repos[method];
      expect(typeof original).toBe('function');
      // Replace with a recorder that keeps the real property NAME. If the
      // adapter looked up a name the client does not have, nothing records.
      repos[method] = () => {
        calls.push(method);
        return Promise.resolve({ data: [] });
      };
    }
    // getBranch must answer an object, not an array, for the probe to parse.
    repos.getBranch = () => {
      calls.push('getBranch');
      return Promise.resolve({ data: { protected: false, protection: { enabled: false } } });
    };
    // Minimal PR/compare/checks surface so evidence collection reaches the
    // required-contexts resolver, which is what drives the bound probes.
    const stub = client as unknown as Record<string, unknown>;
    stub.pulls = {
      get: () =>
        Promise.resolve({
          data: { head: { sha: 'a'.repeat(40) }, base: { sha: 'c'.repeat(40), ref: 'dev' } },
        }),
    };
    stub.checks = { listForRef: () => Promise.resolve({ data: { check_runs: [] } }) };
    repos.compareCommits = () => Promise.resolve({ data: { files: [] } });

    const evidence = await createRealFetchExactHeadPullRequestEvidence(
      client as unknown as RealGitHubOctokitLike,
      undefined,
      inMemoryAttemptCounterStore
    )({ owner: 'thinmansoftware', repo: 'bdc-harness', prNumber: 1, headSha: 'a'.repeat(40) });

    // The contexts probe was reached through a name the real client has.
    expect(calls).toContain('getAllStatusCheckContexts');
    // And an empty required set came back as an AUTHORITATIVE answer rather than
    // the unknown/blocked path a dead probe would have produced.
    expect(evidence.requiredContexts).toEqual([]);
    expect(evidence.requiredContextsBlocked).toBeUndefined();
  });
});
