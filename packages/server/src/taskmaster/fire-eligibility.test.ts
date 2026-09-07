import { describe, expect, test } from 'bun:test';
import { checkFireEligibility } from './fire-eligibility';
const TITLE = 'P1: WO-HARNESS-EXAMPLE-01 needs building';
const SPEC = 'cauldron_compatible: true\ntarget_repo: thinmansoftware/bdc-harness\n';
const SHA = 'a'.repeat(40);
function response(body: unknown, status = 200, remaining = '100'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'x-ratelimit-remaining': remaining },
  });
}
const TOKEN = 'ghp-test-token';
function deps(spec = SPEC, prs: unknown[] = []) {
  return {
    now: () => new Date('2026-08-24T10:00:00.000Z'),
    githubToken: TOKEN,
    codebases: async () => [
      { name: 'bdc-harness', repository_url: 'https://github.com/thinmansoftware/bdc-harness.git' },
    ],
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/'))
        return response({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(spec).toString('base64'),
        });
      return response({ items: prs });
    }) as typeof fetch,
  };
}
describe('checkFireEligibility', () => {
  test('uses current canonical precedence and carries immutable identity', async () => {
    const result = await checkFireEligibility(TITLE, deps());
    expect(result.eligible).toBe(true);
    expect(result.evidence?.expectedSpec?.specSource).toBe(
      'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md'
    );
    expect(result.evidence?.expectedSpec?.specRevision).toBe(SHA);
    expect(result.evidence?.expectedSpec?.specHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  test('falls back to the exact secondary committed path', async () => {
    const configured = deps();
    const original = configured.fetchImpl;
    configured.fetchImpl = async (url, init) =>
      String(url).includes('/contents/docs/work-orders/') ? response({}, 404) : original(url, init);
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.eligible).toBe(true);
    expect(result.evidence?.specSource).toBe('repo-path');
    expect(result.evidence?.expectedSpec?.specSource).toEndWith(
      'docs/superpowers/specs/WO-HARNESS-EXAMPLE-01.md'
    );
  });
  test('issue-author fields cannot grant execution authority, including harness208 replay', async () => {
    const seen: string[] = [];
    const configured = deps();
    configured.fetchImpl = async input => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/')) return response({}, 404);
      return response({ items: [{ number: 208, title: TITLE }], body: SPEC });
    };
    for (const title of [TITLE, 'WO-SOCIAL-WIRE-ALL-META-PAGES-01']) {
      expect(await checkFireEligibility(title, configured)).toEqual({
        eligible: false,
        reason: 'spec_missing',
      });
    }
    expect(seen.some(url => url.includes('/search/') || url.includes('/issues/'))).toBe(false);
  });
  test('rejects missing revision', async () => {
    const configured = deps();
    configured.fetchImpl = async () => response({}, 404);
    expect(await checkFireEligibility(TITLE, configured)).toEqual({
      eligible: false,
      reason: 'spec_missing',
    });
  });
  test('preserves compatibility, target, registration and exact PR guards', async () => {
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: false'))).reason).toBe(
      'cauldron_incompatible'
    );
    expect((await checkFireEligibility(TITLE, deps('cauldron_compatible: true'))).reason).toBe(
      'target_repo_missing'
    );
    const configured = deps();
    configured.codebases = async () => [];
    expect((await checkFireEligibility(TITLE, configured)).reason).toBe('project_not_registered');
    expect(
      (
        await checkFireEligibility(
          TITLE,
          deps(SPEC, [{ title: 'WO-HARNESS-EXAMPLE-01', state: 'open' }])
        )
      ).reason
    ).toBe('pr_exists');
    expect(
      (
        await checkFireEligibility(
          TITLE,
          deps(SPEC, [{ title: 'WO-HARNESS-EXAMPLE-010', state: 'open' }])
        )
      ).eligible
    ).toBe(true);
  });
  test('backs off at the shared GitHub rate-limit floor', async () => {
    const configured = deps();
    configured.fetchImpl = async () => response({}, 200, '4');
    await expect(checkFireEligibility(TITLE, configured)).rejects.toThrow('rate_limit_backoff');
  });
  test('authenticates the canonical ref and content reads, not just the PR search', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const configured = deps();
    const original = configured.fetchImpl;
    configured.fetchImpl = async (url, init) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init?.headers ?? {}).get('authorization'),
      });
      return original(url, init);
    };
    const result = await checkFireEligibility(TITLE, configured);
    expect(result.eligible).toBe(true);
    const canonical = seen.filter(
      call => call.url.includes('/git/ref/') || call.url.includes('/contents/')
    );
    expect(canonical.length).toBeGreaterThan(0);
    // The finding: canonical reads previously went out anonymous, breaking
    // private-repo access and dropping to the 60/hr unauthenticated limit.
    for (const call of canonical) expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
  test('fails closed when no GitHub token is resolvable instead of reading anonymously', async () => {
    const priorGithub = process.env.GITHUB_TOKEN;
    const priorGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    try {
      const seen: string[] = [];
      const configured = deps();
      const original = configured.fetchImpl;
      configured.githubToken = undefined;
      configured.fetchImpl = async (url, init) => {
        seen.push(String(url));
        return original(url, init);
      };
      expect(await checkFireEligibility(TITLE, configured)).toEqual({
        eligible: false,
        reason: 'github_auth_missing',
      });
      expect(seen).toEqual([]);
    } finally {
      if (priorGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = priorGithub;
      if (priorGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = priorGh;
    }
  });
  test('keeps spec-on-main policy: issue fields never grant when the spec is absent', async () => {
    const seen: string[] = [];
    const configured = deps();
    configured.fetchImpl = async input => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/git/ref/')) return response({ object: { sha: SHA } });
      if (url.includes('/contents/')) return response({}, 404);
      return response({ items: [{ number: 208, title: TITLE, body: SPEC }] });
    };
    expect(await checkFireEligibility(TITLE, configured)).toEqual({
      eligible: false,
      reason: 'spec_missing',
    });
    expect(seen.some(url => url.includes('/issues/'))).toBe(false);
  });
});
