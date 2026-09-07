/**
 * types.ts -- Smart Cauldron v1.0 core type definitions.
 *
 * Per-run escalation cascade: fires WOs on cheapest tier first, climbs on gate-fail.
 * WO: WO-HARNESS-SMART-CAULDRON-V1-PER-RUN-CASCADE-01
 */

export type TierName = string; // e.g. "zero", "qwen", "codex", "claude", "frontier"

export type TierOutcome =
  | 'running' // attempt intent persisted before the workflow lane is fired
  | 'won' // gate passed -- cascade stops
  | 'gate-failed' // ran, built, gate failed -- climb
  | 'infra-error' // auth/transport failure -- alert, do not count as "too hard"
  | 'progress-timeout' // poll watchdog kill -- run never reached terminal; climb like gate-failed
  | 'cancelled'; // externally cancelled; stop, do not climb

export interface LadderTier {
  name: TierName;
  workflowName: string; // e.g. "bdc-feature-development-codex"
  isFrontier: boolean; // true = top rung; gate-fail here = BLOCKED
  costPerRunUsd: number | null; // null = unknown; populated from run metadata post-hoc
}

export interface ConductorRuleset {
  defaultEntry: TierName;
  rules: {
    match: { woClass?: string; tags?: string[] };
    entry: TierName;
  }[];
}

export interface CascadeAttempt {
  sourceEventId: string;
  sourceEventAt: string;
  tier: TierName;
  workflowName: string;
  runId: string | null;
  outcome: TierOutcome;
  gateFailReason: string | null; // which condition failed (terminal/validator/pr)
  infraErrorReason: string | null; // HTTP status + message on infra-error
  servedModelId: string | null; // from run metadata when available
  costUsd: number | null;
  startedAt: string;
  completedAt: string | null;
}

export type CascadeStatus =
  | 'planned' // dry-run selection only; no provider or workflow was fired
  | 'running' // durable cascade record exists and an attempt may be in flight
  | 'won' // a tier passed the gate
  | 'blocked' // all tiers exhausted without a frontier (defensive; should not happen)
  | 'spec-repair' // frontier (fable) tier gate-failed -> SPEC-REPAIR escalation, not a dead end
  | 'recovery-delegated' // an explicitly injected fenced supervisor accepted recovery ownership
  | 'infra-alert' // infra-error on a tier (escalate/alert, not climb silently)
  | 'pending-frontier-approval' // auto-climb reached a premium tier; paused for operator approval, not fired
  | 'frontier-rejected' // operator rejected the premium-tier climb; terminated as needs-human, no fire
  | 'frontier-approved' // operator approved the premium climb; original record handed off to the resumed cascade (resumeCascadeId)
  | 'cancelled'; // an attempt was externally cancelled; cascade stopped

/**
 * FrontierApprovalPacket -- the preserved escalation packet stored when an
 * AUTOMATIC climb reaches a premium tier (default ['frontier']) and the cascade
 * pauses instead of firing (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01).
 *
 * "then dont waste my usage if it will fail" (John, 2026-08-18): the premium
 * (fable) tier is never auto-fired on an unattended escalation. The packet
 * carries everything the frontier fire WOULD have used so an operator approve
 * can resume it exactly where it paused, or a reject can terminate it cleanly.
 *
 * SECRET BOUNDARY: the operator token is NEVER persisted here (matches the
 * cascade/cli secret boundary). The resume endpoint re-supplies the token.
 */
export interface FrontierApprovalPacket {
  /** Preserve the dispatch-time canonical source constraint across approval. */
  expectedSpec?: import('@archon/core/workflows/work-order-source').ExpectedSpecIdentity;
  /** The premium tier the cascade would have fired next (e.g. 'frontier'). */
  tierName: TierName;
  /** The workflow lane bound to that premium tier (e.g. 'bdc-feature-development-fable'). */
  workflowName: string;
  /** Informed-climb context the frontier fire would have carried (may be null). */
  priorContext: string | null;
  /** Frozen codebase authority for the resumed fire. */
  project: string | null;
  woId: string;
  woClass: string | null;
  tags: string[];
  /** Archon API base URL captured at pause time (re-used verbatim on resume). */
  apiBaseUrl: string;
  /** When the cascade paused at the premium boundary. */
  pausedAt: string;
  /** When the single operator notice was emitted (null if notification failed). */
  notifiedAt: string | null;
  /** Set once the pause is resolved: 'approved' fires, 'rejected' terminates. */
  resolution: 'approved' | 'rejected' | null;
  /** When the resolution was applied. */
  resolvedAt: string | null;
  /** cascadeId of the NEW cascade launched by an approve (back-reference). */
  resumeCascadeId: string | null;
  /** Operator-supplied reason on a reject (null otherwise). */
  rejectReason: string | null;
}

export interface CascadeRunRecord {
  cascadeId: string; // randomUUID
  woId: string;
  project: string | null; // frozen codebase authority; null only for dry-run plans
  request: {
    woClass: string | null;
    tags: string[];
    entryOverride: TierName | null;
    dryRun: boolean;
  };
  createdAt: string;
  status: CascadeStatus;
  winningTier: TierName | null;
  attempts: CascadeAttempt[];
  totalCostUsd: number | null;
  telemetry: {
    entryTier: TierName;
    climbed: boolean;
    climbCount: number;
    wonCheap: boolean; // true if entry tier won without climbing
  };
  /**
   * Populated ONLY when the frontier (fable) tier gate-failed and the cascade
   * emitted a SPEC-REPAIR escalation (status === 'spec-repair'). Doctrine
   * 2026-07-02 (John): Fable is the last escalation before failure -- a WO must
   * never terminally fail. `posted` is true when the WO's GitHub issue received
   * the SPEC-REPAIR comment + status:blocked label; false when no issue resolved
   * and the escalate/alert fallback carried the same text instead.
   */
  specRepair?: {
    issueRepo: string | null;
    issueNumber: number | null;
    posted: boolean;
    whatMustChange: string;
    evidence: string;
  };
  supervisorRecovery?: {
    ownerId: string;
    fencingToken: number;
    evidenceRefs: string[];
  };
  /**
   * Populated ONLY when an automatic climb reached a premium tier and the
   * cascade paused (status === 'pending-frontier-approval') or the pause was
   * resolved (status resolves via approve/reject). Carries the preserved
   * escalation packet so an operator can approve (resume + fire) or reject
   * (terminate as needs-human) later. See FrontierApprovalPacket.
   */
  frontierApproval?: FrontierApprovalPacket;
}

export interface GateVerdict {
  pass: boolean;
  reason: string; // human-readable -- which condition failed
  cancelled: boolean; // run was externally cancelled -- stop the cascade, never a win, never a climb
  validatorVerdict: 'satisfied' | 'needs_revision' | 'unknown';
  prOpened: boolean;
  prMergeable: boolean | null;
  terminalStatus: string;
}

/**
 * FireResult: runId is null on infra-error or while run discovery is pending.
 * conversationId is supplied by the atomic conversation response and remains
 * null when dispatch never created a conversation.
 */
export interface FireResult {
  ok: boolean;
  runId: string | null; // resolved via discovery poll; null only on infra-error
  conversationId: string | null; // server-issued parent platform conversation id
  infraError: string | null; // set when HTTP != 200 or discovery times out
}

export interface PollResult {
  runId: string;
  /** Includes 'escalated' (WO-HARNESS-ESCALATED-RUN-STATUS-01) as a terminal non-success. */
  terminalStatus: 'completed' | 'failed' | 'escalated' | 'cancelled';
  validatorVerdict: 'satisfied' | 'needs_revision' | 'unknown';
  prUrl: string | null;
  prMergeable: boolean | null;
  servedModelId: string | null;
  rawMetadata: Record<string, unknown>;
}
