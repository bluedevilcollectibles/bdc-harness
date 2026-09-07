/**
 * Taskmaster loop tests -- Section 11 scenarios 1, 3, 4, 5 plus the
 * auto-circuit. Everything is dependency-injected (fake clock, fake DAL,
 * fake dispatch); no mock.module.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createTaskmasterState,
  defaultFindEffectByIdempotencyKey,
  defaultGetGithubIssueEvidence,
  defaultListThreads,
  tick,
  resolveTaskmasterIntervalMs,
  resolveFireVerbEnabled,
  refreshAdoption,
  canonicalizeThreadRef,
  resolveRecipient,
  MAX_EFFECTS_PER_TICK,
  OWNER_RECIPIENT_MAP,
  TM_REPEAT_REASON_BY_TYPE,
  type TaskmasterDeps,
  type ListedThread,
  type GithubIssueEvidence,
  type AdoptionRefreshResult,
} from './loop';
import { validateProposal, TM_ALLOWED_ACTION_TYPES, TM_ALLOWED_RECIPIENTS } from './guard';
import { MAX_INTERVENTIONS_PER_ITEM_24H, type ActionProposal, NUDGE_CLOCK_MS } from './rules';
import type { TmAdoptionRow, TmSuppressionRow } from '@archon/core/db/taskmaster';
import type { ThreadSnapshot } from './rules';
import type {
  TmActionOutcome,
  TmActionType,
  TmControlState,
  TmGrade,
  TmJournalEntry,
} from '@archon/core/db/taskmaster';
import type { HeadroomReading } from './ledger';

const T0 = Date.parse('2026-08-07T12:00:00.000Z');
const TODAY_KEY = new Date(T0).toISOString().slice(0, 10);

interface FakeWorld {
  journal: TmJournalEntry[];
  control: TmControlState;
  sentMessages: Array<{
    idempotency_key: string;
    recipient: string;
    body: string;
    createdAt: string;
  }>;
  nowMs: number;
  recordCalls: number;
  adoptionRows: TmAdoptionRow[];
  adoptionMeta: {
    committed_snapshot_id: string | null;
    rebuilt_at: string | null;
    row_count: number | null;
    source_commit: string | null;
    complete: number;
  };
}

function makeWorld(): FakeWorld {
  return {
    journal: [],
    control: {
      pause_state: 'RUNNING',
      pause_scope: null,
      pause_reason: null,
      pause_actor: null,
      epoch: 0,
      updated_at: new Date(T0).toISOString(),
    },
    sentMessages: [],
    nowMs: T0,
    recordCalls: 0,
    adoptionRows: [],
    adoptionMeta: {
      committed_snapshot_id: null,
      rebuilt_at: null,
      row_count: null,
      source_commit: null,
      complete: 0,
    },
  };
}

function makeDeps(world: FakeWorld, overrides: Partial<TaskmasterDeps> = {}): TaskmasterDeps {
  let journalSeq = world.journal.length;
  const dal = {
    recordAction: async (data: {
      thread_ref: string;
      action_type: TmActionType;
      proposal_json: string;
      idempotency_key?: string | null;
      before_hash?: string | null;
      proof_predicate?: string | null;
      proof_deadline_at?: string | null;
      outcome: TmActionOutcome;
    }): Promise<TmJournalEntry> => {
      world.recordCalls += 1;
      journalSeq += 1;
      const row: TmJournalEntry = {
        id: `journal-${journalSeq}`,
        created_at: new Date(world.nowMs).toISOString(),
        thread_ref: data.thread_ref,
        action_type: data.action_type,
        proposal_json: data.proposal_json,
        idempotency_key: data.idempotency_key ?? null,
        before_hash: data.before_hash ?? null,
        proof_predicate: data.proof_predicate ?? null,
        proof_deadline_at: data.proof_deadline_at ?? null,
        outcome: data.outcome,
        graded_at: null,
        grade: null,
      };
      world.journal.push(row);
      return row;
    },
    updateActionOutcome: async (id: string, outcome: TmActionOutcome, proposalJson?: string) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.outcome = outcome;
        if (proposalJson !== undefined) row.proposal_json = proposalJson;
      }
      return row;
    },
    gradeAction: async (id: string, grade: TmGrade) => {
      const row = world.journal.find(j => j.id === id) ?? null;
      if (row) {
        row.grade = grade;
        row.graded_at = new Date(world.nowMs).toISOString();
      }
      return row;
    },
    getActionsSince: async (sinceIso: string) =>
      world.journal.filter(j => j.created_at >= sinceIso),
    getActionByIdempotencyKey: async (key: string) =>
      world.journal.find(j => j.idempotency_key === key) ?? null,
    getPauseState: async () => world.control,
    setPauseState: async (data: {
      pause_state: TmControlState['pause_state'];
      pause_scope?: string | null;
      pause_reason?: string | null;
      pause_actor: string;
      incrementEpoch?: boolean;
    }) => {
      world.control = {
        pause_state: data.pause_state,
        pause_scope: data.pause_scope ?? null,
        pause_reason: data.pause_reason ?? null,
        pause_actor: data.pause_actor,
        epoch: world.control.epoch + (data.incrementEpoch ? 1 : 0),
        updated_at: new Date(world.nowMs).toISOString(),
      };
      return world.control;
    },
    expireParkedActions: async () => {
      let count = 0;
      for (const row of world.journal) {
        if (row.outcome === 'parked' || row.outcome === 'pending') {
          row.outcome = 'expired';
          count += 1;
        }
      }
      return count;
    },
    beginAdoptionSnapshot: async () => `snap-${world.nowMs}-${world.adoptionRows.length}`,
    upsertAdoptionRow: async (snapshotId: string, row: Omit<TmAdoptionRow, 'snapshot_id'>) => {
      const full: TmAdoptionRow = { ...row, snapshot_id: snapshotId };
      const idx = world.adoptionRows.findIndex(
        r => r.snapshot_id === snapshotId && r.thread_ref === row.thread_ref
      );
      if (idx >= 0) world.adoptionRows[idx] = full;
      else world.adoptionRows.push(full);
    },
    commitAdoptionSnapshot: async (snapshotId: string, sourceCommit?: string | null) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id === snapshotId);
      world.adoptionMeta = {
        committed_snapshot_id: snapshotId,
        rebuilt_at: new Date(world.nowMs).toISOString(),
        row_count: world.adoptionRows.length,
        source_commit: sourceCommit ?? null,
        complete: 1,
      };
    },
    abandonAdoptionSnapshot: async (snapshotId: string) => {
      world.adoptionRows = world.adoptionRows.filter(r => r.snapshot_id !== snapshotId);
    },
    getAdoption: async () => {
      const id = world.adoptionMeta.committed_snapshot_id;
      if (!id) return [];
      return world.adoptionRows.filter(r => r.snapshot_id === id);
    },
    getAdoptionMeta: async () => ({
      id: 1,
      committed_snapshot_id: world.adoptionMeta.committed_snapshot_id,
      rebuilt_at: world.adoptionMeta.rebuilt_at,
      row_count: world.adoptionMeta.row_count,
      source_commit: world.adoptionMeta.source_commit,
      complete: world.adoptionMeta.complete,
    }),
  };

  const okHeadroom: HeadroomReading = {
    state: 'OK',
    tokensRemaining: 500_000,
    isUnknown: false,
    source: 'local_artifacts',
    observedAt: new Date(T0).toISOString(),
  };

  return {
    now: () => new Date(world.nowMs),
    db: dal,
    headroom: async () => okHeadroom,
    createTask: (async (
      _context: unknown,
      data: { idempotency_key: string; recipient: string; body: string }
    ) => {
      world.sentMessages.push({
        idempotency_key: data.idempotency_key,
        recipient: data.recipient,
        body: data.body,
        createdAt: new Date(world.nowMs).toISOString(),
      });
      return { id: `msg-${world.sentMessages.length}`, status: 'queued' } as never;
    }) as unknown as TaskmasterDeps['createTask'],
    findEffectByIdempotencyKey: async (key: string) => {
      const found = world.sentMessages.find(m => m.idempotency_key === key);
      return found ? { id: 'existing', status: 'queued', createdAt: found.createdAt } : null;
    },
    listUndeliveredRulings: async () => [],
    listThreads: async () => [],
    // Default no-op evidence so adoption refresh never hits the network in unit tests.
    getGithubIssueEvidence: async () => null,
    ...overrides,
  };
}

/** Seed today's digest as already sent so tests can assert exact send counts. */
function seedDigestSent(world: FakeWorld): void {
  world.journal.push({
    id: 'journal-digest-seed',
    created_at: new Date(world.nowMs).toISOString(),
    thread_ref: `digest:${TODAY_KEY}`,
    action_type: 'digest',
    proposal_json: '{}',
    idempotency_key: `tm:digest:${TODAY_KEY}`,
    before_hash: null,
    proof_predicate: null,
    proof_deadline_at: null,
    outcome: 'sent',
    graded_at: null,
    grade: null,
  });
}

function ruling(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    ref: 'dispatch:ruling-42',
    priority: 'P1',
    lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
    undeliveredRulingId: 'ruling-42',
    recipient: 'xo',
    ...overrides,
  };
}

describe('scenario 1: undelivered ruling is delivered exactly once (dedupe proven)', () => {
  test('two ticks produce one deliver_ruling row and one send; a third tick adds nothing', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, { listUndeliveredRulings: async () => [ruling()] });
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    const deliveries = world.journal.filter(j => j.action_type === 'deliver_ruling');
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.outcome).toBe('sent');
    expect(world.sentMessages.length).toBe(1);
    expect(world.sentMessages[0]?.idempotency_key).toBe('tm:deliver_ruling:ruling-42');
    expect(world.sentMessages[0]?.idempotency_key).not.toBeNull();

    // Third tick: dedupe proven -- NO additional journal row, no send.
    world.nowMs += 60_000;
    await tick(state, deps);
    expect(world.journal.filter(j => j.action_type === 'deliver_ruling').length).toBe(1);
    expect(world.sentMessages.length).toBe(1);
  });
});

describe('scenario 3: pause scope=effects withholds ALL effects (P0 escalation no longer exempt)', () => {
  test('paused scope=effects: P1 nudge AND P0 escalation park with reason=paused, zero sends', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const staleP1 = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#11',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Stale P1 item',
    });
    const unclaimedP0 = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#12',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
      title: 'Unclaimed P0 item',
    });
    const deps = makeDeps(world, {
      listThreads: async () => [staleP1, unclaimedP0],
      // Content-complete adoption (PROGRESS marker -> next_action) so the
      // ordinary nudge is composed; this test is about the pause parking it.
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'PROGRESS',
          latestMarkerText: 'waiting on review feedback',
          latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementKind: 'progress_comment',
        }),
    });
    const state = createTaskmasterState(60_000);

    // Tick 1 observes; tick 2 confirms the nudge (which then parks). The P0
    // escalation acts immediately, so it parks on tick 1.
    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // NEW BEHAVIOR: the P0 escalation is withheld (parked), NOT sent, because
    // the pause scope is 'effects'.
    const escalations = world.sentMessages.filter(m =>
      m.idempotency_key.startsWith('tm:escalate_p0:')
    );
    expect(escalations.length).toBe(0);
    const escalationParked = world.journal.filter(
      j => j.thread_ref === unclaimedP0.ref && j.outcome === 'parked'
    );
    expect(escalationParked.length).toBe(1);
    expect(escalationParked[0]?.proposal_json).toContain('"reason":"paused"');

    // Zero sends for the P1; its journal row exists tagged parked with reason.
    const p1Sends = world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'));
    expect(p1Sends.length).toBe(0);
    const parked = world.journal.filter(
      j => j.thread_ref === staleP1.ref && j.outcome === 'parked'
    );
    expect(parked.length).toBe(1);
    expect(parked[0]?.proposal_json).toContain('"parked":true');
    expect(parked[0]?.proposal_json).toContain('"reason":"paused"');

    // Absolutely zero effects left the process this pause window.
    expect(world.sentMessages.length).toBe(0);
    // No journal row was marked sent for either thread.
    expect(
      world.journal.some(
        j =>
          (j.thread_ref === staleP1.ref || j.thread_ref === unclaimedP0.ref) && j.outcome === 'sent'
      )
    ).toBe(false);

    // Resume: epoch increments, parked proposals are EXPIRED, not replayed.
    for (const row of world.journal) {
      if (row.outcome === 'parked' || row.outcome === 'pending') row.outcome = 'expired';
    }
    world.control = {
      ...world.control,
      pause_state: 'RUNNING',
      pause_scope: null,
      epoch: world.control.epoch + 1,
    };

    world.nowMs += 60_000;
    await tick(state, deps);
    // The old confirmation was dropped with the epoch change: no immediate
    // replay of the parked P1 nudge on the first post-resume tick.
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:')).length).toBe(
      0
    );
    expect(
      world.journal.filter(j => j.thread_ref === staleP1.ref && j.outcome === 'expired').length
    ).toBe(1);
  });
});

const EXPECTED_SPEC = {
  specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-HARNESS-EXAMPLE-01.md',
  specRevision: 'a'.repeat(40),
  specHash: `sha256:${'b'.repeat(64)}`,
};
describe('fire_cauldron loop', () => {
  test('legacy eligibility without immutable identity never dispatches a cascade', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [
            makeListedThread({ isUnclaimed: true, title: 'WO-HARNESS-EXAMPLE-01', priority: 'P1' }),
          ],
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              noOpenOrMergedPr: true,
              specVerifiedAt: new Date(T0).toISOString(),
            },
          }),
          runCascade: async options => {
            admissions++;
            const record = { cascadeId: 'bad', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          },
        })
      );
      expect(admissions).toBe(0);
      expect(
        world.journal.some(row => row.action_type === 'fire_cauldron' && row.outcome === 'sent')
      ).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });
  test('fire backoff still delivers an outstanding ruling for the P0', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const item = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-harness#500',
      priority: 'P0',
      isUnclaimedP0: true,
      undeliveredRulingId: 'ruling-during-fire-backoff',
    });
    world.journal.push({
      id: 'failed-fire-500',
      created_at: new Date(T0).toISOString(),
      thread_ref: item.ref,
      action_type: 'fire_cauldron',
      proposal_json: '{}',
      idempotency_key: 'old-fire-500',
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'failed',
      graded_at: null,
      grade: null,
    });
    await tick(createTaskmasterState(60_000), makeDeps(world, { listThreads: async () => [item] }));
    expect(world.journal.some(row => row.action_type === 'deliver_ruling')).toBe(true);
  });

  test('qualified fresh unclaimed P1 admits exactly one cascade and journals its run id', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item: ListedThread = {
        ref: 'gh:thinmansoftware/bdc-harness#501',
        priority: 'P1',
        lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
        isUnclaimed: true,
        recipient: 'xo',
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      };
      let admissions = 0;
      const record = { cascadeId: 'cascade-501', status: 'running' } as unknown as Awaited<
        ReturnType<NonNullable<TaskmasterDeps['runCascade']>>
      >;
      const deps = makeDeps(world, {
        listUndeliveredRulings: async () => [],
        listThreads: async () => [item],
        checkFireEligibility: async () => ({
          eligible: true,
          evidence: {
            woId: 'WO-HARNESS-EXAMPLE-01',
            targetRepo: 'thinmansoftware/bdc-harness',
            project: 'bdc-harness',
            specVerifiedAt: new Date(T0).toISOString(),
            noOpenOrMergedPr: true,
            expectedSpec: EXPECTED_SPEC,
          },
        }),
        runCascade: (async options => {
          admissions += 1;
          expect(options.expectedSpec).toEqual(EXPECTED_SPEC);
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      await tick(state, deps);
      expect(admissions).toBe(1);
      const fires = world.journal.filter(row => row.action_type === 'fire_cauldron');
      expect(fires).toHaveLength(1);
      expect(fires[0]?.outcome).toBe('sent');
      expect(fires[0]?.proposal_json).toContain('cascade-501');
      expect(world.sentMessages.some(message => message.body.includes('Unclaimed P0'))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('hold-labeled unclaimed work is refused fire even when its blocker names a seat', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#509',
        priority: 'P1',
        isUnclaimed: true,
        isBlocked: true,
        labels: ['wo', 'status:hold'],
        title: 'WO-HARNESS-EXAMPLE-509 held build',
      });
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          getGithubIssueEvidence: async () =>
            makeEvidence({
              latestMarkerKind: 'BLOCKED',
              latestMarkerText: 'major-build must resolve the hold',
            }),
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-509',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'issue-body',
            },
          }),
          runCascade: (async () => {
            admissions += 1;
            return { cascadeId: 'unexpected', status: 'running' } as never;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(0);
      expect(world.journal.some(row => row.action_type === 'fire_cauldron')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('mixed immediate proposals keep exceptions ahead of priority-ordered fires', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const events: string[] = [];
      const threads = [
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#523',
          priority: 'P3',
          isUnclaimed: true,
          title: 'WO-HARNESS-EXAMPLE-523 build',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#520',
          priority: 'P0',
          isUnclaimed: true,
          isUnclaimedP0: true,
          title: 'WO-HARNESS-EXAMPLE-520 no spec',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#521',
          priority: 'P1',
          isUnclaimed: true,
          title: 'WO-HARNESS-EXAMPLE-521 build',
        }),
      ];
      const deps = makeDeps(world, {
        listUndeliveredRulings: async () => [ruling()],
        listThreads: async () => threads,
        checkFireEligibility: async title => {
          const woId = title.split(' ')[0]!;
          if (woId.endsWith('-520')) return { eligible: false, reason: 'missing_spec' };
          return {
            eligible: true,
            evidence: {
              woId,
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'repo-path',
            },
          };
        },
        createTask: (async (_context, data) => {
          events.push(data.body.includes('Ratified ruling') ? 'deliver_ruling' : 'escalate_p0');
          return { id: `msg-${events.length}`, status: 'queued' } as never;
        }) as TaskmasterDeps['createTask'],
        runCascade: (async options => {
          events.push(`fire:${options.woId}`);
          const record = { cascadeId: `cascade-${options.woId}`, status: 'running' } as never;
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      await tick(createTaskmasterState(60_000), deps);
      expect(events).toEqual([
        'deliver_ruling',
        'escalate_p0',
        'fire:WO-HARNESS-EXAMPLE-521',
        'fire:WO-HARNESS-EXAMPLE-523',
      ]);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('fire cap dispatches P0 through P2 first and defers overflow for the next tick', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const threads = [
        ['P3', 513],
        ['P2', 512],
        ['P0', 510],
        ['P3', 514],
        ['P1', 511],
      ].map(([priority, number]) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-harness#${number}`,
          priority: priority as ThreadSnapshot['priority'],
          isUnclaimed: true,
          isUnclaimedP0: priority === 'P0',
          title: `WO-HARNESS-EXAMPLE-${number} build`,
          lastActivityAt: new Date(T0).toISOString(),
        })
      );
      const admitted: string[] = [];
      const deps = makeDeps(world, {
        listThreads: async () => threads,
        checkFireEligibility: async title => {
          const woId = title.split(' ')[0]!;
          return {
            eligible: true,
            evidence: {
              woId,
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
              specSource: 'repo-path',
            },
          };
        },
        runCascade: (async options => {
          admitted.push(options.woId);
          const record = { cascadeId: `cascade-${options.woId}`, status: 'running' } as never;
          options.onAdmission?.(record, true);
          return record;
        }) as NonNullable<TaskmasterDeps['runCascade']>,
      });
      const state = createTaskmasterState(60_000);
      await tick(state, deps);
      expect(admitted).toEqual([
        'WO-HARNESS-EXAMPLE-510',
        'WO-HARNESS-EXAMPLE-511',
        'WO-HARNESS-EXAMPLE-512',
      ]);
      expect(world.journal.filter(row => row.outcome === 'deferred')).toHaveLength(2);

      world.nowMs += 60_000;
      await tick(state, deps);
      expect(admitted.slice(3).sort()).toEqual([
        'WO-HARNESS-EXAMPLE-513',
        'WO-HARNESS-EXAMPLE-514',
      ]);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('prior same-day sent fires do not impose a daily fire ceiling', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#504',
        priority: 'P0',
        isUnclaimedP0: true,
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      });
      for (const n of [1, 2]) {
        world.journal.push({
          id: `same-day-fire-${n}`,
          created_at: new Date(T0 - n * 60_000).toISOString(),
          thread_ref: item.ref,
          action_type: 'fire_cauldron',
          proposal_json: JSON.stringify({
            type: 'fire_cauldron',
            cascadeId: `old-cascade-${n}`,
            fireEvidence: { woId: 'WO-HARNESS-EXAMPLE-01' },
          }),
          idempotency_key: `old-fire-${n}`,
          before_hash: null,
          proof_predicate: null,
          proof_deadline_at: new Date(T0 + 60_000).toISOString(),
          outcome: 'sent',
          graded_at: null,
          grade: null,
        });
      }
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          getFireRunEvidence: async () => ({ status: 'completed', prOpened: false }),
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async options => {
            admissions += 1;
            const record = { cascadeId: 'new-cascade', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(1);
      expect(world.journal.filter(row => row.action_type === 'fire_cauldron')).toHaveLength(3);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('tick derives case-insensitive customer P0 exemption while holding all lanes', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      const threads = [
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#505',
          priority: 'P0',
          isUnclaimedP0: true,
          labels: ['wo', 'CuStOmEr-FaCiNg'],
          title: 'WO-HARNESS-EXAMPLE-01 customer outage',
        }),
        makeListedThread({
          ref: 'gh:thinmansoftware/bdc-harness#506',
          priority: 'P1',
          isUnclaimedP0: true,
          labels: ['CUSTOMER'],
          title: 'WO-HARNESS-EXAMPLE-02 mislabeled priority',
        }),
      ];
      const healthProviders: string[] = [];
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => threads,
          headroom: async () => ({
            state: 'LOW',
            tokensRemaining: 0,
            isUnknown: false,
            source: 'test',
            observedAt: new Date(T0).toISOString(),
          }),
          getHealthSample: async provider => {
            healthProviders.push(provider);
            return {
              provider,
              state: 'degraded',
              sampled_at: new Date(T0).toISOString(),
              expires_at: new Date(T0 + 60_000).toISOString(),
              evidence: null,
            };
          },
          checkFireEligibility: async title => ({
            eligible: true,
            evidence: {
              woId: title.includes('EXAMPLE-01')
                ? 'WO-HARNESS-EXAMPLE-01'
                : 'WO-HARNESS-EXAMPLE-02',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async options => {
            admissions += 1;
            const record = { cascadeId: 'customer-cascade', status: 'running' } as never;
            options.onAdmission?.(record, true);
            return record;
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(healthProviders.sort()).toEqual(['codex', 'xai']);
      expect(admissions).toBe(1);
      expect(
        world.journal.filter(row => row.action_type === 'fire_cauldron').map(row => row.thread_ref)
      ).toEqual([threads[0]!.ref]);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('budget hold monitor is visible once per 96 ticks and health is read each tick', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const monitorTicks: number[] = [];
    let healthReads = 0;
    const deps = makeDeps(world, {
      headroom: async () => ({
        state: 'LOW',
        tokensRemaining: 0,
        isUnknown: false,
        source: 'test',
        observedAt: new Date(world.nowMs).toISOString(),
      }),
      getHealthSample: async provider => {
        healthReads += 1;
        return {
          provider,
          state: 'degraded',
          sampled_at: new Date(world.nowMs).toISOString(),
          expires_at: new Date(world.nowMs + 60_000).toISOString(),
          evidence: null,
        };
      },
      onFireBudgetHolding: tickIndex => monitorTicks.push(tickIndex),
    });
    const state = createTaskmasterState(60_000);
    for (let n = 0; n < 97; n += 1) {
      await tick(state, deps);
      world.nowMs += 60_000;
    }
    expect(monitorTicks).toEqual([1, 97]);
    expect(healthReads).toBe(97 * 2);
  });

  test('pause scope=effects parks an eligible fire without admitting a cascade', async () => {
    const prior = process.env.TASKMASTER_FIRE_VERB_ENABLED;
    process.env.TASKMASTER_FIRE_VERB_ENABLED = 'true';
    try {
      const world = makeWorld();
      seedDigestSent(world);
      world.control.pause_state = 'PAUSED';
      world.control.pause_scope = 'effects';
      const item = makeListedThread({
        ref: 'gh:thinmansoftware/bdc-harness#502',
        priority: 'P0',
        isUnclaimedP0: true,
        title: 'WO-HARNESS-EXAMPLE-01 urgent build',
      });
      let admissions = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          listThreads: async () => [item],
          checkFireEligibility: async () => ({
            eligible: true,
            evidence: {
              woId: 'WO-HARNESS-EXAMPLE-01',
              targetRepo: 'thinmansoftware/bdc-harness',
              project: 'bdc-harness',
              specVerifiedAt: new Date(T0).toISOString(),
              noOpenOrMergedPr: true,
              expectedSpec: EXPECTED_SPEC,
            },
          }),
          runCascade: (async () => {
            admissions += 1;
            throw new Error('paused fire must not run');
          }) as NonNullable<TaskmasterDeps['runCascade']>,
        })
      );
      expect(admissions).toBe(0);
      const fire = world.journal.find(row => row.action_type === 'fire_cauldron');
      expect(fire?.outcome).toBe('parked');
      expect(fire?.proposal_json).toContain('"reason":"paused"');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_FIRE_VERB_ENABLED;
      else process.env.TASKMASTER_FIRE_VERB_ENABLED = prior;
    }
  });

  test('grades completed fire useful and overdue running fire noise', async () => {
    for (const testCase of [
      { id: 'completed-fire', status: 'completed', deadline: T0 + 60_000, grade: 'useful' },
      { id: 'overdue-running-fire', status: 'running', deadline: T0 - 1, grade: 'noise' },
    ] as const) {
      const world = makeWorld();
      seedDigestSent(world);
      world.journal.push({
        id: testCase.id,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: 'gh:thinmansoftware/bdc-harness#503',
        action_type: 'fire_cauldron',
        proposal_json: JSON.stringify({
          type: 'fire_cauldron',
          cascadeId: `cascade-${testCase.id}`,
          fireEvidence: { woId: 'WO-HARNESS-EXAMPLE-01' },
        }),
        idempotency_key: `tm:fire:${testCase.id}`,
        before_hash: null,
        proof_predicate: 'cascade completes, opens a PR, or issue enters BUILDING',
        proof_deadline_at: new Date(testCase.deadline).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      let evidenceCalls = 0;
      await tick(
        createTaskmasterState(60_000),
        makeDeps(world, {
          getFireRunEvidence: async () => {
            evidenceCalls += 1;
            return { status: testCase.status, prOpened: false };
          },
        })
      );
      expect(evidenceCalls).toBe(1);
      expect(world.journal.find(row => row.id === testCase.id)?.grade).toBe(testCase.grade);
    }
  });
});

describe('WO pause-gate enforcement (WO-HARNESS-TASKMASTER-PAUSE-GATE-ENFORCE-01)', () => {
  // Three deliverable-in-one-tick proposals: one deliver_ruling + two
  // unclaimed-P0 escalations (all actsImmediately, distinct threads).
  function threeDeliverables(): {
    rulings: ThreadSnapshot[];
    threads: ThreadSnapshot[];
    refs: string[];
  } {
    const ruled: ThreadSnapshot = {
      ref: 'dispatch:ruling-77',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      undeliveredRulingId: 'ruling-77',
      recipient: 'xo',
    };
    const p0a: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#21',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };
    const p0b: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#22',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };
    return { rulings: [ruled], threads: [p0a, p0b], refs: [ruled.ref, p0a.ref, p0b.ref] };
  }

  test('Test 1: paused scope=effects tick withholds all 3 effects, parks each with reason=paused', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const { rulings, threads, refs } = threeDeliverables();
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // Zero transport calls.
    expect(world.sentMessages.length).toBe(0);
    // Exactly 3 parked rows, one per deliverable, each with reason=paused.
    expect(result.parked).toBe(3);
    const parked = world.journal.filter(j => j.outcome === 'parked' && refs.includes(j.thread_ref));
    expect(parked.length).toBe(3);
    for (const row of parked) {
      expect(row.proposal_json).toContain('"reason":"paused"');
    }
    // No sent journal rows for this tick.
    expect(world.journal.some(j => j.outcome === 'sent' && refs.includes(j.thread_ref))).toBe(
      false
    );
  });

  test('Test 2: running (RUNNING) tick delivers all 3 effects (no regression)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // pause_state defaults to RUNNING, pause_scope null.

    const { rulings, threads, refs } = threeDeliverables();
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // All 3 deliver exactly as before the gate WO.
    expect(result.effects).toBe(3);
    expect(result.parked).toBe(0);
    expect(world.sentMessages.length).toBe(3);
    const sent = world.journal.filter(j => j.outcome === 'sent' && refs.includes(j.thread_ref));
    expect(sent.length).toBe(3);
  });

  test('Test 3: no burst on unpause -- previously parked-by-pause rows are not replayed', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.control.pause_state = 'PAUSED';
    world.control.pause_scope = 'effects';
    world.control.pause_actor = 'john';

    const { rulings, threads, refs } = threeDeliverables();
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => rulings,
      listThreads: async () => threads,
    });
    const state = createTaskmasterState(60_000);

    // Paused tick parks all 3.
    const paused = await tick(state, deps);
    expect(paused.parked).toBe(3);
    expect(world.sentMessages.length).toBe(0);

    // Flip to RUNNING with a fresh epoch (resume pattern).
    world.control = {
      ...world.control,
      pause_state: 'RUNNING',
      pause_scope: null,
      epoch: world.control.epoch + 1,
    };

    // Next tick: the parked rows are NOT replayed (skip-on-parked at the top of
    // the effect loop guarantees this). The same proposals recompute; because
    // they still carry outcome='parked' from the prior tick they are skipped,
    // so no burst of sends fires from the pause backlog.
    world.nowMs += 60_000;
    const resumed = await tick(state, deps);

    // The previously-parked rows drive zero replays.
    expect(world.sentMessages.length).toBe(0);
    expect(resumed.effects).toBe(0);
    // The parked rows remain parked (not converted to sent).
    const stillParked = world.journal.filter(
      j => j.outcome === 'parked' && refs.includes(j.thread_ref)
    );
    expect(stillParked.length).toBe(3);
  });

  test('mid-tick pause (fresh-epoch re-check) also honors scope=effects for escalate_p0', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // Start RUNNING so the initial gate lets the escalation through to the
    // ROW-FIRST write, then a pause lands before the fresh re-check.
    const p0: ThreadSnapshot = {
      ref: 'gh:thinmansoftware/bdc-harness#31',
      priority: 'P0',
      lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
      isUnclaimedP0: true,
      recipient: 'xo',
    };

    let getCalls = 0;
    const deps = makeDeps(world, {
      listThreads: async () => [p0],
      db: {
        ...makeDeps(world).db,
        // First getPauseState (top of tick) sees RUNNING; the fresh re-check
        // just before the send sees PAUSED scope=effects at the SAME epoch, so
        // only the scope recompute (not the epoch mismatch) can catch it. Under
        // the old code escalate_p0 was pause-exempt and would have sent.
        getPauseState: async () => {
          getCalls += 1;
          if (getCalls === 1) return world.control;
          return {
            ...world.control,
            pause_state: 'PAUSED',
            pause_scope: 'effects',
          };
        },
      },
    });
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    // The escalation reached the ROW-FIRST write but the fresh re-check caught
    // the mid-tick pause: it is withheld (parked), NOT sent.
    expect(world.sentMessages.length).toBe(0);
    expect(world.journal.some(j => j.thread_ref === p0.ref && j.outcome === 'sent')).toBe(false);

    // A mid-tick pause is a pause-park, not a stale-epoch/resume expiry: the row
    // is re-tagged 'parked' (NOT 'expired') so it is indistinguishable from a
    // site-1 pause-park.
    const p0Row = world.journal.find(
      j => j.thread_ref === p0.ref && j.action_type === 'escalate_p0'
    );
    expect(p0Row?.outcome).toBe('parked');
    expect(world.journal.some(j => j.thread_ref === p0.ref && j.outcome === 'expired')).toBe(false);

    // Its proposal_json carries reason='paused' -- the design-required parked
    // provenance, matching what site 1 writes.
    const parsed = JSON.parse(p0Row?.proposal_json ?? '{}') as {
      parked?: boolean;
      reason?: string;
    };
    expect(parsed.parked).toBe(true);
    expect(parsed.reason).toBe('paused');

    // The withheld effect is counted in result.parked (the exact withheld total
    // that the tick_paused_withheld log reports) and NOT in result.expired.
    expect(result.parked).toBe(1);
    expect(result.expired).toBe(0);
  });
});

describe('scenario 4: restart produces no double effect', () => {
  test('pending journal row with an existing dispatch row reconciles to sent without a second send', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:deliver_ruling:ruling-42';
    // In-flight marker from the previous process: row first, then crash.
    world.journal.push({
      id: 'journal-preexisting',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'dispatch:ruling-42',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    // The effect DID land in the SOR before the crash.
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'ruling',
      createdAt: new Date(T0 - 30_000).toISOString(),
    });
    const sendsBefore = world.sentMessages.length;

    const deps = makeDeps(world, { listUndeliveredRulings: async () => [ruling()] });
    const state = createTaskmasterState(60_000); // fresh process
    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // Reconciliation marked the row sent; no second createMessage with the same key.
    const row = world.journal.find(j => j.id === 'journal-preexisting');
    expect(row?.outcome).toBe('sent');
    expect(world.sentMessages.filter(m => m.idempotency_key === key).length).toBe(1);
    expect(world.sentMessages.length).toBe(sendsBefore);
  });

  test('pending row with NO dispatch row expires (safe direction: re-propose fresh later)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'journal-orphan',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:x#1',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:gh:x#1:999',
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world);
    const state = createTaskmasterState(60_000);
    await tick(state, deps);
    expect(world.journal.find(j => j.id === 'journal-orphan')?.outcome).toBe('expired');
    expect(world.sentMessages.length).toBe(0);
  });

  test('legacy null-principal taskmaster effect cannot reconcile a pending journal', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#129:1';
    world.journal.push({
      id: 'journal-legacy-taskmaster-effect',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#129',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: null,
      proof_deadline_at: null,
      outcome: 'pending',
      graded_at: null,
      grade: null,
    });
    const queries: string[] = [];
    const findLegacyEffect = (effectKey: string) =>
      defaultFindEffectByIdempotencyKey(effectKey, async (sql, params) => {
        queries.push(sql);
        if (params[0] !== key) return { rows: [] };
        return sql.includes('sender_principal_id IS NULL')
          ? {
              rows: [
                {
                  id: 'legacy-taskmaster-dispatch',
                  status: 'queued',
                  created_at: new Date(T0 - 30_000).toISOString(),
                },
              ],
            }
          : { rows: [] };
      });
    const state = createTaskmasterState(60_000);

    await tick(
      state,
      makeDeps(world, {
        findEffectByIdempotencyKey: findLegacyEffect,
        getDispatchMessageById: async () => null,
        getGithubIssueEvidence: async () => null,
        listThreads: async () => [],
      })
    );

    expect(world.journal.find(row => row.id === 'journal-legacy-taskmaster-effect')?.outcome).toBe(
      'expired'
    );
    expect(queries[0]).toContain("sender_principal_id = 'system:taskmaster'");
    expect(queries[0]).not.toContain('sender_principal_id IS NULL');
  });
});

describe('failed effect reuse and successful-tick health', () => {
  test('a failed effect retries on the same journal row and recovers on the next tick', async () => {
    const world = makeWorld();
    let attempts = 0;
    const deps = makeDeps(world, {
      createTask: (async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('synthetic dispatch failure');
        return { id: 'digest-message', status: 'queued' };
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);

    const failed = await tick(state, deps);
    expect(failed.successful).toBe(false);
    expect(failed.failed).toBe(1);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('failed');
    expect(state.deadman.lastTickAtMs).toBeNull();

    world.nowMs += 60_000;
    const recovered = await tick(state, deps);
    expect(recovered.successful).toBe(true);
    expect(attempts).toBe(2);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('sent');
    expect(state.deadman.lastTickAtMs).toBe(world.nowMs);
  });

  test('an expired failed effect is not retried or inserted again', async () => {
    const world = makeWorld();
    world.journal.push({
      id: 'expired-digest-attempt',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: `digest:${TODAY_KEY}`,
      action_type: 'digest',
      proposal_json: '{}',
      idempotency_key: `tm:digest:${TODAY_KEY}`,
      before_hash: null,
      proof_predicate: 'digest delivery only',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'failed',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(state, deps);

    expect(result.successful).toBe(true);
    expect(world.sentMessages).toHaveLength(0);
    expect(world.journal).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('expired');
  });

  test('repeated failures attempt once per tick and keep one failed row', async () => {
    const world = makeWorld();
    let attempts = 0;
    const deps = makeDeps(world, {
      createTask: (async () => {
        attempts += 1;
        throw new Error('persistent dispatch failure');
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);

    for (let tickNumber = 0; tickNumber < 3; tickNumber += 1) {
      const result = await tick(state, deps);
      expect(result.successful).toBe(false);
      world.nowMs += 60_000;
    }

    expect(attempts).toBe(3);
    expect(world.journal.filter(row => row.action_type === 'digest')).toHaveLength(1);
    expect(world.journal[0]?.outcome).toBe('failed');
  });

  test('a deferred row is reused when the next tick has budget', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const staleThread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1500',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Deferred stale item',
    });
    world.journal.push({
      id: 'deferred-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: staleThread.ref,
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: `tm:nudge:${staleThread.ref}:${Math.floor(T0 / NUDGE_CLOCK_MS.P1)}`,
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'deferred',
      graded_at: null,
      grade: null,
    });

    const result = await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        listThreads: async () => [staleThread],
        getGithubIssueEvidence: async () =>
          makeEvidence({
            ownerLogin: 'major-build',
            latestMarkerKind: 'PROGRESS',
            latestMarkerText: 'waiting on review feedback',
            latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementKind: 'progress_comment',
          }),
      })
    );

    expect(result.effects).toBe(1);
    expect(world.journal.filter(row => row.id === 'deferred-nudge')).toHaveLength(1);
    expect(world.journal.find(row => row.id === 'deferred-nudge')?.outcome).toBe('sent');
  });

  test('an expired deferred row is terminal and is not sent', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const staleThread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1501',
      priority: 'P1',
      lastActivityAt: new Date(T0 - 5 * 3_600_000).toISOString(),
      recipient: 'xo',
      title: 'Expired deferred item',
    });
    world.journal.push({
      id: 'expired-deferred-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: staleThread.ref,
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: `tm:nudge:${staleThread.ref}:${Math.floor(T0 / NUDGE_CLOCK_MS.P1)}`,
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 - 1).toISOString(),
      outcome: 'deferred',
      graded_at: null,
      grade: null,
    });

    const result = await tick(
      createTaskmasterState(60_000),
      makeDeps(world, {
        listThreads: async () => [staleThread],
        getGithubIssueEvidence: async () =>
          makeEvidence({
            ownerLogin: 'major-build',
            latestMarkerKind: 'PROGRESS',
            latestMarkerText: 'waiting on review feedback',
            latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
            lastMovementKind: 'progress_comment',
          }),
      })
    );

    expect(result.effects).toBe(0);
    expect(world.sentMessages).toHaveLength(0);
    expect(world.journal).toHaveLength(2);
    expect(world.journal.find(row => row.id === 'expired-deferred-nudge')?.outcome).toBe('expired');
  });

  test('a successful no-op tick records the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(state, makeDeps(world));

    expect(result.successful).toBe(true);
    expect(result.failed).toBe(0);
    expect(state.deadman.lastTickAtMs).toBe(T0);
  });

  test('a failed source read does not advance the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        listThreads: async () => {
          throw new Error('synthetic GitHub read failure');
        },
      })
    );

    expect(result.successful).toBe(false);
    expect(result.failed).toBe(1);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });
});

describe('SC7 grading requires external source progress', () => {
  test('a queued outbound reminder row alone remains ungraded', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'sent-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      before_hash: null,
      proof_predicate: 'source issue progress after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      recipient: 'xo',
      body: 'reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });
    world.sentMessages.push({
      idempotency_key: `tm:digest:${TODAY_KEY}`,
      recipient: 'operator',
      body: 'digest',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });

    await tick(createTaskmasterState(60_000), makeDeps(world));

    expect(world.journal.find(row => row.id === 'sent-nudge')?.grade).toBeNull();
    expect(world.journal.find(row => row.action_type === 'digest')?.grade).toBeNull();
  });

  test('the original ruling addressed by its recipient makes delivery useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    world.journal.push({
      id: 'sent-ruling-reminder',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'dispatch:ruling-original',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver_ruling:ruling-original',
      before_hash: null,
      proof_predicate: 'original ruling addressed after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: 'tm:deliver_ruling:ruling-original',
      recipient: 'xo',
      body: 'ruling reminder',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getDispatchMessageById: (async () => ({
        id: 'ruling-original',
        recipient: 'xo',
        resolved_recipient: 'xo',
        addressed_at: new Date(T0 - 30_000).toISOString(),
        addressed_by: 'xo',
      })) as unknown as TaskmasterDeps['getDispatchMessageById'],
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'sent-ruling-reminder')?.grade).toBe('useful');
  });

  test('a post-send source progress marker makes a nudge useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1';
    world.journal.push({
      id: 'progress-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'nudge',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'prio:P1', 'status:building'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: new Date(T0 - 30_000).toISOString(),
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'progress-nudge')?.grade).toBe('useful');
  });

  test('source progress after journal creation but before the actual send is not useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1451:1';
    world.journal.push({
      id: 'pre-send-progress-nudge',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1451',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'nudge',
      createdAt: new Date(T0 - 30_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 45_000).toISOString(),
        labels: ['wo', 'prio:P1'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: new Date(T0 - 45_000).toISOString(),
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'pre-send-progress-nudge')?.grade).toBeNull();
  });

  test('unacknowledged, acknowledged-only, and auto-addressed rulings are not useful', async () => {
    const cases = [
      { name: 'unacknowledged', acknowledged_at: null, addressed_at: null, addressed_by: null },
      {
        name: 'acknowledged-only',
        acknowledged_at: new Date(T0 - 20_000).toISOString(),
        addressed_at: null,
        addressed_by: null,
      },
      {
        name: 'auto-addressed',
        acknowledged_at: new Date(T0 - 20_000).toISOString(),
        addressed_at: new Date(T0 - 10_000).toISOString(),
        addressed_by: 'taskmaster:auto',
      },
    ];

    for (const testCase of cases) {
      const world = makeWorld();
      seedDigestSent(world);
      const rulingId = `ruling-${testCase.name}`;
      const key = `tm:deliver_ruling:${rulingId}`;
      world.journal.push({
        id: `journal-${testCase.name}`,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: `dispatch:${rulingId}`,
        action_type: 'deliver_ruling',
        proposal_json: '{}',
        idempotency_key: key,
        before_hash: null,
        proof_predicate: 'original ruling addressed after send',
        proof_deadline_at: new Date(T0 + 60_000).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      world.sentMessages.push({
        idempotency_key: key,
        recipient: 'xo',
        body: 'ruling reminder',
        createdAt: new Date(T0 - 30_000).toISOString(),
      });
      const deps = makeDeps(world, {
        getDispatchMessageById: (async () => ({
          id: rulingId,
          recipient: 'xo',
          resolved_recipient: 'xo',
          acknowledged_at: testCase.acknowledged_at,
          addressed_at: testCase.addressed_at,
          addressed_by: testCase.addressed_by,
        })) as unknown as TaskmasterDeps['getDispatchMessageById'],
      });

      await tick(createTaskmasterState(60_000), deps);

      expect(world.journal.find(row => row.id === `journal-${testCase.name}`)?.grade).toBeNull();
    }
  });

  test('a cancelled effect is noise and an unchanged P0 source is not useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1600:1';
    world.journal.push({
      id: 'cancelled-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1600',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    const deps = makeDeps(world, {
      findEffectByIdempotencyKey: async effectKey =>
        effectKey === key
          ? {
              id: 'cancelled-effect',
              status: 'cancelled',
              createdAt: new Date(T0 - 45_000).toISOString(),
            }
          : null,
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 60_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 0,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'cancelled-escalation')?.grade).toBe('noise');
  });

  test('a post-send assignment event makes a P0 escalation useful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1601:1';
    world.journal.push({
      id: 'assigned-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1601',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'operator',
      body: 'escalate',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 1,
        closedAt: null,
        assignedAt: new Date(T0 - 30_000).toISOString(),
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(world.journal.find(row => row.id === 'assigned-escalation')?.grade).toBe('useful');
  });

  test('a pre-existing assignee without a post-send event is not useful proof', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:escalate_p0:gh:thinmansoftware/bdc-xo#1602:1';
    world.journal.push({
      id: 'preexisting-assignee-escalation',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1602',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'P0 source claim after send',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'operator',
      body: 'escalate',
      createdAt: new Date(T0 - 45_000).toISOString(),
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => ({
        state: 'open',
        updatedAt: new Date(T0 - 30_000).toISOString(),
        labels: ['wo', 'P0'],
        assigneeCount: 1,
        closedAt: null,
        assignedAt: null,
        activeStatusAt: null,
        progressRecordedAt: null,
      }),
    });

    await tick(createTaskmasterState(60_000), deps);

    expect(
      world.journal.find(row => row.id === 'preexisting-assignee-escalation')?.grade
    ).toBeNull();
  });
});

describe('scenario 5: budget ceiling holds', () => {
  test('25 eligible stale threads: at most 10 effects, 1 per item, remainder journaled deferred', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const threads = Array.from({ length: 25 }, (_, i) =>
      makeListedThread({
        ref: `gh:thinmansoftware/bdc-harness#${100 + i}`,
        priority: 'P1',
        lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
        recipient: 'xo',
        title: `Stale item ${100 + i}`,
      })
    );
    const deps = makeDeps(world, {
      listThreads: async () => threads,
      // Content-complete adoption for every thread so all 25 nudges compose;
      // this test is about the EFFECT budget (10/tick), so the adoption
      // evidence budget is raised to cover the full set in one tick.
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'PROGRESS',
          latestMarkerText: 'waiting on review feedback',
          latestMarkerAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementAt: new Date(T0 - 3 * 3_600_000).toISOString(),
          lastMovementKind: 'progress_comment',
        }),
    });
    const state = createTaskmasterState(60_000);

    const priorBudget = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = '25';
    let result;
    try {
      await tick(state, deps); // observation tick
      world.nowMs += 60_000;
      result = await tick(state, deps); // confirming tick
    } finally {
      if (priorBudget === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = priorBudget;
    }

    expect(result.effects).toBe(10);
    expect(world.sentMessages.length).toBe(10);
    expect(world.sentMessages.every(message => message.body.includes('[PROGRESS]'))).toBe(true);
    expect(world.sentMessages.every(message => message.body.includes('[BLOCKED]'))).toBe(true);

    // No item receives 2 effects in the tick.
    const perThread = new Map<string, number>();
    for (const row of world.journal.filter(j => j.outcome === 'sent')) {
      perThread.set(row.thread_ref, (perThread.get(row.thread_ref) ?? 0) + 1);
    }
    for (const count of perThread.values()) expect(count).toBe(1);

    // Remainder journaled as deferred, not dropped.
    const deferred = world.journal.filter(j => j.outcome === 'deferred');
    expect(deferred.length).toBe(15);
    expect(deferred.every(row => row.proof_predicate !== null)).toBe(true);
    expect(deferred.every(row => row.proof_deadline_at !== null)).toBe(true);
  });
});

describe('auto-circuit: forbidden effect HARD-PAUSES effects, never KILLs', () => {
  test('a proposal to a non-allowlisted recipient is journaled rejected and trips HARD_PAUSE', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => [ruling({ recipient: 'board' })],
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps);

    expect(world.sentMessages.length).toBe(0);
    const rejected = world.journal.filter(j => j.outcome === 'rejected');
    expect(rejected.length).toBe(1);
    expect(world.control.pause_state).toBe('HARD_PAUSE');
    expect(world.control.pause_actor).toBe('taskmaster:auto-circuit');
    // The circuit tightened into pause; the tick loop itself keeps running
    // (KILL is only ever TASKMASTER_INTERVAL_MS=0, operator-set).
    const result = await tick(state, deps);
    expect(result.ran).toBe(true);
  });
});

describe('interval env parsing', () => {
  test('default 60000, explicit value honored, 0 = off, garbage falls back', () => {
    expect(resolveTaskmasterIntervalMs(undefined)).toBe(60_000);
    expect(resolveTaskmasterIntervalMs('1000')).toBe(1000);
    expect(resolveTaskmasterIntervalMs('0')).toBe(0);
    expect(resolveTaskmasterIntervalMs('banana')).toBe(60_000);
    expect(resolveTaskmasterIntervalMs('-5')).toBe(60_000);
  });
});

describe('defaultListThreads -- GitHub work-SOR read', () => {
  // Pin the repo list so an operator env var cannot skew the assertions.
  const priorRepos = process.env.TASKMASTER_GH_REPOS;
  process.env.TASKMASTER_GH_REPOS = 'thinmansoftware/bdc-harness';
  afterAll(() => {
    if (priorRepos === undefined) delete process.env.TASKMASTER_GH_REPOS;
    else process.env.TASKMASTER_GH_REPOS = priorRepos;
  });

  function ghIssue(
    number: number,
    labels: string[],
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      number,
      updated_at: new Date(T0).toISOString(),
      labels: labels.map(name => ({ name })),
      assignees: [],
      ...overrides,
    };
  }

  function fakeGithubFetch(byLabel: Record<string, Record<string, unknown>[]>): {
    urls: string[];
    fetchImpl: typeof fetch;
  } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const label = new URL(url).searchParams.get('labels') ?? '';
      return new Response(JSON.stringify(byLabel[label] ?? []), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '100',
        },
      });
    }) as typeof fetch;
    return { urls, fetchImpl };
  }

  test('queries wo, project, and arc separately while preserving an explicit repo override', async () => {
    const { urls, fetchImpl } = fakeGithubFetch({
      wo: [ghIssue(1, ['wo', 'P1']), ghIssue(3, ['wo', 'arc', 'P0'])],
      arc: [ghIssue(2, ['arc', 'P2']), ghIssue(3, ['wo', 'arc', 'P0'])],
      project: [ghIssue(5, ['project', 'prio:P1'])],
    });

    const threads = await defaultListThreads(fetchImpl);

    // One request per work label -- never a single labels=wo,arc request,
    // which GitHub treats as AND (both labels required).
    const labelParams = urls.map(u => new URL(u).searchParams.get('labels'));
    expect(labelParams).toContain('wo');
    expect(labelParams).toContain('arc');
    expect(labelParams).toContain('project');
    expect(labelParams.every(l => l === 'wo' || l === 'project' || l === 'arc')).toBe(true);

    // arc-only work IS observed; both-label work appears exactly once.
    const refs = threads.map(t => t.ref).sort();
    expect(refs).toEqual([
      'gh:thinmansoftware/bdc-harness#1',
      'gh:thinmansoftware/bdc-harness#2',
      'gh:thinmansoftware/bdc-harness#3',
      'gh:thinmansoftware/bdc-harness#5',
    ]);
    const p0 = threads.find(t => t.ref.endsWith('#3'));
    expect(p0?.priority).toBe('P0');
    expect(p0?.isUnclaimed).toBe(true);
    expect(p0?.isUnclaimedP0).toBe(true);
  });

  test('normalizes exact priority label families and status-prefixed blocked labels', async () => {
    const { fetchImpl } = fakeGithubFetch({
      wo: [
        ghIssue(10, ['wo', 'P1']),
        ghIssue(11, ['wo', 'prio:P1']),
        ghIssue(12, ['wo', 'priority:p1']),
        ghIssue(13, ['wo', 'not-p0', 'P3', 'prio:P0']),
        ghIssue(14, ['wo', 'priority-ish:p1']),
        ghIssue(15, ['wo', 'P0', 'status:blocked']),
        ghIssue(16, ['wo', 'P0', 'status:review']),
        ghIssue(17, ['wo', 'P2', 'status:hold']),
        ghIssue(18, ['wo', 'P3', 'status:building']),
      ],
    });

    const threads = await defaultListThreads(fetchImpl);
    const byNumber = new Map(threads.map(thread => [Number(thread.ref.split('#')[1]), thread]));
    expect([10, 11, 12].map(number => byNumber.get(number)?.priority)).toEqual(['P1', 'P1', 'P1']);
    expect(byNumber.get(13)?.priority).toBe('P0');
    expect(byNumber.get(14)?.priority).toBe('P2');
    expect(byNumber.get(15)?.isBlocked).toBe(true);
    expect(byNumber.get(16)?.isUnclaimedP0).toBe(false);
    expect(byNumber.get(17)?.isBlocked).toBe(false);
    expect(byNumber.get(17)?.isHeld).toBe(true);
    expect(byNumber.get(18)?.isUnclaimed).toBe(false);
  });

  test('defaults to bdc-xo when TASKMASTER_GH_REPOS is unset', async () => {
    delete process.env.TASKMASTER_GH_REPOS;
    try {
      const { urls, fetchImpl } = fakeGithubFetch({});
      await defaultListThreads(fetchImpl);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every(url => url.includes('/repos/thinmansoftware/bdc-xo/issues'))).toBe(true);
    } finally {
      process.env.TASKMASTER_GH_REPOS = 'thinmansoftware/bdc-harness';
    }
  });

  test('pull requests are skipped', async () => {
    const { fetchImpl } = fakeGithubFetch({
      wo: [ghIssue(4, ['wo'], { pull_request: { url: 'x' } })],
      // 'arc' key absent -> empty list
    });
    const threads = await defaultListThreads(fetchImpl);
    expect(threads.length).toBe(0);
  });

  test('a non-OK work-SOR response makes the production adapter fail closed', async () => {
    const fetchImpl = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    await expect(defaultListThreads(fetchImpl)).rejects.toThrow(
      'taskmaster_github_work_sor_read_failed:503'
    );
  });

  test('a thrown work-SOR fetch makes the tick unsuccessful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const fetchImpl = (async () => {
      throw new Error('synthetic network failure');
    }) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, { listThreads: () => defaultListThreads(fetchImpl) })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });

  test('a non-OK evidence response makes the tick unsuccessful', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const key = 'tm:nudge:gh:thinmansoftware/bdc-xo#1452:1';
    world.journal.push({
      id: 'evidence-read-failure',
      created_at: new Date(T0 - 60_000).toISOString(),
      thread_ref: 'gh:thinmansoftware/bdc-xo#1452',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: key,
      before_hash: null,
      proof_predicate: 'post-send source progress',
      proof_deadline_at: new Date(T0 + 60_000).toISOString(),
      outcome: 'sent',
      graded_at: null,
      grade: null,
    });
    world.sentMessages.push({
      idempotency_key: key,
      recipient: 'xo',
      body: 'nudge',
      createdAt: new Date(T0 - 30_000).toISOString(),
    });
    const fetchImpl = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        getGithubIssueEvidence: (ref, sinceIso) =>
          defaultGetGithubIssueEvidence(ref, sinceIso, fetchImpl),
      })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
  });

  test('a thrown evidence fetch makes the production adapter fail closed', async () => {
    const fetchImpl = (async () => {
      throw new Error('synthetic evidence network failure');
    }) as typeof fetch;

    await expect(
      defaultGetGithubIssueEvidence(
        'gh:thinmansoftware/bdc-xo#1452',
        new Date(T0 - 30_000).toISOString(),
        fetchImpl
      )
    ).rejects.toThrow('synthetic evidence network failure');
  });

  test('low evidence quota stops later evidence calls and the successful heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    for (const issueNumber of [1453, 1454]) {
      const key = `tm:nudge:gh:thinmansoftware/bdc-xo#${issueNumber}:1`;
      world.journal.push({
        id: `low-quota-${issueNumber}`,
        created_at: new Date(T0 - 60_000).toISOString(),
        thread_ref: `gh:thinmansoftware/bdc-xo#${issueNumber}`,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: key,
        before_hash: null,
        proof_predicate: 'post-send source progress',
        proof_deadline_at: new Date(T0 + 60_000).toISOString(),
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
      world.sentMessages.push({
        idempotency_key: key,
        recipient: 'xo',
        body: 'nudge',
        createdAt: new Date(T0 - 30_000).toISOString(),
      });
    }
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({
            number: 1453,
            state: 'open',
            updated_at: new Date(T0).toISOString(),
            labels: [{ name: 'wo' }],
            assignees: [],
          }),
          { status: 200, headers: { 'x-ratelimit-remaining': '100' } }
        );
      }
      return new Response('[]', {
        status: 200,
        headers: { 'x-ratelimit-remaining': '4' },
      });
    }) as typeof fetch;
    const state = createTaskmasterState(60_000);

    const result = await tick(
      state,
      makeDeps(world, {
        getGithubIssueEvidence: (ref, sinceIso) =>
          defaultGetGithubIssueEvidence(ref, sinceIso, fetchImpl),
      })
    );

    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/issues/1453');
    expect(urls[1]).toContain('/issues/1453/comments');
    expect(urls.some(url => url.includes('/events'))).toBe(false);
    expect(urls.some(url => url.includes('/issues/1454'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adoption projection (WO-HARNESS-TASKMASTER-ADOPTION-PROJECTION-01)
// Section 11 scenarios -- every test name includes "adoption" or "canonicaliz"
// ---------------------------------------------------------------------------

function makeListedThread(overrides: Partial<ListedThread> & { ref: string }): ListedThread {
  return {
    priority: 'P1',
    lastActivityAt: new Date(T0).toISOString(),
    recipient: 'xo',
    title: 'untitled',
    ownerLogin: null,
    labels: ['wo', 'prio:P1'],
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<GithubIssueEvidence> = {}): GithubIssueEvidence {
  return {
    state: 'open',
    updatedAt: new Date(T0).toISOString(),
    labels: ['wo', 'prio:P1'],
    assigneeCount: 0,
    closedAt: null,
    assignedAt: null,
    activeStatusAt: null,
    progressRecordedAt: null,
    ownerLogin: null,
    latestMarkerKind: null,
    latestMarkerText: null,
    latestMarkerAt: null,
    lastMovementAt: null,
    lastMovementKind: null,
    ...overrides,
  };
}

describe('adoption projection', () => {
  test('adoption: captures charter-minimum state (title owner blocker movement)', async () => {
    const world = makeWorld();
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#100',
      title: 'Fix the thing',
      ownerLogin: 'major-build',
      priority: 'P1',
      labels: ['wo', 'prio:P1'],
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: 'major-build',
          latestMarkerKind: 'BLOCKED',
          latestMarkerText: '[BLOCKED] waiting on Stripe key rotation',
          latestMarkerAt: new Date(T0 - 3_600_000).toISOString(),
          assignedAt: new Date(T0 - 7_200_000).toISOString(),
          lastMovementAt: new Date(T0 - 7_200_000).toISOString(),
          lastMovementKind: 'assigned',
          assigneeCount: 1,
        }),
    });

    const result = await refreshAdoption([thread], deps);
    expect(result.failed).toBe(false);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.title).toBe('Fix the thing');
    expect(row.owner_login).toBe('major-build');
    expect(row.is_blocked).toBe(1);
    expect(row.blocked_reason).toContain('Stripe key rotation');
    expect(row.last_movement_kind).not.toBeNull();
    expect(row.evidence_observed_at).not.toBeNull();
  });

  test('adoption: UNKNOWN is preserved, never guessed for owner or next_action', async () => {
    const world = makeWorld();
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#101',
      title: 'No owner yet',
      ownerLogin: null,
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () =>
        makeEvidence({
          ownerLogin: null,
          latestMarkerKind: null,
          latestMarkerText: null,
        }),
    });
    await refreshAdoption([thread], deps);
    const row = (await deps.db!.getAdoption!())[0];
    expect(row.owner_login).toBeNull();
    expect(row.next_action).toBeNull();
    expect(row.owner_login).not.toBe('');
    expect(row.next_action).not.toBe('');
  });

  test('adoption: partial read never overwrites a good snapshot', async () => {
    const world = makeWorld();
    // Seed a committed snapshot with 3 rows.
    const seedId = 'snap-good';
    for (let i = 1; i <= 3; i++) {
      world.adoptionRows.push({
        thread_ref: `gh:thinmansoftware/bdc-xo#${i}`,
        snapshot_id: seedId,
        repo: 'thinmansoftware/bdc-xo',
        issue_number: i,
        title: `Seed ${i}`,
        priority: 'P2',
        labels_json: '[]',
        owner_login: null,
        is_blocked: 0,
        blocked_reason: null,
        next_action: null,
        latest_marker_kind: null,
        latest_marker_at: null,
        state: 'open',
        last_movement_at: null,
        last_movement_kind: null,
        attempts_24h: 0,
        attempts_total: 0,
        evidence_observed_at: new Date(T0).toISOString(),
        source_updated_at: new Date(T0).toISOString(),
      });
    }
    world.adoptionMeta = {
      committed_snapshot_id: seedId,
      rebuilt_at: new Date(T0).toISOString(),
      row_count: 3,
      source_commit: null,
      complete: 1,
    };

    let evidenceCalls = 0;
    const threads = [1, 2, 3].map(i =>
      makeListedThread({ ref: `gh:thinmansoftware/bdc-xo#${i}`, title: `T${i}` })
    );
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => {
        evidenceCalls += 1;
        if (evidenceCalls === 1) {
          return makeEvidence({ ownerLogin: 'ok' });
        }
        // Simulate assertGithubRateLimit throw after first success.
        const err = new Error('taskmaster_github_rate_limit_backoff:4');
        err.name = 'GithubRateLimitBackoffError';
        throw err;
      },
    });

    const result = await refreshAdoption(threads, deps);
    expect(result.failed).toBe(true);
    expect(result.error).not.toBeNull();
    expect(world.adoptionMeta.committed_snapshot_id).toBe(seedId);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.snapshot_id === seedId)).toBe(true);
    // No rows remain under the abandoned (non-seed) snapshot.
    const abandoned = world.adoptionRows.filter(r => r.snapshot_id !== seedId);
    expect(abandoned).toHaveLength(0);
  });

  test('adoption: failed refresh suppresses tick heartbeat', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    let evidenceCalls = 0;
    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#200',
      // Make it healthy so send path has nothing to do besides digest (already seeded).
      lastActivityAt: new Date(T0).toISOString(),
      isBlocked: false,
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () => {
        evidenceCalls += 1;
        throw new Error('taskmaster_github_rate_limit_backoff:4');
      },
    });
    const state = createTaskmasterState(60_000);
    const result = await tick(state, deps);
    expect(result.successful).toBe(false);
    expect(state.deadman.lastTickAtMs).toBeNull();
    // grade/send phase still executed: digest was already seeded so no new send,
    // but tick completed (ran=true) rather than aborting mid-flow.
    expect(result.ran).toBe(true);
    expect(evidenceCalls).toBeGreaterThanOrEqual(1);
  });

  test('adoption: canonicalizeThreadRef spans org AND repo', async () => {
    expect(canonicalizeThreadRef('gh:bluedevilcollectibles/bdc-xo#1366')).toBe(
      'gh:thinmansoftware/bdc-xo#1366'
    );
    expect(canonicalizeThreadRef('gh:bluedevilcollectibles/bdc-harness#209')).toBe(
      'gh:thinmansoftware/bdc-harness#209'
    );
    expect(canonicalizeThreadRef('digest:2026-08-17')).toBe('digest:2026-08-17');
  });

  test('adoption: attempt counts span org eras via canonicalization', async () => {
    const world = makeWorld();
    const nowIso = new Date(T0).toISOString();
    const within24h = new Date(T0 - 3_600_000).toISOString();
    const older = new Date(T0 - 48 * 3_600_000).toISOString();
    // 3 sent on old org (1 within 24h), 2 sent on new org (both within 24h)
    const seed = (ref: string, created_at: string, id: string): void => {
      world.journal.push({
        id,
        created_at,
        thread_ref: ref,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: `tm:nudge:${ref}:${id}`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: null,
        grade: null,
      });
    };
    seed('gh:bluedevilcollectibles/bdc-xo#1366', older, 'old-1');
    seed('gh:bluedevilcollectibles/bdc-xo#1366', older, 'old-2');
    seed('gh:bluedevilcollectibles/bdc-xo#1366', within24h, 'old-3');
    seed('gh:thinmansoftware/bdc-xo#1366', within24h, 'new-1');
    seed('gh:thinmansoftware/bdc-xo#1366', within24h, 'new-2');

    const thread = makeListedThread({
      ref: 'gh:thinmansoftware/bdc-xo#1366',
      title: 'Cross-era',
    });
    const deps = makeDeps(world, {
      getGithubIssueEvidence: async () => makeEvidence({ ownerLogin: 'xo' }),
    });
    await refreshAdoption([thread], deps);
    const rows = await deps.db!.getAdoption!();
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_ref).toBe('gh:thinmansoftware/bdc-xo#1366');
    expect(rows[0].attempts_total).toBe(5);
    expect(rows[0].attempts_24h).toBe(3);
  });

  test('adoption: evidence budget bounds requests per tick at default 10', async () => {
    const world = makeWorld();
    const prior = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    try {
      const threads = Array.from({ length: 100 }, (_, i) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-xo#${1000 + i}`,
          title: `Issue ${i}`,
        })
      );
      let evidenceCalls = 0;
      const deps = makeDeps(world, {
        getGithubIssueEvidence: async () => {
          evidenceCalls += 1;
          return makeEvidence();
        },
      });
      await refreshAdoption(threads, deps);
      expect(evidenceCalls).toBeLessThanOrEqual(10);
      const rows = await deps.db!.getAdoption!();
      expect(rows).toHaveLength(100);
      const unknown = rows.filter(r => r.evidence_observed_at === null);
      expect(unknown.length).toBeGreaterThanOrEqual(90);
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = prior;
    }
  });

  test('adoption: budget is env-overridable and enriches oldest first', async () => {
    const world = makeWorld();
    const prior = process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
    process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = '3';
    try {
      // Seed prior committed snapshot for all 100 threads with deterministic ages.
      // Index 0 = NULL (oldest/unknown), then increasing timestamps so
      // indices 1 and 2 are the next two oldest non-null.
      const seedId = 'snap-prior';
      for (let i = 0; i < 100; i++) {
        const evidenceAt = i === 0 ? null : new Date(T0 - (100 - i) * 1_000).toISOString();
        world.adoptionRows.push({
          thread_ref: `gh:thinmansoftware/bdc-xo#${2000 + i}`,
          snapshot_id: seedId,
          repo: 'thinmansoftware/bdc-xo',
          issue_number: 2000 + i,
          title: `Prior ${i}`,
          priority: 'P2',
          labels_json: '[]',
          owner_login: null,
          is_blocked: 0,
          blocked_reason: null,
          next_action: null,
          latest_marker_kind: null,
          latest_marker_at: null,
          state: 'open',
          last_movement_at: null,
          last_movement_kind: null,
          attempts_24h: 0,
          attempts_total: 0,
          evidence_observed_at: evidenceAt,
          source_updated_at: new Date(T0).toISOString(),
        });
      }
      world.adoptionMeta = {
        committed_snapshot_id: seedId,
        rebuilt_at: new Date(T0).toISOString(),
        row_count: 100,
        source_commit: null,
        complete: 1,
      };

      const threads = Array.from({ length: 100 }, (_, i) =>
        makeListedThread({
          ref: `gh:thinmansoftware/bdc-xo#${2000 + i}`,
          title: `Issue ${i}`,
        })
      );

      const enrichedRefs: string[] = [];
      const deps = makeDeps(world, {
        getGithubIssueEvidence: async ref => {
          enrichedRefs.push(ref);
          return makeEvidence();
        },
      });
      await refreshAdoption(threads, deps);
      expect(enrichedRefs.length).toBeLessThanOrEqual(3);
      // Oldest-first: NULL (2000), then 2001 (oldest non-null), then 2002.
      expect(enrichedRefs[0]).toBe('gh:thinmansoftware/bdc-xo#2000');
      expect(enrichedRefs[1]).toBe('gh:thinmansoftware/bdc-xo#2001');
      expect(enrichedRefs[2]).toBe('gh:thinmansoftware/bdc-xo#2002');
    } finally {
      if (prior === undefined) delete process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET;
      else process.env.TASKMASTER_ADOPTION_EVIDENCE_BUDGET = prior;
    }
  });

  test('adoption: send path untouched regression guard', async () => {
    // Re-run a classic send scenario to prove the adoption insert did not
    // change send/grade behavior. Existing suite scenarios remain unmodified.
    const world = makeWorld();
    seedDigestSent(world);
    const deps = makeDeps(world, {
      listUndeliveredRulings: async () => [
        {
          ref: 'dispatch:ruling-42',
          priority: 'P1',
          lastActivityAt: new Date(T0 - 3_600_000).toISOString(),
          undeliveredRulingId: 'ruling-42',
          recipient: 'xo',
        },
      ],
      listThreads: async () => [],
    });
    const state = createTaskmasterState(60_000);
    const first = await tick(state, deps);
    expect(first.effects).toBe(1);
    const second = await tick(state, deps);
    // Second tick: two-tick confirm already satisfied on first for actsImmediately.
    // deliver_ruling is actsImmediately; second tick should not double-send.
    const deliverRows = world.journal.filter(j => j.action_type === 'deliver_ruling');
    expect(deliverRows.length).toBe(1);
    expect(
      world.sentMessages.filter(m => m.idempotency_key.includes('deliver_ruling')).length
    ).toBe(1);
    expect(second.effects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M-155 WO 3 (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01) -- exception push:
// recipient routing stub, noise-suppression wiring, dispatch metadata,
// safety-spine regression. Every test name carries the literal 'push:'.
// ---------------------------------------------------------------------------

describe('M-155 exception push (loop)', () => {
  /** Content-complete evidence: PROGRESS marker becomes next_action in adoption. */
  function contentEvidence(markerText: string, movedAtMs: number): GithubIssueEvidence {
    return makeEvidence({
      ownerLogin: 'major-build',
      latestMarkerKind: 'PROGRESS',
      latestMarkerText: markerText,
      latestMarkerAt: new Date(movedAtMs).toISOString(),
      lastMovementAt: new Date(movedAtMs).toISOString(),
      lastMovementKind: 'progress_comment',
      progressRecordedAt: null,
    });
  }

  function suppressionDb(
    world: FakeWorld,
    store: Map<string, TmSuppressionRow>
  ): TaskmasterDeps['db'] {
    const base = makeDeps(world).db;
    return {
      ...base,
      getSuppression: async (): Promise<Map<string, TmSuppressionRow>> => new Map(store),
      setSuppression: async (threadRef: string, hash: string): Promise<void> => {
        store.set(threadRef, {
          thread_ref: threadRef,
          suppressed_until_hash: hash,
          suppressed_at: new Date(world.nowMs).toISOString(),
          noise_grade_count: 2,
        });
      },
      clearSuppression: async (threadRef: string): Promise<void> => {
        store.delete(threadRef);
      },
    } as TaskmasterDeps['db'];
  }

  test('push: every owner resolves to xo in THIS WO (routing stub validation)', () => {
    // Only 'xo' (XO session-start reflex) and 'operator' (John) have a
    // documented drainer; routing to any other mailbox would manufacture a
    // second dead-letter box -- the failure this WO exists to end.
    for (const owner of ['major-build', 'captain-ci', 'unmapped-login', null]) {
      const resolved = resolveRecipient(owner);
      expect(resolved).toBe('xo');
      expect(TM_ALLOWED_RECIPIENTS).toContain(resolved);
    }
    // The map structure exists and every entry points at 'xo', so widening it
    // later is a data change rather than a code change.
    expect(Object.keys(OWNER_RECIPIENT_MAP).length).toBeGreaterThan(0);
    for (const target of Object.values(OWNER_RECIPIENT_MAP)) {
      expect(target).toBe('xo');
    }
  });

  test('push: content_incomplete is an ordinary reject, never a HARD_PAUSE', async () => {
    // Guard half: a proposal flagged content-incomplete (or with a null body)
    // is rejected with the ORDINARY content_incomplete reason -- forbiddenEffect
    // stays falsy, so the auto-circuit cannot trip.
    const base: ActionProposal = {
      type: 'nudge',
      threadRef: 'gh:thinmansoftware/bdc-xo#930',
      recipient: 'xo',
      body: 'placeholder',
      idempotencyKey: 'tm:nudge:gh:thinmansoftware/bdc-xo#930:1',
      actsImmediately: false,
    };
    const flagged = validateProposal({ ...base, contentIncomplete: true });
    expect(flagged.allowed).toBe(false);
    expect(flagged.reason).toContain('content_incomplete');
    expect(flagged.forbiddenEffect).toBeFalsy();
    const nullBody = validateProposal({ ...base, body: null as unknown as string });
    expect(nullBody.allowed).toBe(false);
    expect(nullBody.reason).toContain('content_incomplete');
    expect(nullBody.forbiddenEffect).toBeFalsy();

    // Loop half: an ordinary (non-forbiddenEffect) guard rejection flowing
    // through a real tick is journaled 'rejected' and leaves tm_control
    // untouched -- no auto-circuit, no HARD_PAUSE.
    const world = makeWorld();
    seedDigestSent(world);
    const ref = 'gh:thinmansoftware/bdc-xo#931';
    const thread = makeListedThread({
      ref,
      title: 'Content-rejected item',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      // The composed next action carries a forbidden verb, so the guard
      // rejects the content (ordinary reject path, same as content_incomplete).
      getGithubIssueEvidence: async () =>
        contentEvidence('[PROGRESS] deploy to production now', T0 - 3 * 3_600_000),
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps); // observation tick
    world.nowMs += 60_000;
    const result = await tick(state, deps); // confirming tick -> guard reject

    expect(result.rejected).toBe(1);
    const rejected = world.journal.filter(j => j.thread_ref === ref && j.outcome === 'rejected');
    expect(rejected.length).toBe(1);
    expect(rejected[0]?.proposal_json).toContain('spend_send_deploy_verb_rejected');
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'))).toHaveLength(
      0
    );
    // The pause matrix is untouched: still RUNNING, no auto-circuit actor.
    expect(world.control.pause_state).toBe('RUNNING');
    expect(world.control.pause_actor).toBeNull();
  });

  test('push: subject_key + repeat_reason satisfy the dispatch contract (loop side)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    // Old-org ref proves the subject_key is CANONICALIZED before dispatch.
    const rawRef = 'gh:bluedevilcollectibles/bdc-xo#911';
    const canonRef = canonicalizeThreadRef(rawRef);
    const thread = makeListedThread({
      ref: rawRef,
      title: 'Cross-era subject',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    const captured: Array<Record<string, unknown>> = [];
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () =>
        contentEvidence('[PROGRESS] waiting on review feedback', T0 - 3 * 3_600_000),
      createTask: (async (_context: unknown, data: Record<string, unknown>) => {
        captured.push(data);
        world.sentMessages.push({
          idempotency_key: String(data.idempotency_key),
          recipient: String(data.recipient),
          body: String(data.body),
          createdAt: new Date(world.nowMs).toISOString(),
        });
        return { id: `msg-${captured.length}`, status: 'queued' };
      }) as unknown as TaskmasterDeps['createTask'],
    });
    const state = createTaskmasterState(60_000);
    await tick(state, deps); // observation
    world.nowMs += 60_000;
    await tick(state, deps); // confirm + send

    const nudgeCall = captured.find(c => String(c.idempotency_key).startsWith('tm:nudge:'));
    expect(nudgeCall).toBeDefined();
    // Loop supplies subject_key (canonical) + the per-verb repeat_reason
    // literal UNCONDITIONALLY, so the migration-042 repeat_reason_required
    // throw can never fire on the real send path (DB-level throw behavior is
    // proven in packages/core/src/db/taskmaster.test.ts push: coverage).
    expect(nudgeCall?.subject_key).toBe(canonRef);
    expect(nudgeCall?.repeat_reason).toBe('tm:nudge:follow-up');
    expect(TM_REPEAT_REASON_BY_TYPE.escalate_p0).toBe('tm:escalate_p0:repeated');
    expect(TM_REPEAT_REASON_BY_TYPE.deliver_ruling).toBe('tm:deliver_ruling:repeated');
    expect(String(nudgeCall?.body)).toContain('Cross-era subject');
  });

  test('push: two consecutive noise grades suppress until content changes (loop wiring)', async () => {
    const world = makeWorld();
    seedDigestSent(world);
    const ref = 'gh:thinmansoftware/bdc-xo#910';
    // Two prior sends, both GRADED noise (created within 24h; budget 3 not hit).
    for (const [idx, gradedAt] of [T0 - 2 * 3_600_000, T0 - 3_600_000].entries()) {
      world.journal.push({
        id: `noise-${idx}`,
        created_at: new Date(T0 - 12 * 3_600_000).toISOString(),
        thread_ref: ref,
        action_type: 'nudge',
        proposal_json: '{}',
        idempotency_key: `tm:nudge:${ref}:old${idx}`,
        before_hash: null,
        proof_predicate: null,
        proof_deadline_at: null,
        outcome: 'sent',
        graded_at: new Date(gradedAt).toISOString(),
        grade: 'noise',
      });
    }
    const thread = makeListedThread({
      ref,
      title: 'Chronic but titled',
      lastActivityAt: new Date(T0 - 6 * 3_600_000).toISOString(),
    });
    // Movement OLDER than the later noise grade: content unchanged since.
    let evidence = contentEvidence('[PROGRESS] waiting on review', T0 - 3 * 24 * 3_600_000);
    const suppStore = new Map<string, TmSuppressionRow>();
    const deps = makeDeps(world, {
      listThreads: async () => [thread],
      getGithubIssueEvidence: async () => evidence,
    });
    deps.db = suppressionDb(world, suppStore);
    const state = createTaskmasterState(60_000);

    await tick(state, deps);
    world.nowMs += 60_000;
    await tick(state, deps);

    // A durable tm_suppression row was written and no nudge left the process.
    expect(suppStore.has(ref)).toBe(true);
    expect(world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'))).toHaveLength(
      0
    );

    // The work moves: next_action + last_movement_at change -> hash differs ->
    // suppression lifts (row deleted) and the nudge sends after re-confirm.
    evidence = contentEvidence('[PROGRESS] waiting on John decision', T0 - 30 * 60_000);
    world.nowMs += 60_000;
    await tick(state, deps); // lift + observation
    expect(suppStore.has(ref)).toBe(false);
    world.nowMs += 60_000;
    await tick(state, deps); // confirm + send

    const nudges = world.sentMessages.filter(m => m.idempotency_key.startsWith('tm:nudge:'));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.body).toContain('waiting on John decision');
    expect(nudges[0]?.body).toContain('Chronic but titled');
  });

  test('push: the five-verb allowlist and the budgets are explicit (regression)', () => {
    expect(MAX_INTERVENTIONS_PER_ITEM_24H).toBe(3);
    expect(MAX_EFFECTS_PER_TICK).toBe(10);
    expect([...TM_ALLOWED_ACTION_TYPES]).toEqual([
      'deliver_ruling',
      'nudge',
      'escalate_p0',
      'digest',
      'fire_cauldron',
    ]);
    expect([...TM_ALLOWED_RECIPIENTS]).toEqual(['xo', 'major-build', 'captain-ci', 'operator']);
  });

  test('fire verb environment defaults OFF without a calendar budget', () => {
    expect(resolveFireVerbEnabled(undefined)).toBe(false);
    expect(resolveFireVerbEnabled('true')).toBe(true);
  });

  test('push: the loop never resumes itself -- no setPauseState RUNNING write', () => {
    // Source assertion: every setPauseState call site in the taskmaster server
    // source writes a pause, never 'RUNNING'. Un-pause is an operator action
    // at M-155 gate G11, never a code path. Reads/comparisons of 'RUNNING'
    // are legitimate and remain.
    for (const file of ['loop.ts', 'rules.ts', 'guard.ts']) {
      const source = readFileSync(join(import.meta.dir, file), 'utf8');
      const callSites = source.split('setPauseState(').slice(1);
      for (const site of callSites) {
        expect(site.slice(0, 300)).not.toContain("'RUNNING'");
      }
      expect(/pause_state:\s*'RUNNING'/.test(source)).toBe(false);
    }
  });
});
