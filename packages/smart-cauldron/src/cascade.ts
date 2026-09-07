/**
 * cascade.ts -- Smart Cauldron v1.0 per-run escalation cascade orchestrator.
 *
 * Algorithm:
 *   1. Load ladder + ruleset from config (never hardcoded).
 *   2. Conductor picks entry tier (ruleset table, no model call).
 *   3. Fire WO on entry lane; wait for terminal state; judge via 4-condition gate.
 *   4. PASS -> record win, stop.
 *      FAIL -> build informed-climb context; escalate to next tier.
 *   5. Repeat until frontier (BLOCKED + alert) or a tier wins.
 *   6. Write cascade-runs/ JSON record with per-tier outcome + cost + telemetry.
 *
 * v1.0 is a WRAPPER around existing fire mechanics. It does NOT touch the DAG
 * node executor (@archon/workflows) -- that is explicitly deferred to v1.2.
 *
 * Secret boundary: apiBaseUrl comes from env (ARCHON_API_BASE_URL) or caller.
 * No hardcoded model names or workflow names in this file -- all in config.
 */

import { randomUUID } from 'crypto';
import type { ExpectedSpecIdentity } from '@archon/core/workflows/work-order-source';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadLadder, loadRefusedTiers, loadPremiumTiers } from './ladder.js';
import { loadRuleset, pickEntryTier } from './conductor.js';
import { fireTier, buildFireMessage } from './fire.js';
import { pollForTerminal, TimeoutError } from './poll.js';
import { judgeGate, classifyAttemptOutcome } from './judge.js';
import { createRecord, writeRecord } from './recorder.js';
import type { CreateCascadeRecordResult } from './recorder.js';
import { cancelRun } from './cancel.js';
import { findWoClaim, type WoClaim } from './already-satisfied.js';
import { acquireWoLock, releaseWoLock } from './wo-lock.js';
import { classifyError, type ErrorClass } from '@archon/overseer/classify';
import { runAuthorizedEscalation } from '@archon/overseer/authorized-escalation';
import { runEscalation } from '@archon/overseer';
import type { M31ActionPermit } from '@archon/overseer/m31-substrate';
import type {
  CascadeRunRecord,
  CascadeAttempt,
  CascadeStatus,
  ConductorRuleset,
  TierName,
  LadderTier,
  GateVerdict,
  FireResult,
  PollResult,
} from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dependency injection interface (for testability)
// ---------------------------------------------------------------------------

export interface CascadeDeps {
  /** Verify that the selected workflow lane is available before any provider fire. */
  preflight?: (tier: LadderTier) => Promise<void>;
  fire?: typeof fireTier;
  poll?: typeof pollForTerminal;
  judge?: typeof judgeGate;
  escalate?: (context: EscalationCallContext) => Promise<void>;
  writeRecord?: typeof writeRecord;
  /** Exclusive admission writer used to make dispatch idempotent across processes. */
  createRecord?: typeof createRecord;
  /** Best-effort cancel of a hung run on progress-timeout. Failure never blocks the climb. */
  cancel?: typeof cancelRun;
  /**
   * SPEC-REPAIR escalation for a frontier (fable) tier gate-fail. Posts the
   * failure evidence + "what must change in the spec" to the WO's GitHub issue
   * (comment + status:blocked label). Injectable for tests. Failure to resolve
   * an issue is surfaced via `posted: false` (caller falls back to escalate).
   */
  specRepair?: (context: SpecRepairCallContext) => Promise<SpecRepairResult>;
  /** Optional dual-supervisor control plane. Absent by default; never starts a live worker. */
  superviseFailure?: (context: SupervisorFailureContext) => Promise<SupervisorFailureResult>;
  /**
   * Already-satisfied / claim check (bdc-xo#1546, M-123 Q5). Returns an open or
   * merged PR that already owns this WO, or null when none / unknown.
   */
  findWoClaim?: (woId: string, project: string) => Promise<WoClaim | null>;
  /** Exclusive active-cascade lock per woId+project. */
  acquireWoLock?: typeof acquireWoLock;
  releaseWoLock?: typeof releaseWoLock;
  /**
   * Conductor ruleset override (skips loadRuleset() config read). Used to
   * exercise entry-tier selection deterministically -- e.g. a ruleset that
   * resolves directly onto a premium tier so the frontier-approval gate is
   * reached with zero prior attempts (no entryOverride). Ignored when
   * entryOverride is set (that already skips the conductor).
   */
  ruleset?: ConductorRuleset;
}

export interface SupervisorFailureContext {
  woId: string;
  cascadeId: string;
  tierName: TierName;
  runId: string | null;
  reason: string;
  failureKind: 'frontier-gate' | 'infrastructure';
}

export interface SupervisorFailureResult {
  handled: boolean;
  ownerId: string | null;
  fencingToken: number | null;
  evidenceRefs: string[];
}

export interface EscalationCallContext {
  errorClass: ErrorClass;
  woId: string;
  reason: string;
  remediation?: string[];
  runId?: string | null;
  overseerPermit?: M31ActionPermit;
  sourceEventId: string;
  sourceEventCreatedAt: string;
  repository: string;
}

export interface SpecRepairCallContext {
  woId: string;
  tierName: TierName;
  failReason: string;
  runId: string | null;
  /** Full, human-readable failure evidence (gate reasons, verdict, run id). */
  evidence: string;
  /** Concrete "what must change in the spec" statement -- the fix-loop handoff. */
  whatMustChange: string;
}

export interface SpecRepairResult {
  /** true when the WO's GitHub issue received the comment + status:blocked label. */
  posted: boolean;
  issueRepo: string | null;
  issueNumber: number | null;
}

// ---------------------------------------------------------------------------
// Main cascade options
// ---------------------------------------------------------------------------

export interface RunCascadeOptions {
  woId: string;
  /** Constrain each lane's canonical spec to the identity checked before dispatch. */
  expectedSpec?: ExpectedSpecIdentity;
  /** Stable caller-supplied dispatch identity. Replays return the existing durable record. */
  dispatchId?: string;
  /** Resolves only after the initial record is durable; used by async API dispatch. */
  onAdmission?: (record: CascadeRunRecord, created: boolean) => void;
  woClass?: string;
  tags?: string[];
  /** Override the entry tier (skips conductor ruleset). */
  entryOverride?: TierName;
  /**
   * Seed the informed-climb context of the FIRST attempt. Used only when
   * resuming an approved frontier-approval pause (WO-HARNESS-FRONTIER-CLIMB-
   * APPROVAL-GATE-01): the preserved packet's priorContext is replayed in so the
   * resumed premium fire still carries the informed-climb text it would have had.
   * Default null (normal fires build priorContext as they climb).
   */
  initialPriorContext?: string | null;
  /** Archon API base URL. Defaults to ARCHON_API_BASE_URL env or http://localhost:3090. */
  apiBaseUrl?: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env in callees. */
  token?: string;
  /** Codebase shortname for explicit workflow binding. Required for live fires. */
  project?: string;
  /** Output directory for cascade-runs/ records. Default: ./cascade-runs. */
  outDir?: string;
  /** Dry-run: print which tier would be picked, do not fire. */
  dryRun?: boolean;
  /** M-31 permit required before default escalation side effects can run. */
  overseerPermit?: M31ActionPermit;
  /** Dependency injection (for testing). */
  deps?: CascadeDeps;
  /**
   * Hard ceiling per attempt in ms. Default: 14400000 (4 hours). Runaway backstop
   * only -- the normal stop condition is `pollStallTimeoutMs`.
   */
  pollTimeoutMs?: number;
  /**
   * Stall budget per attempt in ms -- how long a run may emit NOTHING before it
   * is judged stuck and the cascade climbs. Default: 1200000 (20 minutes).
   */
  pollStallTimeoutMs?: number;
  /** Poll interval per attempt in ms. Default: 30000 (30 seconds). */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Cascade orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the Smart Cauldron per-run escalation cascade.
 *
 * Fires the WO on the cheapest appropriate tier first; climbs on gate-fail.
 * Writes a cascade-runs/ JSON record and returns the complete CascadeRunRecord.
 */
export async function runCascade(opts: RunCascadeOptions): Promise<CascadeRunRecord> {
  const {
    woId,
    dispatchId,
    onAdmission,
    woClass,
    tags,
    entryOverride,
    dryRun = false,
    outDir = './cascade-runs',
    pollTimeoutMs = 14_400_000,
    pollStallTimeoutMs = 1_200_000,
    pollIntervalMs = 30_000,
    token,
    project,
  } = opts;

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.ARCHON_API_BASE_URL ?? 'http://localhost:3090';

  // Inject real implementations unless overridden (for testing)
  const fireImpl = opts.deps?.fire ?? fireTier;
  const preflightImpl = opts.deps?.preflight;
  const pollImpl = opts.deps?.poll ?? pollForTerminal;
  const judgeImpl = opts.deps?.judge ?? judgeGate;
  const escalateImpl = opts.deps?.escalate ?? defaultEscalate;
  const writeRecordImpl = opts.deps?.writeRecord ?? writeRecord;
  const createRecordImpl =
    opts.deps?.createRecord ??
    (opts.deps?.writeRecord
      ? async (
          record: CascadeRunRecord,
          recordOutDir: string
        ): Promise<CreateCascadeRecordResult> => ({
          created: true,
          path: await writeRecordImpl(record, recordOutDir),
          record,
        })
      : createRecord);
  const cancelImpl = opts.deps?.cancel ?? cancelRun;
  const specRepairImpl = opts.deps?.specRepair ?? defaultSpecRepair;
  const superviseFailureImpl = opts.deps?.superviseFailure;
  const findWoClaimImpl =
    opts.deps?.findWoClaim ??
    ((id: string, proj: string): Promise<WoClaim | null> =>
      findWoClaim({ woId: id, project: proj }));
  const acquireWoLockImpl = opts.deps?.acquireWoLock ?? acquireWoLock;
  const releaseWoLockImpl = opts.deps?.releaseWoLock ?? releaseWoLock;
  const allowClaimed =
    process.env.SMART_CAULDRON_ALLOW_CLAIMED === '1' ||
    process.env.SMART_CAULDRON_ALLOW_CLAIMED === 'true';

  // Load config from files (never from inline constants)
  const tiers = loadLadder();
  const ruleset = opts.deps?.ruleset ?? loadRuleset();
  const refusedTiers = loadRefusedTiers();
  const premiumTiers = loadPremiumTiers();

  // Conductor: pick entry tier (ruleset), or honor explicit --entry override
  let entryTierName = entryOverride ?? pickEntryTier({ woClass, tags }, ruleset);

  // Dark/retired lanes are never live entry points. An explicit --entry onto a
  // refused tier is an operator error and throws; a RULESET pick that lands on a
  // refused tier promotes up the ladder to the first non-refused tier (the entry
  // floor -- John 2026-08-25: OpenRouter rungs defunded, codex is the floor).
  if (refusedTiers.includes(entryTierName)) {
    if (entryOverride) {
      throw new Error(
        `[smart-cauldron/cascade] Refused dark/retired entry tier "${entryTierName}". ` +
          'This lane is listed in refusedTiers and cannot be selected as a live entry point. ' +
          `Canonical ladder: ${tiers.map(t => t.name).join(' -> ')}. ` +
          `Refused: ${refusedTiers.join(', ')}`
      );
    }
    const pickedIndex = tiers.findIndex(t => t.name === entryTierName);
    const promoted = tiers
      .slice(pickedIndex === -1 ? 0 : pickedIndex)
      .find(t => !refusedTiers.includes(t.name));
    if (!promoted) {
      throw new Error(
        `[smart-cauldron/cascade] Ruleset picked refused tier "${entryTierName}" and no ` +
          `non-refused tier exists above it. Refused: ${refusedTiers.join(', ')}`
      );
    }
    console.log(
      `[smart-cauldron] Entry tier "${entryTierName}" is refused; promoting entry to ` +
        `"${promoted.name}" (entry floor)`
    );
    entryTierName = promoted.name;
  }

  let currentIndex = tiers.findIndex(t => t.name === entryTierName);
  if (currentIndex === -1) {
    throw new Error(
      `[smart-cauldron/cascade] Entry tier "${entryTierName}" not found in ladder. ` +
        `Available tiers: ${tiers.map(t => t.name).join(', ')}`
    );
  }

  const cascadeId = dispatchId ?? randomUUID();
  const createdAt = new Date().toISOString();

  // Dry-run: just log and return a stub record
  if (dryRun) {
    const selectedTier = tiers[currentIndex];
    if (selectedTier) {
      console.log(
        `[smart-cauldron] DRY RUN: woId=${woId} entry=${selectedTier.name} ` +
          `workflow=${selectedTier.workflowName}`
      );
    }
    const record: CascadeRunRecord = {
      cascadeId,
      woId,
      project: project ?? null,
      request: {
        woClass: woClass ?? null,
        tags: [...(tags ?? [])].sort(),
        entryOverride: entryOverride ?? null,
        dryRun: true,
      },
      createdAt,
      status: 'planned',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: entryTierName,
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
    };
    const admission = await createRecordImpl(record, outDir);
    onAdmission?.(admission.record, admission.created);
    return admission.record;
  }

  if (!project) {
    throw new Error(
      '[smart-cauldron/cascade] --project is required for cascade fires (explicit codebase binding; no silent fallback allowed).'
    );
  }

  // WO-level exclusive lock (bdc-xo#1546): cascadeId admission alone does not
  // stop two different cascades from racing the same WO.
  const woLock = await acquireWoLockImpl(woId, project, cascadeId, outDir);
  if (!woLock.acquired) {
    console.log(
      `[smart-cauldron] REFUSING duplicate cascade for woId=${woId} project=${project}: ` +
        `active cascadeId=${woLock.record.cascadeId}`
    );
    const blocked: CascadeRunRecord = {
      cascadeId,
      woId,
      project,
      request: {
        woClass: woClass ?? null,
        tags: [...(tags ?? [])].sort(),
        entryOverride: entryOverride ?? null,
        dryRun: false,
      },
      createdAt,
      status: 'blocked',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: entryTierName,
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
    };
    onAdmission?.(blocked, false);
    return blocked;
  }

  // Already-satisfied / claim check before any provider spend (M-123 Q5 / #1546).
  if (!allowClaimed) {
    const existingClaim = await findWoClaimImpl(woId, project);
    if (existingClaim) {
      console.log(
        `[smart-cauldron] ALREADY SATISFIED woId=${woId}: PR #${existingClaim.number} ` +
          `[${existingClaim.state}] ${existingClaim.url} -- skipping cascade`
      );
      const won: CascadeRunRecord = {
        cascadeId,
        woId,
        project,
        request: {
          woClass: woClass ?? null,
          tags: [...(tags ?? [])].sort(),
          entryOverride: entryOverride ?? null,
          dryRun: false,
        },
        createdAt,
        status: 'won',
        winningTier: entryTierName,
        attempts: [],
        totalCostUsd: null,
        telemetry: {
          entryTier: entryTierName,
          climbed: false,
          climbCount: 0,
          wonCheap: true,
        },
      };
      const admissionEarly = await createRecordImpl(won, outDir);
      onAdmission?.(admissionEarly.record, admissionEarly.created);
      await releaseWoLockImpl(woId, project, cascadeId, outDir);
      return admissionEarly.record;
    }
  }

  // Cascade loop
  const attempts: CascadeAttempt[] = [];
  try {
    const emitEscalation = async (
      context: Omit<EscalationCallContext, 'sourceEventId' | 'sourceEventCreatedAt' | 'repository'>
    ): Promise<void> => {
      // The last recorded attempt is the natural source event for an escalation.
      // The frontier-approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01)
      // can pause with zero prior attempts when the conductor resolves entry
      // directly onto a premium tier; synthesize a stable source event from the
      // cascade identity rather than dropping the operator notice.
      const sourceAttempt = attempts.at(-1);
      await escalateImpl({
        ...context,
        sourceEventId: sourceAttempt?.sourceEventId ?? `${cascadeId}:frontier-gate`,
        sourceEventCreatedAt: sourceAttempt?.sourceEventAt ?? createdAt,
        repository: project ?? 'thinmansoftware/bdc-harness',
      });
    };
    // Normally null; seeded on an approved frontier-approval resume so the
    // premium fire carries the informed-climb text preserved in the packet.
    let priorContext: string | null = opts.initialPriorContext ?? null;
    let climbCount = 0;
    let status: CascadeStatus = 'running';
    let winningTier: TierName | null = null;
    let specRepairRecord: CascadeRunRecord['specRepair'];
    let supervisorRecoveryRecord: CascadeRunRecord['supervisorRecovery'];
    let frontierApprovalRecord: CascadeRunRecord['frontierApproval'];

    function buildCurrentRecord(): CascadeRunRecord {
      const entryTier: TierName = attempts[0]?.tier ?? entryTierName;
      const climbed = climbCount > 0;
      return {
        cascadeId,
        woId,
        project: project ?? null,
        request: {
          woClass: woClass ?? null,
          tags: [...(tags ?? [])].sort(),
          entryOverride: entryOverride ?? null,
          dryRun: false,
        },
        createdAt,
        status,
        winningTier,
        attempts,
        totalCostUsd: computeTotalCost(attempts),
        telemetry: {
          entryTier,
          climbed,
          climbCount,
          wonCheap: status === 'won' && !climbed,
        },
        ...(specRepairRecord ? { specRepair: specRepairRecord } : {}),
        ...(supervisorRecoveryRecord ? { supervisorRecovery: supervisorRecoveryRecord } : {}),
        ...(frontierApprovalRecord ? { frontierApproval: frontierApprovalRecord } : {}),
      };
    }

    async function checkpoint(): Promise<string> {
      return writeRecordImpl(buildCurrentRecord(), outDir);
    }

    // Persist admission before any provider lane can be fired. A duplicate dispatch
    // returns the existing record and cannot create a second provider attempt.
    const admission = await createRecordImpl(buildCurrentRecord(), outDir);
    onAdmission?.(admission.record, admission.created);
    if (!admission.created) return admission.record;

    /**
     * Shared climb/frontier logic for both the gate-fail path and the
     * progress-timeout path (see the poll try/catch below). Escalates + marks
     * BLOCKED if the failing tier is the frontier or tiers are exhausted;
     * otherwise advances currentIndex/climbCount to the next tier.
     *
     * @param currentTier The tier that just failed (gate-fail or progress-timeout).
     * @param failReason  Human-readable reason (verdict.reason, or the fixed
     *                    progress-timeout message -- there is no GateVerdict for
     *                    a run that never reached a terminal state).
     * @param runId       runId for the escalation context (may be null).
     * @returns true if the cascade loop should stop (caller must break), false
     *          to keep climbing.
     */
    async function climbOrStop(
      currentTier: LadderTier,
      failReason: string,
      runId: string | null
    ): Promise<boolean> {
      if (currentTier.isFrontier) {
        if (superviseFailureImpl) {
          const recovery = await superviseFailureImpl({
            woId,
            cascadeId,
            tierName: currentTier.name,
            runId,
            reason: failReason,
            failureKind: 'frontier-gate',
          });
          if (recovery.handled && recovery.ownerId !== null && recovery.fencingToken !== null) {
            supervisorRecoveryRecord = {
              ownerId: recovery.ownerId,
              fencingToken: recovery.fencingToken,
              evidenceRefs: recovery.evidenceRefs,
            };
            status = 'recovery-delegated';
            return true;
          }
        }
        // Top rung (fable) failed the gate. Per John's 2026-07-02 doctrine ruling
        // ("Fable is the last escalation before failure -- a WO should never fail,
        // it should be able to be fixed"), this is NOT a terminal BLOCKED dead end.
        // Emit a SPEC-REPAIR escalation: post the failure evidence + a concrete
        // "what must change in the spec" statement to the WO's GitHub issue (comment
        // + status:blocked label) so the WO re-enters at the authoring layer.
        const evidence = buildSpecRepairEvidence(currentTier, failReason, runId, attempts);
        const whatMustChange = buildWhatMustChange(currentTier, failReason);

        let result: SpecRepairResult;
        try {
          result = await specRepairImpl({
            woId,
            tierName: currentTier.name,
            failReason,
            runId,
            evidence,
            whatMustChange,
          });
        } catch (specErr) {
          // A thrown spec-repair impl (e.g. gh totally unavailable) must not swallow
          // the escalation -- treat as "not posted" and fall through to the alert.
          console.log(
            `[smart-cauldron] SPEC-REPAIR impl threw for woId=${woId}: ` +
              `${(specErr as Error).message} (falling back to escalate/alert)`
          );
          result = { posted: false, issueRepo: null, issueNumber: null };
        }

        if (!result.posted) {
          // Mode Behavior Matrix row 4: no GitHub issue resolvable -> fall back to the
          // existing escalate/alert path with the spec-repair text in the payload.
          // The escalation must NEVER be silently dropped.
          await emitEscalation({
            errorClass: 'validator_rejected',
            woId,
            reason:
              `SPEC-REPAIR (no GitHub issue resolved) -- frontier tier ${currentTier.name} ` +
              `gate-failed: ${failReason}`,
            remediation: [whatMustChange, evidence],
            runId,
            overseerPermit: opts.overseerPermit,
          });
        }

        specRepairRecord = {
          issueRepo: result.issueRepo,
          issueNumber: result.issueNumber,
          posted: result.posted,
          whatMustChange,
          evidence,
        };
        status = 'spec-repair';
        console.log(
          `[smart-cauldron] SPEC-REPAIR: frontier tier gate-failed for woId=${woId} ` +
            `(issue posted=${result.posted})`
        );
        return true;
      }

      // Climb to next tier, skipping refused (dark/retired) rungs
      currentIndex++;
      while (currentIndex < tiers.length && refusedTiers.includes(tiers[currentIndex].name)) {
        console.log(
          `[smart-cauldron] Skipping refused tier "${tiers[currentIndex].name}" during climb`
        );
        currentIndex++;
      }
      climbCount++;

      if (currentIndex >= tiers.length) {
        // Exhausted all tiers without a win -- should not happen if frontier is marked
        status = 'blocked';
        console.log(`[smart-cauldron] BLOCKED: all tiers exhausted for woId=${woId}`);
        return true;
      }

      const nextTier = tiers[currentIndex];
      console.log(
        `[smart-cauldron] Climbing to tier=${nextTier?.name ?? 'unknown'} (climb #${climbCount})`
      );
      return false;
    }

    while (currentIndex < tiers.length) {
      const tier = tiers[currentIndex];
      if (!tier) break;

      // ==== Premium-tier approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01) ====
      // An AUTOMATIC climb into a premium tier (default ['frontier']) must NEVER
      // auto-fire: "then dont waste my usage if it will fail" (John, 2026-08-18).
      // Pause with the preserved escalation packet and emit ONE operator notice.
      // An explicit --entry override onto this tier is human-typed and bypasses
      // the gate (the operator already chose to spend on it).
      if (premiumTiers.includes(tier.name) && tier.name !== entryOverride) {
        const pausedAt = new Date().toISOString();
        let notifiedAt: string | null = null;
        try {
          await emitEscalation({
            errorClass: 'validator_rejected',
            woId,
            reason:
              'PENDING FRONTIER APPROVAL -- auto-climb reached premium tier ' +
              `"${tier.name}" (workflow ${tier.workflowName}) for ${woId}. Not fired. ` +
              'Approve to resume, or reject to send to needs-human. ' +
              `Approve: POST /api/cascades/${cascadeId}/approve-frontier ; ` +
              `Reject: POST /api/cascades/${cascadeId}/reject-frontier`,
            remediation: buildFrontierApprovalRemediation(cascadeId, tier, attempts),
            runId: attempts.at(-1)?.runId ?? null,
            overseerPermit: opts.overseerPermit,
          });
          notifiedAt = new Date().toISOString();
        } catch (notifyErr) {
          // The pause itself must persist even if the notice delivery fails --
          // an operator can still find the paused record and resolve it. Log
          // the failure and fall through to persist the paused state.
          console.log(
            `[smart-cauldron] Frontier-approval notice failed for woId=${woId}: ` +
              `${(notifyErr as Error).message} (pause persisted regardless)`
          );
        }

        frontierApprovalRecord = {
          ...(opts.expectedSpec ? { expectedSpec: opts.expectedSpec } : {}),
          tierName: tier.name,
          workflowName: tier.workflowName,
          priorContext,
          project: project ?? null,
          woId,
          woClass: woClass ?? null,
          tags: [...(tags ?? [])].sort(),
          apiBaseUrl,
          pausedAt,
          notifiedAt,
          resolution: null,
          resolvedAt: null,
          resumeCascadeId: null,
          rejectReason: null,
        };
        status = 'pending-frontier-approval';
        console.log(
          '[smart-cauldron] PENDING FRONTIER APPROVAL: auto-climb reached premium ' +
            `tier=${tier.name} for woId=${woId} -- NOT firing (cascadeId=${cascadeId})`
        );
        await checkpoint();
        break;
      }

      const attemptStartedAt = new Date().toISOString();
      const attempt: CascadeAttempt = {
        sourceEventId: `${cascadeId}:attempt:${attempts.length + 1}`,
        sourceEventAt: attemptStartedAt,
        tier: tier.name,
        workflowName: tier.workflowName,
        runId: null,
        outcome: 'running',
        gateFailReason: null,
        infraErrorReason: null,
        servedModelId: null,
        costUsd: null,
        startedAt: attemptStartedAt,
        completedAt: null,
      };
      attempts.push(attempt);
      await checkpoint();

      if (preflightImpl) {
        try {
          await preflightImpl(tier);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          attempt.outcome = 'infra-error';
          attempt.infraErrorReason = `lane preflight failed: ${reason}`;
          attempt.completedAt = new Date().toISOString();
          status = 'infra-alert';
          await emitEscalation({
            errorClass: 'invalid_request',
            woId,
            reason: `Lane preflight failed on tier ${tier.name}: ${reason}`,
            overseerPermit: opts.overseerPermit,
            runId: null,
          });
          await checkpoint();
          break;
        }
      }

      console.log(
        `[smart-cauldron] Firing woId=${woId} on tier=${tier.name} ` +
          `workflow=${tier.workflowName} (attempt ${attempts.length})`
      );

      // Re-check claim before each provider fire (another cascade or human may
      // have landed a PR while we were climbing).
      if (!allowClaimed) {
        const claimBeforeFire = await findWoClaimImpl(woId, project);
        if (claimBeforeFire) {
          console.log(
            `[smart-cauldron] ALREADY SATISFIED before tier=${tier.name}: PR #${claimBeforeFire.number} ` +
              `[${claimBeforeFire.state}] ${claimBeforeFire.url} -- stopping cascade`
          );
          status = 'won';
          winningTier = tier.name;
          attempt.outcome = 'won';
          attempt.gateFailReason = null;
          attempt.completedAt = new Date().toISOString();
          await checkpoint();
          break;
        }
      }

      // Fire the WO on this tier
      const fireResult: FireResult = await fireImpl({
        workflowName: tier.workflowName,
        woId,
        project,
        message: buildFireMessage(woId, project, priorContext ?? undefined, opts.expectedSpec),
        apiBaseUrl,
        token,
      });
      attempt.runId = fireResult.runId;

      // Infra error: alert + stop (do NOT count as "too hard")
      if (!fireResult.ok) {
        const errorClass = classifyError({
          message: fireResult.infraError ?? '',
          statusCode: extractStatusCode(fireResult.infraError ?? ''),
        });

        attempt.outcome = 'infra-error';
        attempt.infraErrorReason = fireResult.infraError;
        attempt.completedAt = new Date().toISOString();

        if (superviseFailureImpl) {
          const recovery = await superviseFailureImpl({
            woId,
            cascadeId,
            tierName: tier.name,
            runId: fireResult.runId,
            reason: fireResult.infraError ?? 'unknown infrastructure failure',
            failureKind: 'infrastructure',
          });
          if (recovery.handled && recovery.ownerId !== null && recovery.fencingToken !== null) {
            supervisorRecoveryRecord = {
              ownerId: recovery.ownerId,
              fencingToken: recovery.fencingToken,
              evidenceRefs: recovery.evidenceRefs,
            };
            status = 'recovery-delegated';
            await checkpoint();
            break;
          }
        }

        await emitEscalation({
          errorClass,
          woId,
          reason: `Infra error on tier ${tier.name}: ${fireResult.infraError ?? 'unknown'}`,
          overseerPermit: opts.overseerPermit,
          runId: null,
        });

        status = 'infra-alert';
        await checkpoint();
        break;
      }

      // The workflow run identity is durable before polling begins.
      await checkpoint();

      // Poll for terminal state (runId is guaranteed non-null since fireResult.ok is true)
      const resolvedRunId = fireResult.runId ?? '';
      let pollResult: PollResult;
      try {
        pollResult = await pollImpl({
          runId: resolvedRunId,
          apiBaseUrl,
          token,
          timeoutMs: pollTimeoutMs,
          stallTimeoutMs: pollStallTimeoutMs,
          intervalMs: pollIntervalMs,
        });
      } catch (pollErr) {
        if (pollErr instanceof TimeoutError) {
          // Progress-timeout: the model responded and burned tokens but never
          // reached a terminal state within budget. Per the three-failure-class
          // design (v1.1 amendment 2), this is a QUALITY failure, not an infra
          // failure -- cancel the hung run (best-effort; must not block the
          // climb) and climb via the same logic used for gate-fail.
          const cancelResult = await cancelImpl({ runId: resolvedRunId, apiBaseUrl, token }).catch(
            (cancelErr: unknown) => ({
              ok: false,
              error: `cancel threw: ${(cancelErr as Error).message}`,
            })
          );
          if (!cancelResult.ok) {
            console.log(
              `[smart-cauldron] Warning: cancel failed for run ${resolvedRunId} on tier ` +
                `${tier.name}: ${cancelResult.error ?? 'unknown'} (continuing climb -- ` +
                'cancellation is best-effort)'
            );
          }

          // Carry the poll's own message through: it distinguishes a STALL (run went
          // silent) from the hard-ceiling backstop (run was still emitting but ran
          // past the runaway limit). Those are different diagnoses and the operator
          // reading this line needs to know which one fired.
          const timeoutReason =
            pollErr instanceof TimeoutError
              ? pollErr.message
              : `progress-timeout: no terminal state within ${pollTimeoutMs}ms`;
          attempt.outcome = 'progress-timeout';
          attempt.gateFailReason = timeoutReason;
          attempt.completedAt = new Date().toISOString();

          console.log(`[smart-cauldron] Progress-timeout on tier=${tier.name}: ${timeoutReason}`);
          priorContext = buildTimeoutPriorContext(tier.name, pollStallTimeoutMs);

          const shouldStop = await climbOrStop(tier, timeoutReason, fireResult.runId);
          await checkpoint();
          if (shouldStop) break;
          continue;
        }

        // Non-timeout poll errors (network, API unreachable/5xx) keep the exact
        // existing infra-error handling -- unchanged.
        const errMsg = (pollErr as Error).message;
        attempt.outcome = 'infra-error';
        attempt.infraErrorReason = `poll error: ${errMsg}`;
        attempt.completedAt = new Date().toISOString();

        await emitEscalation({
          errorClass: 'service_unavailable',
          woId,
          reason: `Poll timeout/error on tier ${tier.name}: ${errMsg}`,
          overseerPermit: opts.overseerPermit,
          runId: fireResult.runId,
        });

        status = 'infra-alert';
        await checkpoint();
        break;
      }

      // Judge the gate
      const verdict: GateVerdict = judgeImpl(pollResult);
      const outcome = classifyAttemptOutcome(fireResult, verdict);

      attempt.outcome = outcome;
      attempt.gateFailReason = verdict.pass ? null : verdict.reason;
      attempt.servedModelId = pollResult.servedModelId;
      attempt.completedAt = new Date().toISOString();

      if (verdict.pass) {
        // Gate passed -- cascade stops
        status = 'won';
        winningTier = tier.name;
        await checkpoint();
        console.log(
          `[smart-cauldron] WON on tier=${tier.name} after ${attempts.length} attempt(s)`
        );
        break;
      }

      if (outcome === 'cancelled') {
        // Externally cancelled (Motion M-86): a human deliberately stopped this
        // run. STOP the cascade -- do NOT call climbOrStop. Record the truth:
        // status/outcome are 'cancelled', never a false win, never spec-repair.
        status = 'cancelled';
        console.log(`[smart-cauldron] CANCELLED on tier=${tier.name}: ${verdict.reason}`);
        await checkpoint();
        break;
      }

      // Gate failed
      console.log(`[smart-cauldron] Gate failed on tier=${tier.name}: ${verdict.reason}`);

      // Before climbing, re-check whether the work already landed under another
      // branch/PR the per-run event feed missed (the classic 5-tier burn).
      if (!allowClaimed) {
        const claimBeforeClimb = await findWoClaimImpl(woId, project);
        if (claimBeforeClimb) {
          console.log(
            `[smart-cauldron] ALREADY SATISFIED after gate-fail on tier=${tier.name}: ` +
              `PR #${claimBeforeClimb.number} [${claimBeforeClimb.state}] ${claimBeforeClimb.url} ` +
              '-- NOT climbing'
          );
          status = 'won';
          winningTier = tier.name;
          await checkpoint();
          break;
        }
      }

      // Build informed-climb context for the next tier
      priorContext = buildPriorContext(tier.name, verdict, pollResult);

      const shouldStop = await climbOrStop(tier, verdict.reason, fireResult.runId);
      await checkpoint();
      if (shouldStop) break;
    }

    const record = buildCurrentRecord();

    // Write local telemetry record
    const recordPath = await writeRecordImpl(record, outDir);
    console.log(`[smart-cauldron] Cascade record written: ${recordPath}`);

    return record;
  } finally {
    await releaseWoLockImpl(woId, project, cascadeId, outDir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build informed-climb context to pass to the next tier.
 * Summarizes what failed so the bigger model corrects a near-miss.
 */
function buildPriorContext(tierName: TierName, verdict: GateVerdict, poll: PollResult): string {
  const lines: string[] = [
    `Prior tier: ${tierName}`,
    'Gate verdict: FAILED',
    `Failing conditions: ${verdict.reason}`,
    `Terminal status: ${verdict.terminalStatus}`,
    `Validator verdict: ${verdict.validatorVerdict}`,
    `PR opened: ${verdict.prOpened}`,
    `PR mergeable: ${verdict.prMergeable === null ? 'unknown' : String(verdict.prMergeable)}`,
  ];

  if (poll.servedModelId) {
    lines.push(`Served model: ${poll.servedModelId}`);
  }

  lines.push(
    '',
    'The prior tier attempted the work but did not pass the gate.',
    'Correct the identified issues rather than starting from scratch.'
  );

  return lines.join('\n');
}

/**
 * Build informed-climb context for the next tier after a progress-timeout.
 * Distinct from buildPriorContext (gate-fail) since no GateVerdict/PollResult
 * exists for a run that never reached a terminal state.
 */
function buildTimeoutPriorContext(tierName: TierName, timeoutMs: number): string {
  return [
    `Prior tier: ${tierName}`,
    'Outcome: PROGRESS-TIMEOUT (poll watchdog kill)',
    `The run did not reach a terminal state within the ${timeoutMs}ms poll budget and was cancelled.`,
    '',
    'The prior tier likely stalled (repair loop, no-progress churn, or a hang) rather',
    'than failing a specific gate condition. Focus on completing the work within budget',
    'rather than repeating whatever caused the stall.',
  ].join('\n');
}

/**
 * Compute total cost from all attempts.
 * Returns null if no attempt has a known cost.
 */
function computeTotalCost(attempts: CascadeAttempt[]): number | null {
  const known = attempts.filter(a => a.costUsd !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

/**
 * Extract HTTP status code from an infraError string like "HTTP 401: ..."
 */
function extractStatusCode(infraError: string): number | undefined {
  const match = /HTTP\s+(\d{3})/.exec(infraError);
  if (match?.[1]) {
    const code = parseInt(match[1], 10);
    return isNaN(code) ? undefined : code;
  }
  return undefined;
}

/**
 * Default escalation implementation using the shared persistent M-42 boundary.
 */
async function defaultEscalate(ctx: EscalationCallContext): Promise<void> {
  const runId = ctx.runId ?? `cascade-${ctx.sourceEventId}`;
  const authorization = await runAuthorizedEscalation(runId, {
    permit: ctx.overseerPermit ?? null,
    actor: 'smart-cauldron',
  });
  if (!authorization.accepted) return;
  await runEscalation(
    runId,
    { decision: 'escalate', reason: ctx.reason },
    {
      errorClass: ctx.errorClass,
      woId: ctx.woId,
      repository: ctx.repository,
      remediation: ctx.remediation,
    },
    {
      sourceEventId: ctx.sourceEventId,
      eventType: 'cascade_escalation',
      stepName: 'smart-cauldron',
      eventCreatedAt: ctx.sourceEventCreatedAt,
    }
  );
}

/**
 * Build the operator-facing remediation lines for a premium-tier approval pause.
 * Lists the exact approve/reject commands and the tiers already burned so the
 * operator can decide whether the premium spend is warranted before it happens.
 */
function buildFrontierApprovalRemediation(
  cascadeId: string,
  tier: LadderTier,
  attempts: CascadeAttempt[]
): string[] {
  const lines: string[] = [
    `Premium tier "${tier.name}" (workflow ${tier.workflowName}) was reached by an ` +
      'automatic climb and was NOT fired -- awaiting operator approval.',
    `Approve (resume + fire the premium tier): POST /api/cascades/${cascadeId}/approve-frontier`,
    `Reject (terminate as needs-human, no fire): POST /api/cascades/${cascadeId}/reject-frontier`,
  ];
  if (attempts.length > 0) {
    lines.push('Tiers already attempted (cheapest first):');
    for (const a of attempts) {
      const detail = a.gateFailReason ?? a.infraErrorReason ?? '(no detail)';
      lines.push(`  - ${a.tier} [${a.outcome}]: ${detail}`);
    }
  } else {
    lines.push(
      'No prior tiers were attempted -- the conductor selected this premium tier directly.'
    );
  }
  return lines;
}

/**
 * Build the SPEC-REPAIR failure evidence block for the frontier (fable) gate-fail.
 * Summarizes what the apex rung tried and why it still failed the gate, so the
 * authoring layer has the concrete signal to repair the spec.
 */
function buildSpecRepairEvidence(
  tier: LadderTier,
  failReason: string,
  runId: string | null,
  attempts: CascadeAttempt[]
): string {
  const lines: string[] = [
    `Frontier tier: ${tier.name} (workflow: ${tier.workflowName})`,
    `Run id: ${runId ?? 'unknown'}`,
    `Gate-fail reason: ${failReason}`,
    '',
    'Cascade attempt history (cheapest tier first):',
  ];
  for (const a of attempts) {
    const detail = a.gateFailReason ?? a.infraErrorReason ?? '(no detail)';
    const served = a.servedModelId ? ` served=${a.servedModelId}` : '';
    lines.push(`  - ${a.tier} [${a.outcome}]${served}: ${detail}`);
  }
  return lines.join('\n');
}

/**
 * Build the concrete "what must change in the spec" statement. The fable apex
 * rung is the strongest available model; if it could not pass the gate, the
 * problem is upstream of execution -- the spec itself must be repaired.
 */
function buildWhatMustChange(tier: LadderTier, failReason: string): string {
  return [
    'WHAT MUST CHANGE IN THE SPEC:',
    `The apex (fable) tier "${tier.name}" is the strongest available model and it still`,
    `could not pass the completion gate (${failReason}).`,
    'This is not an execution capacity problem -- re-running will not help. The Work Order',
    'spec must be repaired before it can succeed. Concretely, revise the spec to resolve the',
    'gate-fail above: clarify ambiguous or contradictory requirements, correct any file/scope',
    'claims that did not match the codebase, tighten the stop conditions into concrete',
    'verifiable commands, or split the WO if it is too large for a single surgical change.',
    'Re-file the repaired WO to re-enter at the authoring layer.',
  ].join('\n');
}

/**
 * Default SPEC-REPAIR implementation. Resolves the WO's GitHub issue in bdc-xo
 * (via title search on the WO ID), posts a comment with the failure evidence +
 * the "what must change" statement, and applies the status:blocked label.
 *
 * Never closes the issue (premature-close fence). Returns posted=false when no
 * issue can be resolved so the caller falls back to the escalate/alert path.
 *
 * Mirrors the gh CLI pattern used by the review-issue / blocked-issue bash nodes
 * in bdc-feature-development.yaml.
 */
async function defaultSpecRepair(ctx: SpecRepairCallContext): Promise<SpecRepairResult> {
  const issueRepo = process.env.ISSUE_REPO ?? 'thinmansoftware/bdc-xo';

  // Resolve the issue number by searching the WO ID in the issue title.
  let issueNumber: number | null = null;
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue',
      'list',
      '--repo',
      issueRepo,
      '--search',
      `${ctx.woId} in:title`,
      '--json',
      'number',
      '--jq',
      '.[0].number // empty',
    ]);
    const parsed = parseInt(stdout.trim(), 10);
    if (!isNaN(parsed)) issueNumber = parsed;
  } catch (err) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: gh issue lookup failed for ${ctx.woId}: ` +
        (err as Error).message
    );
    return { posted: false, issueRepo, issueNumber: null };
  }

  if (issueNumber === null) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: no GitHub issue resolved for ${ctx.woId} in ${issueRepo}.`
    );
    return { posted: false, issueRepo, issueNumber: null };
  }

  const body = [
    '## SPEC-REPAIR required (Smart Cauldron apex rung gate-fail)',
    '',
    `The escalation cascade reached the frontier (fable) tier for **${ctx.woId}** and the`,
    'apex rung still gate-failed. Per doctrine (John, 2026-07-02): Fable is the last',
    'escalation before failure -- a WO should never terminally fail, it should be fixed.',
    '',
    '### Failure evidence',
    '```',
    ctx.evidence,
    '```',
    '',
    '### What must change',
    ctx.whatMustChange,
  ].join('\n');

  try {
    // Ensure the label exists (best-effort; ignore "already exists").
    await execFileAsync('gh', [
      'label',
      'create',
      'status:blocked',
      '--repo',
      issueRepo,
      '--color',
      'B60205',
      '--description',
      'BDC Work Order blocked -- spec repair required',
    ]).catch(() => undefined);

    await execFileAsync('gh', [
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      issueRepo,
      '--body',
      body,
    ]);

    await execFileAsync('gh', [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      issueRepo,
      '--add-label',
      'status:blocked',
    ]);

    console.log(
      `[smart-cauldron] SPEC-REPAIR: posted comment + status:blocked on ${issueRepo}#${issueNumber}`
    );
    return { posted: true, issueRepo, issueNumber };
  } catch (err) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: gh comment/label failed for ${issueRepo}#${issueNumber}: ` +
        (err as Error).message
    );
    return { posted: false, issueRepo, issueNumber };
  }
}
