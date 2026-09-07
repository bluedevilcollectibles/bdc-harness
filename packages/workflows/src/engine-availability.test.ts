/**
 * Tests for engine-availability.ts (M-20260726-87 Cause 1).
 *
 * T1: binding detection rule fires ONLY on tokens.input==0 AND
 *     tokens.output==0 AND cost==0 -- never derived from an error string.
 * T2: any nonzero token/cost leaves the engine usable (climbs/retries
 *     through existing machinery unchanged).
 * T3: marked engine is dark until its cooldown expires, then auto-recovers.
 * T4: every mark and expiry produces an event payload (event-store
 *     reconstructability requirement).
 * T5: marking is per-engine -- marking one engine never darkens another.
 * T6: resolveRouterEngine bridges (provider, declared model) -> router.yaml
 *     engine key for the known fable/sonnet/opus/haiku/codex bindings.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  isZeroUsageSignature,
  markEngineDarkIfZeroUsage,
  isEngineDark,
  sweepExpiredMarks,
  listDarkEngines,
  resolveRouterEngine,
  resetEngineAvailabilityForTests,
  DEFAULT_COOLDOWN_MS,
} from './engine-availability';

const CTX = { runId: 'run-1', nodeId: 'plan' };

beforeEach(() => {
  resetEngineAvailabilityForTests();
});

describe('isZeroUsageSignature -- BINDING DETECTION RULE', () => {
  it('T1a: true when input==0, output==0, cost==0', () => {
    expect(isZeroUsageSignature({ input: 0, output: 0 }, 0)).toBe(true);
  });

  it('T1b: true when input==0, output==0, cost undefined (treated as no cost evidence)', () => {
    expect(isZeroUsageSignature({ input: 0, output: 0 }, undefined)).toBe(true);
  });

  it('T2a: false when output has flowed even if cost is 0 (the sonnet 6254/2 case from the motion)', () => {
    expect(isZeroUsageSignature({ input: 6254, output: 2 }, 0)).toBe(false);
  });

  it('T2b: false when cost is positive even if tokens are reported zero', () => {
    expect(isZeroUsageSignature({ input: 0, output: 0 }, 0.01)).toBe(false);
  });

  it('T2c: false when tokens are entirely absent (no usage data is not evidence of zero usage)', () => {
    expect(isZeroUsageSignature(undefined, 0)).toBe(false);
  });

  it('T2d: false when only one of input/output is present', () => {
    expect(isZeroUsageSignature({ input: 0 }, 0)).toBe(false);
  });

  it('never derives from an error message -- the function has no string/message parameter at all', () => {
    // Structural guarantee: isZeroUsageSignature's signature only accepts
    // (tokens, cost). There is no way to pass "SDK returned success" to it.
    expect(isZeroUsageSignature.length).toBe(2);
  });
});

describe('markEngineDarkIfZeroUsage', () => {
  it('T1: marks dark and returns an event payload on the zero-usage signature', () => {
    const result = markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, CTX);
    expect(result).not.toBeNull();
    expect(result?.event).toBe('engine_marked_dark');
    expect(result?.engine).toBe('fable-session');
    expect(result?.cooldownMs).toBe(DEFAULT_COOLDOWN_MS);
    expect(isEngineDark('fable-session')).toBe(true);
  });

  it('T2: no-op (returns null, does not mark) when tokens flowed', () => {
    const result = markEngineDarkIfZeroUsage(
      'sonnet-subscription',
      { input: 6254, output: 2 },
      0,
      CTX
    );
    expect(result).toBeNull();
    expect(isEngineDark('sonnet-subscription')).toBe(false);
  });

  it('T5: marking one engine does not darken another', () => {
    markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, CTX);
    expect(isEngineDark('fable-session')).toBe(true);
    expect(isEngineDark('opus-api')).toBe(false);
    expect(isEngineDark('sonnet-subscription')).toBe(false);
  });

  it('re-marking a still-dark engine refreshes the window and increments hitCount', () => {
    const now = 1_000_000;
    const first = markEngineDarkIfZeroUsage(
      'fable-session',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now
    );
    const second = markEngineDarkIfZeroUsage(
      'fable-session',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now + 1000
    );
    expect(first?.hitCount).toBe(1);
    expect(second?.hitCount).toBe(2);
    expect(second?.markedAt).not.toBe(first?.markedAt);
  });
});

describe('T3: cooldown expiry', () => {
  it('engine is dark immediately after marking, usable again once expired', () => {
    const now = 1_000_000;
    markEngineDarkIfZeroUsage(
      'fable-session',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now
    );
    expect(isEngineDark('fable-session', now)).toBe(true);
    expect(isEngineDark('fable-session', now + DEFAULT_COOLDOWN_MS - 1)).toBe(true);
    expect(isEngineDark('fable-session', now + DEFAULT_COOLDOWN_MS)).toBe(false);
    expect(isEngineDark('fable-session', now + DEFAULT_COOLDOWN_MS + 1)).toBe(false);
  });

  it('respects a custom cooldown window', () => {
    const now = 1_000_000;
    const fiveMin = 5 * 60 * 1000;
    markEngineDarkIfZeroUsage('opus-api', { input: 0, output: 0 }, 0, CTX, fiveMin, now);
    expect(isEngineDark('opus-api', now + fiveMin - 1)).toBe(true);
    expect(isEngineDark('opus-api', now + fiveMin)).toBe(false);
  });
});

describe('T4: mandatory expiry + event-store reconstructability', () => {
  it('sweepExpiredMarks removes expired marks and returns an event payload per engine', () => {
    const now = 1_000_000;
    markEngineDarkIfZeroUsage(
      'fable-session',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now
    );
    markEngineDarkIfZeroUsage(
      'opus-api',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now
    );

    // Not yet expired.
    expect(sweepExpiredMarks(now + 1000)).toEqual([]);

    const expired = sweepExpiredMarks(now + DEFAULT_COOLDOWN_MS + 1);
    expect(expired).toHaveLength(2);
    expect(expired.map(e => e.event)).toEqual(['engine_mark_expired', 'engine_mark_expired']);
    expect(expired.map(e => e.engine).sort()).toEqual(['fable-session', 'opus-api']);
    expect(isEngineDark('fable-session', now + DEFAULT_COOLDOWN_MS + 1)).toBe(false);
    expect(listDarkEngines(now + DEFAULT_COOLDOWN_MS + 1)).toEqual([]);
  });

  it('every mark event carries the triggering run/node for reconstructability', () => {
    const result = markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, {
      runId: 'run-abc',
      nodeId: 'plan-review',
    });
    expect(result?.triggeringRunId).toBe('run-abc');
    expect(result?.triggeringNodeId).toBe('plan-review');
  });

  it('listDarkEngines reflects only currently-dark, non-expired engines', () => {
    const now = 1_000_000;
    markEngineDarkIfZeroUsage(
      'fable-session',
      { input: 0, output: 0 },
      0,
      CTX,
      DEFAULT_COOLDOWN_MS,
      now
    );
    expect(listDarkEngines(now)).toEqual(['fable-session']);
    expect(listDarkEngines(now + DEFAULT_COOLDOWN_MS + 1)).toEqual([]);
  });
});

describe('T6: resolveRouterEngine -- provider+model to router.yaml engine bridge', () => {
  it('maps claude-fable-5 to fable-session', () => {
    expect(resolveRouterEngine('claude', 'claude-fable-5')).toBe('fable-session');
  });

  it('maps sonnet variants to sonnet-subscription', () => {
    expect(resolveRouterEngine('claude', 'claude-sonnet-5')).toBe('sonnet-subscription');
    expect(resolveRouterEngine('claude', 'sonnet')).toBe('sonnet-subscription');
  });

  it('maps opus variants (alias and [1m]) to opus-api', () => {
    expect(resolveRouterEngine('claude', 'claude-opus-5')).toBe('opus-api');
    expect(resolveRouterEngine('claude', 'opus')).toBe('opus-api');
    expect(resolveRouterEngine('claude', 'opus[1m]')).toBe('opus-api');
  });

  it('maps codex provider (any model) to codex-subscription', () => {
    expect(resolveRouterEngine('codex', 'gpt-5.6-sol')).toBe('codex-subscription');
    expect(resolveRouterEngine('codex', undefined)).toBe('codex-subscription');
    expect(resolveRouterEngine('codex-native-strict', 'gpt-6-astra')).toBe('codex-subscription');
  });

  it('returns undefined for unknown provider/model combinations rather than guessing', () => {
    expect(resolveRouterEngine('claude', 'some-unrelated-future-model')).toBeUndefined();
    expect(resolveRouterEngine('pi', 'anthropic/claude-haiku-4-5')).toBeUndefined();
  });
});
