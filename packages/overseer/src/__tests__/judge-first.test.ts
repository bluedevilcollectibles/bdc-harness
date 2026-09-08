/**
 * Judge-first decision core tests (WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
 *
 * All dependencies are injected -- no mock.module, no live database, no real
 * subprocess spawns. Covers the WO's Section 7 scenarios at the unit level:
 * mandatory verdict rows, fail-loud judge health, claim/replay idempotency,
 * stricter-of-two tier law, and permit-free Tier 0 escalation.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { rootLogger } from '@archon/paths';
import {
  buildEvidenceEnvelope,
  buildJudgePrompt,
  judgeTerminalRun,
  parseJudgeOutput,
  type JudgeOutcome,
  type JudgeSpawnResult,
} from '../judge-first';
import {
  DEFAULT_P0_MAX_RETRIES,
  DEFAULT_ROUTINE_MAX_RETRIES,
  handleRecordJudgeFirst,
  isP0Run,
  resolveJudgeMaxRetries,
} from '../judge-first-pipeline';
import { MAX_TIER, effectiveTier, requiredTierForAction, ruleOnAction } from '../tier-map';
import type {
  OverseerVerdictStoreDeps,
  OverseerWorkflowEvent,
  WatchedRunRecord,
} from '../types.ts';

interface LogDestination {
  write(chunk: string): unknown;
}

const loggerStreamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
  symbol => String(symbol) === 'Symbol(pino.stream)'
)!;
const loggerDestination = (rootLogger as unknown as Record<symbol, LogDestination>)[
  loggerStreamSymbol
];
const originalLogWrite = loggerDestination.write.bind(loggerDestination);

afterEach(() => {
  loggerDestination.write = originalLogWrite;
});

function captureLogOutput(): string[] {
  const chunks: string[] = [];
  loggerDestination.write = (chunk: string): boolean => {
    chunks.push(chunk);
    return true;
  };
  return chunks;
}

function makeRecord(overrides: Partial<WatchedRunRecord> = {}): WatchedRunRecord {
  return {
    runId: 'run-1',
    woId: 'WO-TEST-01',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'completed',
    headBranch: 'feat/test-branch',
    action: 'ignore',
    reason: 'classifier hint reason',
    prEvidence: {
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
    },
    ...overrides,
  };
}

function makeEvent(id: string, message: string): OverseerWorkflowEvent {
  return {
    id,
    workflow_run_id: 'run-1',
    event_type: 'node_failed',
    step_name: 'commit-and-push',
    data: { error: message },
    created_at: `2026-07-28T00:00:0${id.slice(-1)}Z`,
  };
}

interface FakeStoreState {
  claims: { runId: string; headSha?: string }[];
  finalized: Record<string, unknown>[];
}

function makeVerdictStore(
  claimResult: { claimed: boolean; verdictId?: string; retryCount?: number },
  state: FakeStoreState
): OverseerVerdictStoreDeps {
  return {
    claimVerdict: async input => {
      state.claims.push({ runId: input.runId, headSha: input.headSha });
      return claimResult;
    },
    finalizeVerdict: async input => {
      state.finalized.push(input as unknown as Record<string, unknown>);
      return input;
    },
  };
}

function makeDeps(events: OverseerWorkflowEvent[] = []): {
  actions: { action: string; result: string }[];
  deps: Parameters<typeof handleRecordJudgeFirst>[1];
} {
  const actions: { action: string; result: string }[] = [];
  return {
    actions,
    deps: {
      listRunsForWatch: async () => [],
      listRunEvents: async () => events,
      insertOverseerAction: async record => {
        actions.push({ action: record.action, result: record.result });
      },
      findPullRequest: async () => ({
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      }),
      mergePullRequest: async () => {
        throw new Error('merge_unreachable_in_tests');
      },
    },
  };
}

const fakeEscalate: Parameters<typeof handleRecordJudgeFirst>[2]['escalate'] = async () =>
  ({ card_id: 'card-fake-1' }) as never;

function verdictOutcome(
  overrides: Partial<Extract<JudgeOutcome, { kind: 'verdict' }>> = {}
): JudgeOutcome {
  return {
    kind: 'verdict',
    verdict: 'healthy',
    confidence: 0.9,
    proposedAction: 'none',
    proposedTier: 0,
    reason: 'run completed cleanly',
    model: 'fake-judge',
    modelRung: 0,
    ...overrides,
  };
}

describe('tier-map: M-15 stricter-of-two law', () => {
  test('the four Tier 0 actions map to tier 0', () => {
    for (const action of [
      'verdict_write',
      'comment_findings',
      'flag_merge_ready',
      'escalate_with_evidence',
    ]) {
      expect(requiredTierForAction(action)).toBe(0);
    }
  });

  test('merge requires tier >= 1 and a tier-0 proposal cannot lower it', () => {
    const ruling = ruleOnAction('merge', 0);
    expect(ruling.requiredTier).toBeGreaterThanOrEqual(1);
    expect(ruling.effectiveTier).toBe(ruling.requiredTier);
    expect(ruling.executableInV1).toBe(false);
  });

  test('unknown action kinds fail closed to MAX_TIER', () => {
    expect(requiredTierForAction('invent_new_door')).toBe(MAX_TIER);
    expect(ruleOnAction('invent_new_door', 0).executableInV1).toBe(false);
  });

  test('the model can raise caution above the code floor', () => {
    expect(effectiveTier(2, 0)).toBe(2);
  });
});

describe('parseJudgeOutput: strict structured parsing', () => {
  test('parses a valid verdict object embedded in narration', () => {
    const parsed = parseJudgeOutput(
      'Here is my verdict:\n{"verdict":"merge_candidate","confidence":0.8,"proposed_action":"flag_merge_ready","proposed_tier":0,"reason":"green PR"}\n'
    );
    expect(parsed?.verdict).toBe('merge_candidate');
    expect(parsed?.confidence).toBe(0.8);
    expect(parsed?.proposedAction).toBe('flag_merge_ready');
  });

  // Regression (2026-07-30, live container): Grok emits its verdict object TWICE,
  // concatenated. The old scan took indexOf('{') .. lastIndexOf('}'), which spans
  // BOTH objects and yields invalid JSON, so every correct real verdict was
  // discarded as judge_invalid_output while the model was answering perfectly.
  // These are the exact 197 bytes captured from `docker exec archon-app-1 grok -p`.
  test('parses the FIRST object when the model emits its verdict twice', () => {
    const one =
      '{"verdict":"healthy","confidence":0.75,"proposed_action":"none","proposed_tier":0,"reason":"test"}';
    const parsed = parseJudgeOutput(one + one);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe('healthy');
    expect(parsed?.confidence).toBe(0.75);
    expect(parsed?.proposedAction).toBe('none');
  });

  test('parses duplicated pretty-printed output (the shape seen in the 7/30 logs)', () => {
    const pretty =
      '{\n  "verdict": "healthy",\n  "confidence": 0.75,\n  "proposed_action": "none",\n  "proposed_tier": 0,\n  "reason": "Workflow reached completed state"\n}';
    const parsed = parseJudgeOutput(`${pretty}\n${pretty}`);
    expect(parsed?.verdict).toBe('healthy');
    expect(parsed?.reason).toContain('completed state');
  });

  test('a brace inside a string value does not truncate the scan', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"needs_human","confidence":0.4,"proposed_action":"escalate_with_evidence","proposed_tier":0,"reason":"saw a literal } and { in the log tail"}'
    );
    expect(parsed?.verdict).toBe('needs_human');
    expect(parsed?.reason).toContain('literal }');
  });

  // Regression (2026-07-31, live): the model self-assigned proposed_tier 1 or 2 on
  // notify-class actions (80 of 194 verdicts at tier 1, 8 at tier 2). Stricter-of-two
  // then correctly refused 88 Tier 0 actions -- including ALL 27 flag_merge_ready on
  // 47 genuine merge candidates. The tier law was right; soliciting a tier from the
  // model and treating it as an authority floor was not. Any volunteered tier is now
  // ignored; code owns the floor.
  test('ignores a model-volunteered tier so it cannot suppress a Tier 0 action', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"merge_candidate","confidence":0.75,"proposed_action":"flag_merge_ready","proposed_tier":1,"reason":"green mergeable PR"}'
    );
    expect(parsed?.proposedAction).toBe('flag_merge_ready');
    expect(parsed?.proposedTier).toBe(0);
    expect(ruleOnAction(parsed!.proposedAction, parsed!.proposedTier).executableInV1).toBe(true);
  });

  test('an inflated tier cannot widen authority either -- merge still refused', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"merge_candidate","confidence":0.9,"proposed_action":"merge","proposed_tier":0,"reason":"looks fine"}'
    );
    const ruling = ruleOnAction(parsed!.proposedAction, parsed!.proposedTier);
    expect(ruling.requiredTier).toBeGreaterThanOrEqual(1);
    expect(ruling.executableInV1).toBe(false);
  });

  test('the prompt no longer solicits a tier', () => {
    const prompt = buildJudgePrompt(buildEvidenceEnvelope(makeRecord(), []));
    expect(prompt).not.toContain('"proposed_tier"');
    expect(prompt).toContain('Do NOT emit an authority tier');
  });

  test('rejects non-JSON, unknown verdicts, and out-of-range confidence', () => {
    expect(parseJudgeOutput('VERDICT: APPROVE')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"maybe","confidence":0.5}')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"healthy","confidence":1.5}')).toBeNull();
  });
});

describe('judgeTerminalRun: model ladder + fail-loud health', () => {
  const envelope = buildEvidenceEnvelope(makeRecord(), []);
  const ignoreOutcome = async (): Promise<never> => ({}) as never;

  test('ladder exhaustion by spawn failure is judge_unavailable, never a verdict', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['dead-a', 'dead-b'],
      spawn: async () => ({ exitCode: 1, stdout: '', timedOut: false }),
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('judge_unavailable');
  });

  test('ladder exhaustion by unparseable output is judge_invalid_output', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['chatty'],
      spawn: async () => ({ exitCode: 0, stdout: 'I feel great about this run!', timedOut: false }),
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('judge_invalid_output');
  });

  test('climbs the ladder: rung 0 dies, rung 1 answers', async () => {
    const spawn = async (binary: string): Promise<JudgeSpawnResult> =>
      binary === 'cheap'
        ? { exitCode: 124, stdout: '', timedOut: true }
        : {
            exitCode: 0,
            stdout:
              '{"verdict":"observe","confidence":0.7,"proposed_action":"none","proposed_tier":0,"reason":"ok"}',
            timedOut: false,
          };
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['cheap', 'strong'],
      spawn,
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind === 'verdict') {
      expect(outcome.model).toBe('strong');
      expect(outcome.modelRung).toBe(1);
    }
  });

  test('records an unavailable outcome when spawning throws', async () => {
    const recorded: unknown[] = [];
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['missing'],
      spawn: async () => {
        throw new Error('ENOENT');
      },
      recordOutcome: async (...args) => {
        recorded.push(args);
        return {} as never;
      },
    });
    expect(outcome.kind).toBe('judge_unavailable');
    expect(recorded).toEqual([['missing', { exitCode: -1, timedOut: false }, 'judge-first']]);
  });

  test('logs a health-write failure with serialized error details without crashing', async () => {
    const output = captureLogOutput();
    await expect(
      judgeTerminalRun(envelope, {
        ladder: ['healthy-spawn'],
        spawn: async () => ({
          exitCode: 0,
          stdout:
            '{"verdict":"observe","confidence":0.7,"proposed_action":"none","proposed_tier":0,"reason":"ok"}',
          timedOut: false,
        }),
        recordOutcome: async () => {
          throw new Error('health write failed');
        },
      })
    ).resolves.toMatchObject({ kind: 'verdict' });
    const entry = output
      .flatMap(chunk => chunk.trim().split('\n'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.msg === 'overseer.judge_first.resource_health_record_failed');
    expect(entry?.level).toBe(50);
    expect(entry?.err).toMatchObject({ message: 'health write failed' });
    expect((entry?.err as { stack?: string } | undefined)?.stack).toContain('health write failed');
  });
});

describe('handleRecordJudgeFirst: pipeline', () => {
  test('Test 1: healthy run gets mandatory verdict row + verdict_write receipt', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(makeRecord({ action: 'success' }), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-1', retryCount: 0 }, state),
      judge: async () => verdictOutcome(),
      escalate: fakeEscalate,
    });
    expect(state.finalized).toHaveLength(1);
    expect(state.finalized[0]?.status).toBe('verdict');
    expect(state.finalized[0]?.verdict).toBe('healthy');
    expect(actions.map(a => a.action)).toEqual(['verdict_write']);
  });

  test('Test 2: dead judge finalizes an alarm state, never a semantic verdict', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(makeRecord({ status: 'failed', action: 'escalate' }), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-2', retryCount: 0 }, state),
      judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
      escalate: fakeEscalate,
    });
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(state.finalized[0]?.verdict).toBeUndefined();
    // Retry budget not yet exhausted: no receipt row, so the run stays retryable.
    expect(actions).toHaveLength(0);
  });

  test('Test 2b: exhausted retries escalate loudly with evidence', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(makeRecord({ status: 'failed', action: 'escalate' }), deps, {
      dryRun: false,
      actor: 'test',
      maxRetries: 3,
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-3', retryCount: 3 }, state),
      judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
      escalate: fakeEscalate,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('escalate_with_evidence');
    expect(actions[0]?.result).toContain('operator_card:card-fake-1');
  });

  // WO-HARNESS-OVERSEER-JUDGE-BUDGET-CIRCUIT-01 (narrowed): P0 must escalate on the
  // FIRST judge health failure, not after the routine 3-retry wait. Outcome kinds are
  // judge_unavailable | judge_invalid_output | evidence_unavailable -- there is no
  // literal judge_daily_budget_exhausted value (daily circuit deleted in #602).
  test('Test 2c: P0 run escalates on first judge health failure (no retry wait)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(
      makeRecord({
        status: 'failed',
        action: 'escalate',
        woId: 'WO-HARNESS-CRITICAL-01',
        metadata: { priority: 'P0' },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        // Deliberately omit maxRetries so the pipeline must derive P0 sizing itself.
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-p0', retryCount: 0 }, state),
        judge: async () => ({
          kind: 'judge_unavailable',
          reason: 'all ladder rung(s) unavailable (spawn failure, timeout, or nonzero exit)',
        }),
        escalate: fakeEscalate,
      }
    );
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('escalate_with_evidence');
    expect(actions[0]?.result).toContain('operator_card:card-fake-1');
    expect(actions[0]?.result).toMatch(/judge_health_judge_unavailable|p0/i);
  });

  test('Test 2d: routine run still does not escalate at retryCount 0', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(
      makeRecord({ status: 'failed', action: 'escalate', woId: 'WO-ROUTINE-01' }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-r0', retryCount: 0 }, state),
        judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
        escalate: fakeEscalate,
      }
    );
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(actions).toHaveLength(0);
  });
});

describe('judge retry budget sizing (WO-HARNESS-OVERSEER-JUDGE-BUDGET-CIRCUIT-01)', () => {
  test('routine default is 3 retries; P0 default is 0 (immediate escalate)', () => {
    // Sized against #1390 volume (~533 verdicts sample): daily CALL cap was deleted
    // because it killed 60% of verdicts. Per-run retry ceiling remains so a dead
    // judge cannot re-queue forever. P0 skips the wait.
    expect(DEFAULT_ROUTINE_MAX_RETRIES).toBe(3);
    expect(DEFAULT_P0_MAX_RETRIES).toBe(0);
  });

  test('isP0Run detects metadata.priority, metadata.prio, labels, and woId markers', () => {
    expect(isP0Run(makeRecord({ metadata: { priority: 'P0' } }))).toBe(true);
    expect(isP0Run(makeRecord({ metadata: { prio: 'p0' } }))).toBe(true);
    expect(isP0Run(makeRecord({ metadata: { labels: ['wo', 'prio:P0'] } }))).toBe(true);
    expect(isP0Run(makeRecord({ woId: 'WO-P0-AUTH-01' }))).toBe(true);
    expect(isP0Run(makeRecord({ woId: 'WO-HARNESS-FOO-01' }))).toBe(false);
    expect(isP0Run(makeRecord({ metadata: { priority: 'P1' } }))).toBe(false);
  });

  test('resolveJudgeMaxRetries prefers explicit option, then P0, then routine', () => {
    const p0 = makeRecord({ metadata: { priority: 'P0' } });
    const routine = makeRecord({ woId: 'WO-ROUTINE-01' });
    expect(resolveJudgeMaxRetries(p0, {})).toBe(DEFAULT_P0_MAX_RETRIES);
    expect(resolveJudgeMaxRetries(routine, {})).toBe(DEFAULT_ROUTINE_MAX_RETRIES);
    expect(resolveJudgeMaxRetries(p0, { maxRetries: 7 })).toBe(7);
    expect(resolveJudgeMaxRetries(routine, { maxRetries: 1 })).toBe(1);
  });
});

describe('handleRecordJudgeFirst: pipeline (continued)', () => {
  test('Test 3: lost claim means replay -- no model call, no duplicate action', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let judgeCalls = 0;
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: false }, state),
      judge: async () => {
        judgeCalls += 1;
        return verdictOutcome();
      },
      escalate: fakeEscalate,
    });
    expect(judgeCalls).toBe(0);
    // Replay of a non-actionable (ignore) record now writes exactly ONE
    // terminal watch_closed disposition (judge-first window drain, 8th canary
    // defect 2026-08-25) -- and nothing else: no merge, no escalation, no
    // model call, no finalize.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('watch_closed');
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3b: lost claim on a merge_ready record writes NOTHING (stays live)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({ action: 'merge_ready', reason: 'green mergeable PR' }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3d: lost claim with a still-OPEN PR stays open -- CI may be pending (11th defect)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({
        action: 'ignore',
        reason: 'completed run; PR not merge-ready (checks pending)',
        prEvidence: {
          exists: true,
          state: 'open',
          checks: { total: 3, passed: 1, failed: 0, pending: 2 },
          mergeable: true,
        },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3c: lost claim with a TRANSIENT lookup failure stays open (no close)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({
        action: 'ignore',
        prEvidence: {
          exists: false,
          state: 'lookup_failed',
          checks: { total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable: null,
          lookupFailed: true,
        },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 4: model proposing merge at tier 0 is refused by the stricter code tier', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-4', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'observe', proposedAction: 'merge', proposedTier: 0 }),
      escalate: fakeEscalate,
    });
    expect(state.finalized[0]?.requiredTier).toBeGreaterThanOrEqual(1);
    expect(actions.map(a => a.action)).toEqual(['verdict_write', 'tier_refused']);
    expect(coordinatorCalled).toBe(0);
  });

  test('Test 5: Tier 0 escalation runs without any permit and never yields permit_missing', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'genuine failure')]);
    await handleRecordJudgeFirst(
      makeRecord({ status: 'failed', action: 'escalate', errorClass: 'unknown', metadata: {} }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-5', retryCount: 0 }, state),
        judge: async () =>
          verdictOutcome({ verdict: 'failed_genuine', proposedAction: 'escalate_with_evidence' }),
        escalate: fakeEscalate,
      }
    );
    const escalation = actions.find(a => a.action === 'escalate_with_evidence');
    expect(escalation).toBeDefined();
    expect(escalation?.result).not.toContain('permit_missing');
    expect(escalation?.result).toContain('operator_card:card-fake-1');
  });

  test('merge_candidate with a genuinely merge-ready PR flags and hands off to the steward', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 3, passed: 3, failed: 0, pending: 0 },
        mergeable: true,
        headSha: 'abc123',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-6', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.map(a => a.action)).toEqual(['verdict_write', 'flag_merge_ready']);
    expect(coordinatorCalled).toBe(1);
    expect(state.claims[0]?.headSha).toBe('abc123');
  });

  test('dry run: flag_merge_ready receipt written, steward handoff suppressed', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        headSha: 'def456',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 43 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: true,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-7', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.find(a => a.action === 'flag_merge_ready')?.result).toContain('dry_run');
    expect(coordinatorCalled).toBe(0);
  });

  test('merge_candidate WITHOUT a merge-ready PR does not flag (deterministic gate holds)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-8', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.map(a => a.action)).toEqual(['verdict_write']);
  });

  test('duplicate_work without a comment channel records a loud unavailable receipt', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: false,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 44 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-9', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'duplicate_work', proposedAction: 'comment_findings' }),
      escalate: fakeEscalate,
    });
    const comment = actions.find(a => a.action === 'comment_findings');
    expect(comment?.result).toContain('comment_channel_unavailable');
  });

  test('comment_findings posts through the injected channel', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    const posted: string[] = [];
    deps.commentOnPullRequest = async input => {
      posted.push(input.body);
      return { commented: true, url: 'https://github.com/x/y/pull/44#comment-1' };
    };
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: false,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 44 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-10', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'duplicate_work', proposedAction: 'comment_findings' }),
      escalate: fakeEscalate,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('duplicate_work');
    expect(actions.find(a => a.action === 'comment_findings')?.result).toContain('commented:');
  });
});

describe('evidence envelope: bounded by construction', () => {
  test('caps the event tail at 20 and truncates long messages', () => {
    const events = Array.from({ length: 50 }, (_, i) => makeEvent(`e${i}`, 'x'.repeat(2000)));
    const envelope = buildEvidenceEnvelope(makeRecord(), events);
    expect(envelope.eventTail).toHaveLength(20);
    expect(envelope.eventTail[0]!.message.length).toBeLessThanOrEqual(403);
    expect(envelope.hint.action).toBe('ignore');
  });
});

// Codex fallback rung (John 2026-08-26: "Give it to codex" -- xAI credits dry).
import { describe as dCx, test as tCx, expect as eCx, mock as mCx } from 'bun:test';
import { judgeTerminalRun as judgeCx } from '../judge-first.js';

dCx('codex judge rung invocation', () => {
  tCx('codex rung judges when grok is unavailable', async () => {
    const spawns: string[][] = [];
    const recorded: string[] = [];
    const outcome = await judgeCx(
      {
        runId: 'run-cx',
        woId: 'WO-CX-01',
        status: 'completed',
        reason: 'r',
        events: [],
      } as never,
      {
        ladder: ['grok', 'codex'],
        spawn: async (binary: string, _prompt: string) => {
          spawns.push([binary]);
          if (binary === 'grok') return { exitCode: 1, stdout: '', timedOut: false };
          return {
            exitCode: 0,
            stdout:
              'chatter\n{"verdict":"observe","confidence":0.8,"proposed_action":"none","reason":"ok"}',
            timedOut: false,
          };
        },
        recordOutcome: async binary => {
          recorded.push(binary);
          return {} as never;
        },
      }
    );
    eCx(spawns.map(s => s[0])).toEqual(['grok', 'codex']);
    eCx(recorded).toEqual(['grok', 'codex']);
    eCx(outcome.kind).toBe('verdict');
  });
});
