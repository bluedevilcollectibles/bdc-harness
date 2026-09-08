import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildAgentInvocation, defaultAgentConfigs, parseFusionReviewBody } from './adapters';

describe('dispatch worker adapters', () => {
  test('ships read-only invocation contracts for installed desktop agents', () => {
    const prompt = 'Reply with exactly: ROUND_TRIP_OK';
    expect(buildAgentInvocation(defaultAgentConfigs.claude, prompt).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.codex, prompt).args).toContain('read-only');
    expect(buildAgentInvocation(defaultAgentConfigs.grok, prompt).args).toContain('plan');
    expect(buildAgentInvocation(defaultAgentConfigs.cursor, prompt).args).toContain('ask');
  });

  test('keeps prompt text out of argv for every prompt-kind seat', () => {
    const prompt = 'summarize; git push && deploy';
    for (const seat of Object.values(defaultAgentConfigs)) {
      if ((seat.kind ?? 'prompt') !== 'prompt') continue;
      const invocation = buildAgentInvocation(seat, prompt);
      expect(invocation.args.every(arg => !arg.includes(prompt))).toBe(true);
    }
  });

  test('registers ACP seats without removing the CLI fallback (M-118 order 5)', () => {
    // The ruling forbids removing a working CLI/SDK fallback before its ACP
    // path proves equivalent auth and capabilities. Both must coexist.
    expect(defaultAgentConfigs.grok.kind ?? 'prompt').toBe('prompt');
    expect(defaultAgentConfigs.claude.kind ?? 'prompt').toBe('prompt');
    expect(defaultAgentConfigs['grok-acp']?.kind).toBe('acp');
    expect(defaultAgentConfigs['claude-acp']?.kind).toBe('acp');
  });

  test('grok ACP seat uses the proven stdio command and cached-token auth', () => {
    // Anchored to M-20260802-118.acp-compatibility-proof.md: `grok agent stdio`
    // authenticated via cached_token with no API key passed.
    const seat = defaultAgentConfigs['grok-acp'];
    expect(seat?.command).toBe('grok');
    expect(seat?.args).toEqual(['agent', 'stdio']);
    expect(seat?.acp?.authMethodId).toBe('cached_token');
  });

  test('ACP seats carry no inline credential material', () => {
    // Rule 6: a wrapper demanding a raw key is a finding to report, never a
    // secret to embed in argv or config.
    for (const [name, seat] of Object.entries(defaultAgentConfigs)) {
      if (seat.kind !== 'acp') continue;
      const argv = [seat.command, ...seat.args].join(' ');
      expect(argv, `${name} argv must not contain key-like material`).not.toMatch(
        /sk-|api[-_]?key|token=|Bearer /i
      );
    }
  });

  test('fusion accepts only a structured advisory review artifact set', () => {
    expect(
      parseFusionReviewBody(
        JSON.stringify({
          wo: 'C:/safe/wo.md',
          diff: 'C:/safe/diff.patch',
          tests: 'C:/safe/tests.txt',
          manifest: 'C:/safe/manifest.txt',
        })
      )
    ).toEqual({
      wo: 'C:/safe/wo.md',
      diff: 'C:/safe/diff.patch',
      tests: 'C:/safe/tests.txt',
      manifest: 'C:/safe/manifest.txt',
    });
    expect(() => parseFusionReviewBody('review this raw prompt')).toThrow(
      'fusion_review_body_invalid'
    );
  });
});

/**
 * #795 -- the tracked codex seat default could not run ANY command on Windows.
 *
 * `--ignore-user-config` drops `[windows] sandbox = "unelevated"` from
 * ~/.codex/config.toml, and this codex build cannot construct a Windows sandbox
 * without an explicit mode. With none, and `exec` running at approval `never`,
 * every tool call -- including a plain file read -- came back as
 * `Rejected(... "blocked by policy")`, which READS LIKE A PERMISSIONS DECISION.
 * That is why the seat went mute unnoticed from PR #462 (2026-07-10) until it
 * was reproduced on 2026-09-08.
 */
describe('#795 codex seat Windows sandbox mode', () => {
  test('the default codex args carry the -c windows.sandbox="unelevated" pair', () => {
    const args = defaultAgentConfigs.codex.args;
    const flagIndex = args.indexOf('-c');

    expect(flagIndex).toBeGreaterThanOrEqual(0);
    // The pair, in order: a `-c` whose value landed elsewhere configures nothing.
    expect(args[flagIndex + 1]).toBe('windows.sandbox="unelevated"');
  });

  test('the pair is UNCONDITIONAL -- the source carries no platform branch', () => {
    // The key is inert on Linux and macOS. A platform-gated default would make
    // the tracked config differ from what a reader sees, which is exactly how a
    // seat works in one environment and goes mute in another. This asserts it
    // against the SOURCE, because a runtime check can only ever observe the
    // platform the suite happens to be running on.
    const source = readFileSync(new URL('./adapters.ts', import.meta.url), 'utf8');
    const codexBlock = source.slice(source.indexOf('  codex: {'), source.indexOf('  grok: {'));
    // Comments are stripped first: the block's own doc comment EXPLAINS that the
    // pair is unconditional, and matching that prose would fail the very test it
    // documents.
    const code = codexBlock.replace(/\/\/.*$/gm, '');

    expect(code).toContain('windows.sandbox="unelevated"');
    expect(code).not.toContain('process.platform');
    expect(code).not.toContain('win32');
    expect(code).not.toMatch(/\?|&&|\|\|/);
  });

  test('the override sits AFTER --ignore-user-config, which is what drops the key', () => {
    const args = defaultAgentConfigs.codex.args;
    expect(args.indexOf('-c')).toBeGreaterThan(args.indexOf('--ignore-user-config'));
  });

  test('the seat is still read-only, ephemeral and user-config-free', () => {
    // The fix adds ONE key. Dropping --ignore-user-config instead would load
    // hooks, every MCP server, `sandbox_mode = "danger-full-access"`, and a
    // shell_environment_policy.set block that injects live secrets.
    const args = defaultAgentConfigs.codex.args;
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('the pair survives prompt building and never carries the prompt', () => {
    const invocation = buildAgentInvocation(defaultAgentConfigs.codex, 'read CLAUDE.md');
    const flagIndex = invocation.args.indexOf('-c');

    expect(invocation.args[flagIndex + 1]).toBe('windows.sandbox="unelevated"');
    expect(invocation.args).not.toContain('read CLAUDE.md');
  });
});
