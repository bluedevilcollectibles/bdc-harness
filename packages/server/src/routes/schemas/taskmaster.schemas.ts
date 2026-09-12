/**
 * Zod schemas for the Taskmaster Slice 1 operator routes
 * (WO-HARNESS-TASKMASTER-SLICE1-01). One file per domain per repo
 * convention; types derive via z.infer -- no parallel interfaces.
 */
import { z } from '@hono/zod-openapi';

export const taskmasterPauseStateSchema = z.enum(['RUNNING', 'PAUSED', 'HARD_PAUSE']);

export const taskmasterTickHealthSchema = z.enum(['healthy', 'degraded', 'not_running']);

export const taskmasterStatusResponseSchema = z
  .object({
    pause_state: taskmasterPauseStateSchema,
    pause_scope: z.string().nullable(),
    pause_reason: z.string().nullable(),
    pause_actor: z.string().nullable(),
    epoch: z.number(),
    tick_health: taskmasterTickHealthSchema,
    interval_ms: z.number(),
    last_tick_at: z.string().nullable(),
    headroom_state: z.enum(['OK', 'LOW', 'UNKNOWN']).nullable(),
    effects_last_24h: z.number(),
  })
  .openapi('TaskmasterStatusResponse');

export const taskmasterPauseBodySchema = z
  .object({
    reason: z.string().max(2000).optional(),
    scope: z.string().max(200).optional(),
    actor: z.string().max(200).default('operator'),
  })
  .openapi('TaskmasterPauseBody');

export const taskmasterResumeBodySchema = z
  .object({
    actor: z.string().max(200).default('john'),
    reason: z.string().max(2000).optional(),
  })
  .openapi('TaskmasterResumeBody');

export const taskmasterControlResponseSchema = z
  .object({
    pause_state: taskmasterPauseStateSchema,
    epoch: z.number(),
    expired_proposals: z.number().optional(),
    audit_id: z.string().optional(),
  })
  .openapi('TaskmasterControlResponse');

export const registerRowSchema = z
  .object({
    thread_ref: z.string(),
    snapshot_id: z.string(),
    repo: z.string(),
    issue_number: z.number().int(),
    title: z.string().nullable(),
    priority: z.string(),
    labels_json: z.string(),
    owner_login: z.string().nullable(),
    is_blocked: z.number().int(),
    blocked_reason: z.string().nullable(),
    next_action: z.string().nullable(),
    latest_marker_kind: z.enum(['PROGRESS', 'BLOCKED']).nullable(),
    latest_marker_at: z.string().nullable(),
    state: z.string().nullable(),
    last_movement_at: z.string().nullable(),
    last_movement_kind: z
      .enum(['closed', 'assigned', 'status_label', 'progress_comment'])
      .nullable(),
    attempts_24h: z.number().int(),
    attempts_total: z.number().int(),
    evidence_observed_at: z.string().nullable(),
    source_updated_at: z.string(),
  })
  .openapi('TaskmasterRegisterRow');

export const registerListQuerySchema = z.object({
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  owner: z.string().optional(),
  blocked: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const registerListResponseSchema = z
  .object({
    rows: z.array(registerRowSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('TaskmasterRegisterListResponse');

export const registerMetaResponseSchema = z
  .object({
    freshness: z.array(z.enum(['FRESH', 'STALE', 'PARTIAL', 'UNAVAILABLE'])).min(1),
    rebuilt_at: z.string().nullable(),
    row_count: z.number().int(),
    partial_count: z.number().int(),
    pause_state: taskmasterPauseStateSchema,
    unaddressed_xo: z.number().int(),
  })
  .openapi('TaskmasterRegisterMetaResponse');

/**
 * Expectation front door (bdc-xo#2007).
 *
 * The six evidence kinds mirror the EvidenceSpec union in
 * packages/server/src/taskmaster/expectations.ts EXACTLY. All six have been
 * implemented and checkable since #1850; until this schema existed, nothing
 * outside the loop could reach five of them. The discriminated union is the
 * contract that keeps them reachable AND keeps a caller from inventing a
 * seventh kind the checker would reject at the deadline instead of at
 * registration.
 */
export const evidenceSpecSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('issue_comment_exists'),
      repo: z.string().min(1),
      number: z.number().int().positive(),
      author: z.string().min(1).optional(),
      marker: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal('label_present'),
      repo: z.string().min(1),
      number: z.number().int().positive(),
      label: z.string().min(1),
    }),
    z.object({
      kind: z.literal('pr_opened'),
      repo: z.string().min(1),
      head_branch: z.string().min(1).optional(),
      title_prefix: z.string().min(1).optional(),
    }),
    z.object({ kind: z.literal('lease_holder_is'), name: z.string().min(1) }),
    z.object({
      kind: z.literal('dispatch_reply_exists'),
      correlation_id: z.string().min(1),
      classification: z.enum(['succeeded', 'failed', 'blocked']).optional(),
    }),
    z.object({
      kind: z.literal('db_row_exists'),
      // Identifier shape is enforced HERE as well as in checkEvidence. The
      // checker's own guard is the security boundary (it is what actually
      // interpolates into SQL); this one exists so a malformed table name is a
      // 400 at registration rather than a throw at the deadline, which would
      // leave the expectation silently unverifiable.
      table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      where: z.record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          z.array(z.union([z.string(), z.number(), z.boolean()])),
        ])
      ),
    }),
  ])
  .openapi('TaskmasterEvidenceSpec');

export const registerExpectationBodySchema = z
  .object({
    /**
     * Caller-supplied idempotency. REQUIRED -- there is no server-side default,
     * because the only thing a server could derive it from is the request
     * content, and a caller that retries with a regenerated due_at would then
     * register a second expectation for the same work. Making the caller name
     * the identity is what makes a retry safe.
     */
    registration_key: z.string().min(8).max(200),
    dispatch_ref: z.string().min(1).max(500),
    recipient: z.string().min(1).max(200),
    evidence: evidenceSpecSchema,
    due_at: z.string().datetime().optional(),
    due_in_minutes: z.number().int().min(1).max(43_200).optional(),
    on_absence: z.enum(['redispatch', 'escalate', 'give_up']).default('escalate'),
    max_retries: z.number().int().min(0).max(5).default(0),
    /**
     * WHO is asking. Recorded on the row and used as the denominator for the
     * per-caller daily cap. Defaults to 'operator' because the operator token
     * is what the route authenticates; a caller that names itself gets its own
     * budget and its own audit trail instead of sharing the operator's.
     */
    registered_by: z.string().min(1).max(200).default('operator'),
  })
  .openapi('TaskmasterRegisterExpectationBody');

export const registerExpectationResponseSchema = z
  .object({
    id: z.string(),
    registration_key: z.string(),
    due_at: z.string(),
    on_absence: z.enum(['redispatch', 'escalate', 'give_up']),
    /** False when this key already existed and the existing row was returned. */
    created: z.boolean(),
    self_supervised: z.boolean(),
  })
  .openapi('TaskmasterRegisterExpectationResponse');

export const listExpectationsQuerySchema = z.object({
  status: z.enum(['pending', 'met', 'failed', 'escalating', 'escalated', 'given_up']).optional(),
  registered_by: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const expectationRowSchema = z
  .object({
    id: z.string(),
    registration_key: z.string(),
    dispatch_ref: z.string(),
    recipient: z.string(),
    evidence_json: z.string(),
    due_at: z.string(),
    on_absence: z.enum(['redispatch', 'escalate', 'give_up']),
    max_retries: z.number().int(),
    retries: z.number().int(),
    status: z.enum(['pending', 'met', 'failed', 'escalating', 'escalated', 'given_up']),
    evidence_pointer: z.string().nullable(),
    registered_by: z.string().nullable(),
    self_supervised: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('TaskmasterExpectationRow');

export const listExpectationsResponseSchema = z
  .object({ rows: z.array(expectationRowSchema), total: z.number().int() })
  .openapi('TaskmasterListExpectationsResponse');

export type EvidenceSpecBody = z.infer<typeof evidenceSpecSchema>;
export type RegisterExpectationBody = z.infer<typeof registerExpectationBodySchema>;
export type RegisterExpectationResponse = z.infer<typeof registerExpectationResponseSchema>;
export type ListExpectationsResponse = z.infer<typeof listExpectationsResponseSchema>;

export type TaskmasterStatusResponse = z.infer<typeof taskmasterStatusResponseSchema>;
export type TaskmasterPauseBody = z.infer<typeof taskmasterPauseBodySchema>;
export type TaskmasterResumeBody = z.infer<typeof taskmasterResumeBodySchema>;
export type TaskmasterControlResponse = z.infer<typeof taskmasterControlResponseSchema>;
export type RegisterRow = z.infer<typeof registerRowSchema>;
export type RegisterListResponse = z.infer<typeof registerListResponseSchema>;
export type RegisterMetaResponse = z.infer<typeof registerMetaResponseSchema>;
