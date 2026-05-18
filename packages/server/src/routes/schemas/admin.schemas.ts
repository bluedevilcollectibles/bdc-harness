/**
 * Zod schemas for admin API endpoints.
 *
 * Currently scoped to the global Claude provider throttle gate
 * (POST /api/admin/throttle). Added by WO-HARNESS-RATE-LIMIT-AUTO-PAUSE-ENGINE-01
 * so operators can manually pause/release every in-flight Claude SDK call when
 * the auto-engage heuristic misses or needs to be pre-empted.
 */
import { z } from '@hono/zod-openapi';

/** POST /api/admin/throttle request body. */
export const throttleBodySchema = z.object({ paused: z.boolean() }).openapi('AdminThrottleBody');

/**
 * POST /api/admin/throttle response.
 * `paused` echoes the resulting gate state so the caller can confirm without
 * a follow-up GET.
 */
export const throttleResponseSchema = z
  .object({
    success: z.boolean(),
    paused: z.boolean(),
    message: z.string(),
    engagedBy: z.enum(['operator', 'auto']).optional(),
  })
  .openapi('AdminThrottleResponse');
