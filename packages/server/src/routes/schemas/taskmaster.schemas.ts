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

export type TaskmasterStatusResponse = z.infer<typeof taskmasterStatusResponseSchema>;
export type TaskmasterPauseBody = z.infer<typeof taskmasterPauseBodySchema>;
export type TaskmasterResumeBody = z.infer<typeof taskmasterResumeBodySchema>;
export type TaskmasterControlResponse = z.infer<typeof taskmasterControlResponseSchema>;
export type RegisterRow = z.infer<typeof registerRowSchema>;
export type RegisterListResponse = z.infer<typeof registerListResponseSchema>;
export type RegisterMetaResponse = z.infer<typeof registerMetaResponseSchema>;
