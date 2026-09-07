/**
 * cascade.test.ts -- Test scenarios 2-6 for Smart Cauldron v1.0 cascade orchestrator.
 *
 * All tests use CascadeDeps injection -- no live API calls.
 * Fire, poll, judge, escalate, and writeRecord are all stubbed.
 *
 * Test 2: CLIMB-ON-GATE-FAIL -- gate fails on tier 0, passes on tier 1
 * Test 3: WIN-CHEAP -- gate passes on entry tier (no climb)
 * Test 4: INFRA-ERROR vs GATE-FAIL -- infra error triggers alert, not climb
 * Test 5: FRONTIER-STOP -- frontier gate-fail -> BLOCKED + alert, no infinite loop
 * Test 6: WRAPPER -- cascade does not touch DAG/workflow internals
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult, PollResult, GateVerdict, CascadeRunRecord } from '../types.js';
import { loadLadder, loadRefusedTiers } from '../ladder.js';

/** Live ladder = canonical ladder minus refused (dark/retired) tiers.
 *  Ruleset entry picks promote onto this ladder (entry floor semantics,
 *  2026-08-25 OpenRouter defunding). */
function loadLiveTiers() {
  const refused = loadRefusedTiers();
  return loadLadder().filter(t => !refused.includes(t.name));
}
import { loadRuleset } from '../conductor.js';
import { TimeoutError } from '../poll.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A PollResult that trivially exists (used when only the gate stub matters) */
function makePollResult(overrides?: Partial<PollResult>): PollResult {
  return {
    runId: 'run-stub',
    terminalStatus: 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/1',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: {},
    ...overrides,
  };
}

function makeFireOk(runId: string, conversationId = 'conv-stub'): FireResult {
  return { ok: true, runId, conversationId, infraError: null };
}

function makeFireError(infraError: string, conversationId = 'conv-stub'): FireResult {
  return { ok: false, runId: null, conversationId, infraError };
}

function makePassVerdict(): GateVerdict {
  return {
    pass: true,
    reason: 'all gate conditions passed',
    cancelled: false,
    validatorVerdict: 'satisfied',
    prOpened: true,
    prMergeable: true,
    terminalStatus: 'completed',
  };
}

function makeFailVerdict(reason: string): GateVerdict {
  return {
    pass: false,
    reason,
    cancelled: false,
    validatorVerdict: 'needs_revision',
    prOpened: false,
    prMergeable: null,
    terminalStatus: 'failed',
  };
}

/** Windows CI runners are slow enough that the first cascade test in the file
 *  (which pays module + config cold-start plus real wo-lock file IO) crosses
 *  Bun's 5000ms default (~5016ms observed on windows-latest, 2026-08-25: PRs
 *  #701/#703/#705/#710). Known timeout class: reference_windows-ci-timeout-class-bun-5000.
 *  Ubuntu is always green -- this is runner speed, not product code. */
const SLOW_TEST_TIMEOUT_MS = 30_000;

/** Root for this test run's outDirs -- removed after the suite. */
const testOutRoot = join(tmpdir(), `smart-cauldron-test-runs-${randomUUID()}`);
afterAll(async () => {
  await rm(testOutRoot, { recursive: true, force: true });
});

/** Build base options pointing to the real config (entry defaults to codex).
 *
 *  outDir is UNIQUE PER CALL. Most tests here omit deps.acquireWoLock, so the
 *  REAL wo-lock runs against outDir keyed on the shared woId 'WO-TEST-001'.
 *  With a shared outDir, one test dying mid-cascade (e.g. a Windows timeout)
 *  leaves its lock file behind and every later cascade test fails with
 *  "REFUSING duplicate cascade" -- one flake poisoned the whole suite
 *  (2026-08-25 windows-latest). A per-test outDir makes each cascade's lock
 *  namespace disposable, so no test can contaminate another. */
function baseOpts(partial: Partial<RunCascadeOptions> = {}): RunCascadeOptions {
  return {
    woId: 'WO-TEST-001',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: join(testOutRoot, randomUUID()),
    token: 'test-token',
    project: 'test-project',
    ...partial,
  };
}

test('cascade preserves the eligibility identity on every attempted lane', async () => {
  const expectedSpec = {
    specSource: 'github:org/repo:docs/WO-TEST-001.md',
    specRevision: 'a'.repeat(40),
    specHash: `sha256:${'b'.repeat(64)}`,
  };
  const messages: string[] = [];
  await runCascade(
    baseOpts({
      expectedSpec,
      deps: {
        findWoClaim: async () => null,
        fire: async options => {
          messages.push(options.message);
          return makeFireOk('run-bound');
        },
        poll: async () => makePollResult(),
        judge: async () => makePassVerdict(),
        writeRecord: async () => {},
      },
    })
  );
  expect(messages.length).toBeGreaterThan(0);
  for (const message of messages) {
    const encoded = message.split('\n')[0].split(' --expected-spec=')[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual(expectedSpec);
  }
});

// ---------------------------------------------------------------------------
// Auth/project binding guards
// ---------------------------------------------------------------------------

describe('auth/project binding guards', () => {
  test(
    'lane preflight failure is recorded and prevents provider fire',
    async () => {
      let fireCalled = false;
      const deps: CascadeDeps = {
        preflight: async tier => {
          throw new Error(`workflow ${tier.workflowName} is unavailable`);
        },
        fire: async () => {
          fireCalled = true;
          return makeFireOk('should-not-fire');
        },
        escalate: async () => undefined,
        writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      };

      const result = await runCascade(baseOpts({ deps }));

      expect(fireCalled).toBe(false);
      expect(result.status).toBe('infra-alert');
      expect(result.attempts[0]?.outcome).toBe('infra-error');
      expect(result.attempts[0]?.infraErrorReason).toContain('is unavailable');
    },
    SLOW_TEST_TIMEOUT_MS
  );

  test('missing project throws before firing', async () => {
    let fireCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCalled = true;
        return makeFireOk('should-not-fire');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await expect(runCascade(baseOpts({ deps, project: undefined }))).rejects.toThrow(
      '--project is required'
    );
    expect(fireCalled).toBe(false);
  });

  test('runCascade passes token to fire/poll/cancel and includes project in fire message', async () => {
    const fireOpts: Array<Parameters<NonNullable<CascadeDeps['fire']>>[0]> = [];
    const pollOpts: Array<Parameters<NonNullable<CascadeDeps['poll']>>[0]> = [];
    const cancelOpts: Array<Parameters<NonNullable<CascadeDeps['cancel']>>[0]> = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireOpts.push(opts);
        return makeFireOk(`run-${fireOpts.length}`);
      },
      poll: async opts => {
        pollOpts.push(opts);
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError('poll timeout');
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async opts => {
        cancelOpts.push(opts);
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('won');
    expect(fireOpts.length).toBe(2);
    expect(pollOpts.length).toBe(2);
    expect(cancelOpts.length).toBe(1);

    expect(fireOpts.every(opts => opts.token === 'test-token')).toBe(true);
    expect(fireOpts.every(opts => opts.project === 'test-project')).toBe(true);
    expect(
      fireOpts.every(opts => opts.message.startsWith('WO_ID=WO-TEST-001 --project test-project'))
    ).toBe(true);
    expect(pollOpts.every(opts => opts.token === 'test-token')).toBe(true);
    expect(cancelOpts[0]?.token).toBe('test-token');
    expect(cancelOpts[0]?.runId).toBe('run-1');
  });
});

// ---------------------------------------------------------------------------
// Test 2: CLIMB-ON-GATE-FAIL
// ---------------------------------------------------------------------------

describe('Test 2: CLIMB-ON-GATE-FAIL', () => {
  test('gate fails on tier 0, cascades to tier 1 which passes; record reflects climb', async () => {
    const fireCalls: string[] = [];
    let fireCallIndex = 0;
    const fireIds = ['run-1', 'run-2'];

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        const id = fireIds[fireCallIndex++] ?? 'run-x';
        return makeFireOk(id);
      },
      poll: async _opts => makePollResult(),
      judge: _poll => {
        // First call fails, second passes
        if (fireCalls.length === 1) return makeFailVerdict('validator verdict: needs_revision');
        return makePassVerdict();
      },
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => {
        return `/tmp/cascade-record-${record.cascadeId}.json`;
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.attempts.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.attempts[1]?.outcome).toBe('won');
    expect(record.status).toBe('won');
    expect(record.telemetry.climbed).toBe(true);
    expect(record.telemetry.climbCount).toBe(1);
    expect(record.telemetry.wonCheap).toBe(false);

    // Second fire used the next tier's workflowName
    const tiers = loadLiveTiers();
    const entryTier = tiers[0];
    const nextTier = tiers[1];
    expect(fireCalls[0]).toBe(entryTier?.workflowName);
    expect(fireCalls[1]).toBe(nextTier?.workflowName);
  });
});

// ---------------------------------------------------------------------------
// Test: PROGRESS-TIMEOUT -- cancels and climbs (not infra-error)
// ---------------------------------------------------------------------------

describe('Test: PROGRESS-TIMEOUT climbs (does not stop as infra-error)', () => {
  test('timeout cancels the hung run and climbs to the next tier', async () => {
    const fireCalls: string[] = [];
    const cancelCalls: { runId: string; apiBaseUrl: string }[] = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return makeFireOk(`run-${fireCalls.length}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError(
            '[smart-cauldron/poll] Run run-1 did not reach terminal state within 1800000ms'
          );
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async opts => {
        cancelCalls.push(opts);
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    // Cancel was called exactly once, for the hung (tier-0) run
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]?.runId).toBe('run-1');

    // Recorded as progress-timeout, NOT infra-error -- and the cascade climbed
    expect(record.attempts.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('progress-timeout');
    expect(record.attempts[0]?.outcome).not.toBe('infra-error');
    // The reason now carries the poll's own message so an operator can tell a STALL
    // (run went silent) from the hard-ceiling runaway backstop. The injected fake
    // poll throws the generic legacy message, so assert on the stable substring.
    expect(record.attempts[0]?.gateFailReason).toContain('terminal state');
    expect(record.attempts[1]?.outcome).toBe('won');

    expect(record.status).toBe('won');
    expect(record.status).not.toBe('infra-alert');
    expect(record.telemetry.climbed).toBe(true);
    expect(record.telemetry.climbCount).toBe(1);

    // Second fire used the next tier's workflowName (same climb semantics as gate-fail)
    const tiers = loadLiveTiers();
    const entryTier = tiers[0];
    const nextTier = tiers[1];
    expect(fireCalls[0]).toBe(entryTier?.workflowName);
    expect(fireCalls[1]).toBe(nextTier?.workflowName);
  });

  test('cancel failure is best-effort -- does not block the climb', async () => {
    let pollCallIndex = 0;
    let fireCount = 0;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        if (pollCallIndex === 1) {
          throw new TimeoutError('poll timeout');
        }
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async _opts => ({ ok: false, error: 'HTTP 500: cancel endpoint unavailable' }),
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(2);
    expect(record.status).toBe('won');
    expect(record.attempts[0]?.outcome).toBe('progress-timeout');
  });
});

// ---------------------------------------------------------------------------
// Test: non-timeout poll error still stops as infra-error (regression)
// ---------------------------------------------------------------------------

describe('Test: non-timeout poll error still stops as infra-error', () => {
  test('generic poll error (not TimeoutError) does not climb; infra-alert unchanged', async () => {
    let fireCount = 0;
    let escalateCalled = false;
    let cancelCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => {
        throw new Error('network error: ECONNRESET');
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async _opts => {
        cancelCalled = true;
        return { ok: true, error: null };
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(1); // no climb -- stopped after the single tier
    expect(record.status).toBe('infra-alert');
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(record.attempts[0]?.outcome).not.toBe('progress-timeout');
    expect(escalateCalled).toBe(true);
    expect(cancelCalled).toBe(false); // cancel is only invoked on TimeoutError
  });
});

// ---------------------------------------------------------------------------
// Test: poll timeout default (14400000 hard ceiling) + configurable override
// ---------------------------------------------------------------------------

describe('Test: poll timeout default + override', () => {
  test('default pollTimeoutMs passed to poll is the 14400000 hard ceiling when not overridden', async () => {
    let observedTimeoutMs: number | undefined;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireOk('run-default-timeout'),
      poll: async opts => {
        observedTimeoutMs = opts.timeoutMs;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await runCascade(baseOpts({ deps }));

    // Raised from 30min on 2026-07-25: measured successful runs reach 74.3min, so the
    // old ceiling killed healthy work. Stall detection (pollStallTimeoutMs) is now the
    // real stop condition; this is only the runaway backstop.
    expect(observedTimeoutMs).toBe(14_400_000);
    expect(observedTimeoutMs).not.toBe(1_800_000);
  });

  test('pollTimeoutMs override is threaded through to poll', async () => {
    let observedTimeoutMs: number | undefined;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireOk('run-override-timeout'),
      poll: async opts => {
        observedTimeoutMs = opts.timeoutMs;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    await runCascade(baseOpts({ deps, pollTimeoutMs: 900_000 }));

    expect(observedTimeoutMs).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
// Test 3: WIN-CHEAP
// ---------------------------------------------------------------------------

describe('Test 3: WIN-CHEAP', () => {
  test('entry tier passes gate; no second fire; wonCheap=true', async () => {
    let fireCount = 0;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk('run-cheap');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCount).toBe(1);
    expect(record.status).toBe('won');
    expect(record.telemetry.wonCheap).toBe(true);
    expect(record.telemetry.climbed).toBe(false);
    expect(record.telemetry.climbCount).toBe(0);
    expect(record.winningTier).toBe(loadLiveTiers()[0]!.name); // entry floor (refused tiers promoted past)
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('won');
  });
});

// ---------------------------------------------------------------------------
// Test 4: INFRA-ERROR vs GATE-FAIL
// ---------------------------------------------------------------------------

describe('Test 4: INFRA-ERROR vs GATE-FAIL', () => {
  test('401 fire error -> infra-alert status; poll NOT called; escalate called; outcome != gate-failed', async () => {
    let pollCalled = false;
    let escalateCalled = false;
    let escalationSource: { id: string; at: string } | null = null;

    const deps: CascadeDeps = {
      fire: async _opts => makeFireError('HTTP 401: Unauthorized'),
      poll: async _opts => {
        pollCalled = true;
        return makePollResult();
      },
      judge: _poll => makePassVerdict(),
      escalate: async ctx => {
        escalateCalled = true;
        escalationSource = { id: ctx.sourceEventId, at: ctx.sourceEventCreatedAt };
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('infra-alert');
    expect(record.attempts.length).toBe(1);
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(record.attempts[0]?.outcome).not.toBe('gate-failed');
    expect(pollCalled).toBe(false);
    expect(escalateCalled).toBe(true);
    expect(escalationSource).toEqual({
      id: `${record.cascadeId}:attempt:1`,
      at: record.attempts[0]?.startedAt,
    });
  });

  test('network error (ECONNREFUSED) -> infra-alert; not gate-failed', async () => {
    let escalateCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts =>
        makeFireError(
          '[smart-cauldron/fire] network error on POST: connect ECONNREFUSED 127.0.0.1:3090'
        ),
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('infra-alert');
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(escalateCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: FRONTIER-STOP -> SPEC-REPAIR (doctrine 2026-07-02: no terminal failure)
// ---------------------------------------------------------------------------

describe('Test 5: FRONTIER gate-fail -> SPEC-REPAIR (not plain blocked)', () => {
  test('explicit dual-supervisor hook delegates frontier recovery before terminal failure', async () => {
    let fireCount = 0;
    let specRepairCalled = false;
    const supervisorCalls: string[] = [];
    const deps: CascadeDeps = {
      fire: async () => makeFireOk(`run-${++fireCount}`),
      poll: async () => makePollResult({ terminalStatus: 'failed' }),
      judge: () => makeFailVerdict('terminal status: failed'),
      superviseFailure: async context => {
        supervisorCalls.push(context.failureKind);
        return {
          handled: true,
          ownerId: 'sol',
          fencingToken: 7,
          evidenceRefs: ['incident:recorded', 'action:refired'],
        };
      },
      specRepair: async () => {
        specRepairCalled = true;
        return { posted: true, issueRepo: 'unused', issueNumber: 1 };
      },
      writeRecord: async record => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps, entryOverride: 'frontier' }));

    expect(record.status).toBe('recovery-delegated');
    expect(supervisorCalls).toEqual(['frontier-gate']);
    expect(specRepairCalled).toBe(false);
    expect(record.supervisorRecovery).toEqual({
      ownerId: 'sol',
      fencingToken: 7,
      evidenceRefs: ['incident:recorded', 'action:refired'],
    });
  });

  test('frontier gate-fail invokes specRepair, records spec-repair, no third fire', async () => {
    let fireCount = 0;
    let escalateCalled = false;
    const specRepairCalls: {
      woId: string;
      whatMustChange: string;
      evidence: string;
      failReason: string;
    }[] = [];

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => makePollResult({ terminalStatus: 'failed' }),
      judge: _poll => makeFailVerdict('terminal status: failed'),
      escalate: async _ctx => {
        escalateCalled = true;
      },
      // Issue resolves + comment posts successfully -- the fix-loop signal was delivered.
      specRepair: async ctx => {
        specRepairCalls.push({
          woId: ctx.woId,
          whatMustChange: ctx.whatMustChange,
          evidence: ctx.evidence,
          failReason: ctx.failReason,
        });
        return { posted: true, issueRepo: 'thinmansoftware/bdc-xo', issueNumber: 42 };
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    // entryOverride='frontier' is a human-typed entry that bypasses the
    // approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01) and fires the
    // frontier tier directly: exactly 1 fire, gate-fails, spec-repair, stop.
    // (An AUTOMATIC climb into frontier now pauses instead of firing.)
    const record = await runCascade(
      baseOpts({
        deps,
        entryOverride: 'frontier',
      })
    );

    // Recorded outcome is spec-repair, NOT plain blocked.
    expect(record.status).toBe('spec-repair');
    expect(record.status).not.toBe('blocked');
    expect(fireCount).toBe(1); // frontier only (direct entry) -- no infinite loop

    // The spec-repair (issue-comment) path was invoked with real content.
    expect(specRepairCalls.length).toBe(1);
    expect(specRepairCalls[0]?.woId).toBe('WO-TEST-001');
    expect(specRepairCalls[0]?.whatMustChange).toContain('WHAT MUST CHANGE IN THE SPEC');
    expect(specRepairCalls[0]?.evidence).toContain('Gate-fail reason: terminal status: failed');

    // Issue was posted -> the plain escalate/alert fallback is NOT used.
    expect(escalateCalled).toBe(false);

    // The record carries the spec-repair payload for telemetry.
    expect(record.specRepair?.posted).toBe(true);
    expect(record.specRepair?.issueNumber).toBe(42);
    expect(record.specRepair?.whatMustChange).toContain('spec must be repaired');
  });

  test('Matrix row 4: no GitHub issue resolvable -> falls back to escalate, never silently dropped', async () => {
    let fireCount = 0;
    const escalateCalls: { reason: string; remediation?: string[] }[] = [];

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCount++;
        return makeFireOk(`run-${fireCount}`);
      },
      poll: async _opts => makePollResult({ terminalStatus: 'failed' }),
      judge: _poll => makeFailVerdict('validator verdict: needs_revision'),
      escalate: async ctx => {
        escalateCalls.push({ reason: ctx.reason, remediation: ctx.remediation });
      },
      // No issue resolves -- posted:false forces the escalate/alert fallback.
      specRepair: async _ctx => ({ posted: false, issueRepo: null, issueNumber: null }),
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    // Direct entry into frontier (human-typed) bypasses the approval gate and
    // fires it once; an AUTOMATIC climb into frontier would instead pause.
    const record = await runCascade(baseOpts({ deps, entryOverride: 'frontier' }));

    // Still spec-repair (the doctrine outcome), and the escalation was NOT dropped.
    expect(record.status).toBe('spec-repair');
    expect(fireCount).toBe(1);
    expect(escalateCalls.length).toBe(1);
    expect(escalateCalls[0]?.reason).toContain('SPEC-REPAIR');
    // The spec-repair text rides along in the alert payload.
    const remediationBlob = (escalateCalls[0]?.remediation ?? []).join('\n');
    expect(remediationBlob).toContain('WHAT MUST CHANGE IN THE SPEC');

    // The record still reflects the (unposted) spec-repair attempt.
    expect(record.specRepair?.posted).toBe(false);
    expect(record.specRepair?.issueNumber).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 6: WRAPPER -- does NOT touch DAG executor
// ---------------------------------------------------------------------------

describe('Test 6: WRAPPER -- cascade does not touch @archon/workflows', () => {
  test('stubbed fire dep is called; cascade returns a CascadeRunRecord; no DAG executor referenced', async () => {
    let stubFireCalled = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        stubFireCalled = true;
        return makeFireOk('run-wrapper-test');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(stubFireCalled).toBe(true);
    expect(record).not.toBeNull();
    expect(typeof record.cascadeId).toBe('string');
    expect(record.cascadeId.length).toBeGreaterThan(0);
    expect(typeof record.woId).toBe('string');
    expect(Array.isArray(record.attempts)).toBe(true);

    // Primary assertion (the grep stop-condition is the REAL check):
    // verify the cascadeRunRecord shape is correct (not a DAG node result)
    expect('status' in record).toBe(true);
    expect('telemetry' in record).toBe(true);
    expect('attempts' in record).toBe(true);
  });

  test('dry-run returns a record without calling fire', async () => {
    let fireCalledInDryRun = false;

    const deps: CascadeDeps = {
      fire: async _opts => {
        fireCalledInDryRun = true;
        return makeFireOk('should-not-happen');
      },
      poll: async _opts => makePollResult(),
      judge: _poll => makePassVerdict(),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps, dryRun: true }));

    expect(fireCalledInDryRun).toBe(false);
    expect(record.woId).toBe('WO-TEST-001');
    expect(record.status).toBe('planned');
  });

  test('checkpoints the cascade and in-flight attempt before the provider lane is fired', async () => {
    const snapshots: CascadeRunRecord[] = [];
    const deps: CascadeDeps = {
      fire: async () => makeFireOk('run-checkpoint'),
      poll: async () => makePollResult({ runId: 'run-checkpoint' }),
      judge: () => makePassVerdict(),
      escalate: async () => undefined,
      writeRecord: async record => {
        snapshots.push(structuredClone(record));
        return `/tmp/cascade-record-${record.cascadeId}.json`;
      },
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(snapshots[0]?.status).toBe('running');
    expect(snapshots[0]?.attempts).toEqual([]);
    expect(
      snapshots.some(
        snapshot =>
          snapshot.status === 'running' &&
          snapshot.attempts.length === 1 &&
          snapshot.attempts[0]?.outcome === 'running' &&
          snapshot.attempts[0]?.completedAt === null
      )
    ).toBe(true);
    expect(snapshots.at(-1)?.status).toBe('won');
    expect(record.status).toBe('won');
  });

  test('returns the durable record for a duplicate dispatch without firing another lane', async () => {
    let fireCalled = false;
    const existing: CascadeRunRecord = {
      cascadeId: 'dispatch-stable',
      woId: 'WO-TEST-001',
      project: 'test-project',
      request: {
        woClass: 'CODE',
        tags: ['mechanical'],
        entryOverride: null,
        dryRun: false,
      },
      createdAt: '2026-07-09T12:00:00.000Z',
      status: 'running',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: 'zero',
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
    };
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalled = true;
        return makeFireOk('duplicate-run');
      },
      poll: async () => makePollResult(),
      judge: () => makePassVerdict(),
      escalate: async () => undefined,
      createRecord: async () => ({
        created: false,
        path: '/tmp/existing/cascade-record.json',
        record: existing,
      }),
      writeRecord: async record => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(
      baseOpts({ deps, dispatchId: 'dispatch-stable' } as Partial<RunCascadeOptions>)
    );

    expect(fireCalled).toBe(false);
    expect(record).toEqual(existing);
  });
});

// ---------------------------------------------------------------------------
// Verify loadLadder and loadRuleset read real config (smoke tests)
// ---------------------------------------------------------------------------

describe('config file smoke tests', () => {
  test('loadLadder returns ordered tiers from config file', () => {
    const tiers = loadLadder();
    expect(tiers.length).toBeGreaterThan(0);
    expect(tiers[0]?.name).toBeDefined();
    // First tier should be zero (exhaustion/mechanical tier; no paid review seat).
    expect(tiers[0]?.name).toBe('zero');
    // Last tier should be frontier
    expect(tiers[tiers.length - 1]?.isFrontier).toBe(true);
  });

  test('loadRuleset returns ruleset with defaultEntry and rules', () => {
    const ruleset = loadRuleset();
    // v1.1 (2026-07-02): GLM demoted from defaultEntry after repetition-collapse
    // + fabricated-build incidents; bare CODE now enters at codex.
    expect(ruleset.defaultEntry).toBe('codex');
    expect(Array.isArray(ruleset.rules)).toBe(true);
    expect(ruleset.rules.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Motion M-86: cancelled STOPS the cascade instead of climbing.
//
// These tests OMIT `deps.judge` so `judgeImpl` resolves to the REAL judgeGate +
// classifyAttemptOutcome (cascade.ts: judgeImpl = opts.deps?.judge ?? judgeGate).
// Prior coverage stubbed judge entirely and never exercised terminal-status
// branching, so failed/escalated climb behavior was never actually proven.
// ---------------------------------------------------------------------------

describe('Test: cancelled stops the cascade (real gate)', () => {
  test('cancelled on a non-frontier tier stops -- never climbs, never a win', async () => {
    const fireCalls: string[] = [];

    // Use the REAL record writer (recorder.ts) against a temp outDir so this
    // test exercises actual JSON serialization + persistence -- not a mock that
    // only inspects the in-memory object. The record-honesty scenario is only
    // proven by reading the bytes that landed on disk.
    const outDir = await mkdtemp(join(tmpdir(), 'cascade-cancel-'));
    const dispatchId = 'cascade-cancel-serialize-test';

    try {
      const deps: CascadeDeps = {
        fire: async opts => {
          fireCalls.push(opts.workflowName);
          return makeFireOk(`run-${fireCalls.length}`);
        },
        // Realistic cancelled PollResult: no PR, unknown validator verdict.
        poll: async _opts =>
          makePollResult({
            terminalStatus: 'cancelled',
            prUrl: null,
            prMergeable: null,
            validatorVerdict: 'unknown',
          }),
        escalate: async _ctx => {
          /* no-op */
        },
        // writeRecord intentionally omitted -- the real writeRecord runs.
        cancel: async _opts => ({ ok: true, error: null }),
      };

      const record = await runCascade(baseOpts({ deps, outDir, dispatchId }));

      // Only the entry (non-frontier) tier fired -- no climb.
      expect(fireCalls.length).toBe(1);
      const tiers = loadLiveTiers();
      expect(fireCalls[0]).toBe(tiers[0]?.workflowName);
      expect(tiers[0]?.isFrontier).toBe(false);

      // Cascade stopped as cancelled -- not won, not blocked.
      expect(record.status).toBe('cancelled');
      expect(record.status).not.toBe('won');
      expect(record.attempts.length).toBe(1);
      expect(record.attempts[0]?.outcome).toBe('cancelled');
      // Reason is truthful and does not claim a win.
      expect(record.attempts[0]?.gateFailReason).toContain('cancelled externally');

      // Record honesty (spec scenario 6): read the SERIALIZED record back off
      // disk -- the persisted JSON, not the in-memory return value -- and prove
      // it carries status: 'cancelled'. Slug format mirrors recorder.buildRunSlug.
      const slug = `dispatch-${createHash('sha256').update(dispatchId).digest('hex').slice(0, 24)}`;
      const persistedPath = join(outDir, slug, 'cascade-record.json');
      const persisted = JSON.parse(await readFile(persistedPath, 'utf8')) as CascadeRunRecord;
      expect(persisted.status).toBe('cancelled');
      expect(persisted.status).not.toBe('won');
      expect(persisted.attempts[0]?.outcome).toBe('cancelled');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 15000);

  test('cancelled is never pass:true under the real gate (otherwise-clean fields)', async () => {
    // Even with validator satisfied + PR mergeable, cancelled must fail the gate.
    const deps: CascadeDeps = {
      fire: async () => makeFireOk('run-1'),
      poll: async _opts =>
        makePollResult({
          terminalStatus: 'cancelled',
          validatorVerdict: 'satisfied',
          prUrl: 'https://github.com/org/repo/pull/9',
          prMergeable: true,
        }),
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      cancel: async _opts => ({ ok: true, error: null }),
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(record.status).toBe('cancelled');
    expect(record.status).not.toBe('won');
    expect(record.attempts[0]?.outcome).toBe('cancelled');
  });

  test('failed still climbs under the real gate (regression: scenario 4)', async () => {
    const fireCalls: string[] = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return makeFireOk(`run-${fireCalls.length}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        // Tier 0 fails (real gate -> gate-failed -> climb); tier 1 passes.
        if (pollCallIndex === 1) {
          return makePollResult({
            terminalStatus: 'failed',
            prUrl: null,
            prMergeable: null,
            validatorVerdict: 'unknown',
          });
        }
        return makePollResult();
      },
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCalls.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.status).toBe('won');
  });

  test('escalated still climbs under the real gate (regression: scenario 5)', async () => {
    const fireCalls: string[] = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return makeFireOk(`run-${fireCalls.length}`);
      },
      poll: async _opts => {
        pollCallIndex++;
        if (pollCallIndex === 1) {
          return makePollResult({
            terminalStatus: 'escalated',
            prUrl: null,
            prMergeable: null,
            validatorVerdict: 'unknown',
          });
        }
        return makePollResult();
      },
      escalate: async _ctx => {
        /* no-op */
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCalls.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.status).toBe('won');
  });
});

// ---------------------------------------------------------------------------
// WO claim / single-flight (bdc-xo#1546)
// ---------------------------------------------------------------------------

describe('wo claim + single-flight (#1546)', () => {
  test('refuses cascade when WO already has an OPEN claim (no fire)', async () => {
    let fireCalled = false;
    const deps: CascadeDeps = {
      findWoClaim: async () => ({
        number: 99,
        state: 'OPEN',
        title: 'WO-TEST-001 open',
        url: 'https://github.com/org/repo/pull/99',
        repo: 'thinmansoftware/test-project',
      }),
      fire: async () => {
        fireCalled = true;
        return makeFireOk('should-not-fire');
      },
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(baseOpts({ deps }));

    expect(fireCalled).toBe(false);
    expect(result.status).toBe('won');
    expect(result.attempts.length).toBe(0);
  });

  test('second concurrent cascade for same WO is blocked', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'sc-wo-lock-'));
    try {
      let heldBy: string | null = null;
      const acquireCalls: string[] = [];

      const makeLockDeps = (cascadeLabel: string, onFire?: () => void): CascadeDeps => ({
        findWoClaim: async () => null,
        acquireWoLock: async (woId, project, cascadeId) => {
          acquireCalls.push(cascadeLabel);
          const path = join(outDir, 'wo-locks', `${woId}.json`);
          if (heldBy && heldBy !== cascadeId) {
            return {
              acquired: false,
              path,
              record: {
                woId,
                project,
                cascadeId: heldBy,
                status: 'running',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            };
          }
          heldBy = cascadeId;
          return {
            acquired: true,
            path,
            record: {
              woId,
              project,
              cascadeId,
              status: 'running',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          };
        },
        releaseWoLock: async (_woId, _project, cascadeId) => {
          if (heldBy === cascadeId) heldBy = null;
        },
        fire: async () => {
          onFire?.();
          return makeFireOk(`run-${cascadeLabel}`);
        },
        poll: async () => makePollResult(),
        judge: () => makePassVerdict(),
        escalate: async () => undefined,
        writeRecord: async (record, _dir) => join(outDir, `${record.cascadeId}.json`),
      });

      let secondFire = false;
      // Hold the lock via injected acquire -- first cascade keeps heldBy set
      // until release, so second must see acquired:false.
      heldBy = 'cascade-first';
      const second = await runCascade(
        baseOpts({
          outDir,
          dispatchId: 'cascade-second',
          deps: makeLockDeps('second', () => {
            secondFire = true;
          }),
        })
      );

      expect(second.status).toBe('blocked');
      expect(secondFire).toBe(false);
      expect(acquireCalls).toEqual(['second']);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('stops climb when claim appears after gate-fail', async () => {
    let claimCalls = 0;
    const fireCalls: string[] = [];
    const deps: CascadeDeps = {
      findWoClaim: async () => {
        claimCalls++;
        // First check (pre-cascade) empty; claim appears before climb after gate-fail.
        if (claimCalls <= 2) return null;
        return {
          number: 42,
          state: 'OPEN',
          title: 'WO-TEST-001 landed elsewhere',
          url: 'https://github.com/org/repo/pull/42',
          repo: 'thinmansoftware/test-project',
        };
      },
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return makeFireOk(`run-${fireCalls.length}`);
      },
      poll: async () =>
        makePollResult({
          terminalStatus: 'completed',
          prUrl: null,
          prMergeable: null,
          validatorVerdict: 'needs_revision',
        }),
      judge: () => makeFailVerdict('no PR opened'),
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade(baseOpts({ deps }));

    expect(fireCalls.length).toBe(1);
    expect(record.status).toBe('won');
  });
});
