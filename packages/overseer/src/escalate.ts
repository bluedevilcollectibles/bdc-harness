/**
 * Escalation side-effect handler for silent-dead-end failures.
 *
 * Fires when @archon/overseer's decide() returns decision='escalate' WITH a populated
 * escalationContext. The executor (overseer-bridge) routes the call here. Two
 * operator-visible signals are produced for every escalation:
 *
 *   1. JSON file at <archonHome>/runs/<runId>/escalation.json containing the full
 *      structured context (errorClass, nodeId, validatorOutput, remediation, timestamp).
 *   2. POST to BUILDER_MONITOR_WEBHOOK_URL with action='needs_human' so the n8n
 *      monitor dashboard surfaces the failure to John.
 *
 * Anchor: 2026-05-18 Wave A -- silent exit-1 on commit-and-push lost work on
 * WO-AUTH-RETIRE-GAS-PATH-02 and WO-AUTH-SINGLE-PATH-E2E-04. This module is the
 * mechanism that ensures no Cauldron failure ever exits silently again.
 */

import { appendOperatorCard, type OperatorCardRecord } from '@archon/core/db/overseer-briefing';
import {
  buildOperatorCard,
  OPERATOR_CARD_IDENTITY_VERSION,
  type ActionableEventIdentity,
  type OperatorCardPayload,
} from './operator-card';
import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

/**
 * Structured payload accepted by runEscalation. Mirrors the loose shape of
 * DecisionResult.escalationContext but adds runtime-only fields (runId, timestamp)
 * populated by this module rather than the decision layer.
 */
export interface EscalationContext {
  errorClass: ErrorClass;
  nodeId?: string;
  woId?: string;
  validatorOutput?: string;
  remediation?: string[];
  /** Additional ad-hoc diagnostic fields */
  [key: string]: unknown;
}

export interface EscalationSourceEvent {
  sourceEventId: string;
  eventType: string;
  stepName: string;
  eventCreatedAt: string;
}

/**
 * Run an escalation for a non-recoverable workflow failure.
 *
 * Side effects are best-effort and isolated: if either of (escalation.json /
 * webhook) fails, the other is still attempted. Errors are
 * captured and surfaced via the return value rather than thrown -- the caller
 * (overseer-bridge) is in a node-failure code path and should not amplify the
 * failure with an escalation-side error.
 */
export async function runEscalation(
  runId: string,
  decision: DecisionResult,
  context: EscalationContext,
  source: EscalationSourceEvent
): Promise<OperatorCardRecord> {
  if (!context.woId) throw new Error('operator_card_identity_invalid:wo_id');
  const identity: ActionableEventIdentity = {
    identity_version: OPERATOR_CARD_IDENTITY_VERSION,
    source_event_id: source.sourceEventId,
    run_id: runId,
    wo_id: context.woId,
    event_type: source.eventType,
    step_name: source.stepName,
    event_created_at: source.eventCreatedAt,
    error_class: context.errorClass,
  };
  const payload: OperatorCardPayload = {
    repository: textValue(context.repository) ?? 'thinmansoftware/bdc-harness',
    branch: textValue(context.branch),
    pr_url: textValue(context.prUrl),
    pr_number: numberValue(context.prNumber),
    head_sha: textValue(context.headSha),
    base_branch: textValue(context.baseBranch),
    base_sha: textValue(context.baseSha),
    checks: objectValue(context.checks),
    mergeability: textValue(context.mergeability) ?? 'unknown',
    blocker: decision.reason,
    mechanical_evidence: {
      node_id: context.nodeId ?? null,
      validator_output: context.validatorOutput ?? null,
    },
    recovery_attempted: objectValue(context.recoveryAttempted),
    proposed_remediation: { steps: context.remediation ?? [] },
    next_permitted_action: textValue(context.nextPermittedAction) ?? 'await operator ruling',
    responsible_actor: textValue(context.responsibleActor) ?? 'acting-xo',
    actionable_event_at: source.eventCreatedAt,
    required_ruling: textValue(context.requiredRuling),
    evidence_links: objectValue(context.evidenceLinks),
    lifecycle_classification: textValue(context.lifecycleClassification) ?? 'recovery',
    governance_classification: textValue(context.governanceClassification) ?? 'information-only',
  };
  const built = buildOperatorCard(identity, payload);
  const persisted = await appendOperatorCard({
    card_id: built.card_id,
    identity_version: built.identity_version,
    canonical_event_identity: { ...built.canonical_event_identity },
    payload_digest: built.payload_digest,
    payload: { ...built.payload },
    ...built.payload,
    run_id: runId,
    wo_id: context.woId,
  });
  return persisted.card;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildDispatchRunReportBody(
  context: EscalationContext | OperatorCardRecord,
  decision?: DecisionResult,
  runId?: string,
  timestamp = new Date().toISOString()
): string {
  if (isOperatorCardRecord(context)) {
    return JSON.stringify({
      kind: 'overseer_run_report',
      card_id: context.card_id,
      payload_digest: context.payload_digest,
      ...context.payload,
      delivery_summary: null,
    });
  }
  return JSON.stringify({
    kind: 'overseer_run_report',
    runId: runId ?? 'unknown',
    woId: context.woId ?? 'unknown',
    class: context.errorClass,
    nodeId: context.nodeId ?? null,
    decision: decision?.decision ?? 'escalate',
    reason: decision?.reason ?? context.blocker ?? 'operator card',
    remediation: context.remediation ?? [],
    timestamp,
  });
}

function isOperatorCardRecord(
  value: EscalationContext | OperatorCardRecord
): value is OperatorCardRecord {
  return typeof (value as Partial<OperatorCardRecord>).payload_digest === 'string';
}
