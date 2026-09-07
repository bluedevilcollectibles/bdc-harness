/**
 * GitHub rate-limit classification (bdc-harness #782 part 2; relates to #774,
 * #775).
 *
 * THE GAP THIS CLOSES: when the GitHub client exhausts the per-user rate limit
 * mid-review, the error propagated out of `fetchEvidence` and the evaluator
 * mapped it to INDETERMINATE -- a TERMINAL, non-approving verdict. The review
 * was retired, the PR kept whatever stale verdict it had, and nothing ever
 * retried. Observed live 2026-09-07 on bdc-harness #776 @c3935e09: two
 * INDETERMINATE verdicts, the second coinciding with a per-user rate-limit
 * exhaustion in the container log (user 255238497).
 *
 * A rate limit is a "come back later" signal, never a judgment about the code.
 * It must become a DEFERRAL carrying the reset time so the work item re-enters
 * the queue at exactly the moment the budget refills -- never INDETERMINATE and
 * never CHANGES_REQUESTED.
 *
 * This module is PURE: it inspects an already-thrown error value. It performs
 * no IO, so every branch (primary limit, secondary limit, retry-after header,
 * reset header, missing headers, unrelated 403) is deterministically testable.
 *
 * WHY 403 AND 429 BOTH: GitHub answers a primary rate-limit exhaustion with
 * 403 and `x-ratelimit-remaining: 0`, and secondary/abuse limits with either
 * 403 or 429 plus a `retry-after` header. A bare 403 with neither marker is an
 * ordinary permission denial and MUST NOT be classified as a rate limit --
 * doing so would convert a real, permanent authorization failure into an
 * infinite deferral loop (the #774 spin).
 */

/** Default wait when the response says "rate limited" but carries no usable clock. */
export const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

/**
 * Upper bound on any deferral. GitHub's primary window is one hour; a corrupt
 * or far-future reset header must not park a review for days.
 */
export const MAX_RATE_LIMIT_RETRY_MS = 3_600_000;

export interface RateLimitClassification {
  /** Milliseconds to wait before the work item becomes claimable again. */
  retryAfterMs: number;
  /** Absolute instant the budget is expected to have refilled (ISO-8601). */
  retryAfter: string;
  /** Stable machine-readable source of the wait: which signal was believed. */
  source: 'retry_after_header' | 'reset_header' | 'default';
  /** Which GitHub limit fired, for the receipt. */
  kind: 'primary' | 'secondary';
}

interface HeaderBag {
  get?(name: string): string | null | undefined;
  [key: string]: unknown;
}

/**
 * Reads one header case-insensitively from either a `Headers`-like object (with
 * a `get` method, as fetch-based Octokit returns) or a plain lowercase-keyed
 * record (as `@octokit/request-error` exposes). Both shapes occur in practice.
 */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const bag = headers as HeaderBag;
  if (typeof bag.get === 'function') {
    const value = bag.get(name);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const [key, value] of Object.entries(bag)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'number') return candidate.response.status;
  return undefined;
}

function errorHeaders(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { headers?: unknown; response?: { headers?: unknown } };
  return candidate.headers ?? candidate.response?.headers;
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') return error.message;
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === 'string') return candidate.message;
  }
  return '';
}

function clampRetryMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_RATE_LIMIT_RETRY_MS;
  return Math.min(Math.ceil(value), MAX_RATE_LIMIT_RETRY_MS);
}

/**
 * Classify a thrown GitHub error as a rate limit, or return null.
 *
 * Returning null is the SAFE default: an unrecognized error keeps whatever
 * terminal handling the caller already had. Only an unambiguous rate-limit
 * signal -- `x-ratelimit-remaining: 0`, a `retry-after` header, or an explicit
 * secondary-rate-limit message -- converts a failure into a deferral, so a
 * permanent 403 can never become an endless retry.
 *
 * `now` is injected so the computed instant is deterministic in tests.
 */
export function classifyRateLimitError(
  error: unknown,
  now: Date = new Date()
): RateLimitClassification | null {
  const status = errorStatus(error);
  if (status !== 403 && status !== 429) return null;

  const headers = errorHeaders(error);
  const remaining = readHeader(headers, 'x-ratelimit-remaining');
  const retryAfterHeader = readHeader(headers, 'retry-after');
  const resetHeader = readHeader(headers, 'x-ratelimit-reset');
  const message = errorMessageText(error).toLowerCase();

  const primaryExhausted = remaining !== undefined && Number(remaining) === 0;
  const secondarySignalled =
    retryAfterHeader !== undefined ||
    message.includes('secondary rate limit') ||
    message.includes('abuse detection');
  const messageSignalled = message.includes('rate limit') || message.includes('api rate limit');

  if (!primaryExhausted && !secondarySignalled && !messageSignalled) {
    // A bare 403/429 with no rate-limit marker is a permission denial or an
    // unrelated refusal. Deferring on it would spin forever (#774).
    return null;
  }

  const kind: RateLimitClassification['kind'] = primaryExhausted ? 'primary' : 'secondary';

  // Preference order: an explicit retry-after is GitHub telling us exactly how
  // long to wait; the reset epoch is the primary window's refill instant; the
  // default is the last resort so a deferral always has a finite clock.
  if (retryAfterHeader !== undefined) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      const retryAfterMs = clampRetryMs(seconds * 1000);
      return {
        retryAfterMs,
        retryAfter: new Date(now.getTime() + retryAfterMs).toISOString(),
        source: 'retry_after_header',
        kind,
      };
    }
  }

  if (resetHeader !== undefined) {
    const resetEpochSeconds = Number(resetHeader);
    if (Number.isFinite(resetEpochSeconds) && resetEpochSeconds > 0) {
      const retryAfterMs = clampRetryMs(resetEpochSeconds * 1000 - now.getTime());
      return {
        retryAfterMs,
        retryAfter: new Date(now.getTime() + retryAfterMs).toISOString(),
        source: 'reset_header',
        kind,
      };
    }
  }

  return {
    retryAfterMs: DEFAULT_RATE_LIMIT_RETRY_MS,
    retryAfter: new Date(now.getTime() + DEFAULT_RATE_LIMIT_RETRY_MS).toISOString(),
    source: 'default',
    kind,
  };
}

/** True when the error is an unambiguous GitHub rate limit. */
export function isRateLimitError(error: unknown): boolean {
  return classifyRateLimitError(error) !== null;
}
