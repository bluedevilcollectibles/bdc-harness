/**
 * Global throttle gate for Claude SDK calls.
 *
 * Two engage paths:
 *   1. Auto-engage  — `checkRateLimitAndMaybeThrottle()` reads the rate-limit
 *      info emitted by the SDK; engages when utilization >= AUTO_THROTTLE_UTILIZATION
 *      AND the 5-hour window is about to reset (less than AUTO_THROTTLE_LEAD_MS away).
 *      Mirrors the doctrine the 2026-05-18 incident codified: do not race the
 *      window-end; hold for the rollover.
 *   2. Operator   — `POST /api/admin/throttle` calls `setThrottled(true)`.
 *
 * While throttled, every Claude SDK call awaits `waitForRelease()`. Pending
 * waiters drain FIFO when `setThrottled(false)` runs. Waiters tied to an
 * AbortSignal reject immediately on abort so a cancelled workflow does not
 * block forever.
 *
 * Restart durability: engage state is persisted to
 * `<ARCHON_HOME>/throttle-state.json`. On module load, if the file exists and
 * `resetsAt` is still in the future, the throttle is re-engaged so an in-flight
 * window-end stand-down survives a server restart.
 *
 * Singleton: this module owns one process-wide gate. Workflows running in
 * parallel share the same gate by design — the 5-hour quota is shared across
 * the whole subscription, so per-run gating would not protect it.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { getArchonHome } from '@archon/paths';
import { createLogger } from '@archon/paths';

/** Auto-engage triggers when utilization is at or above this fraction (0..1). */
export const AUTO_THROTTLE_UTILIZATION = 0.85;

/** Auto-engage only fires when the rate-limit window resets in less than this many ms. */
export const AUTO_THROTTLE_LEAD_MS = 300_000; // 5 minutes

/** Small grace added when computing release deadline so we don't release on the exact tick. */
const AUTO_THROTTLE_RELEASE_GRACE_MS = 5_000;

/** Path for the persisted throttle snapshot. */
function getThrottleStatePath(): string {
  return join(getArchonHome(), 'throttle-state.json');
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude.throttle');
  return cachedLog;
}

/** Context describing why the throttle was engaged — surfaced in logs + snapshot. */
export interface ThrottleEngageContext {
  /** `operator` from `POST /api/admin/throttle`, `auto` from rate-limit event. */
  engagedBy: 'operator' | 'auto';
  /** Epoch ms when the underlying rate-limit window resets (auto-engage only). */
  resetsAt?: number;
  /** Utilization fraction at engage time (auto-engage only). */
  utilization?: number;
  /** Rate-limit type label from the SDK (auto-engage only). */
  rateLimitType?: string;
}

/** Persisted snapshot shape. */
interface ThrottleSnapshot {
  paused: boolean;
  engagedAt: number;
  engagedBy: 'operator' | 'auto';
  resetsAt?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let throttled = false;
let engageContext: ThrottleEngageContext | undefined;
const waiters: Waiter[] = [];

/**
 * Persist current throttle state to disk. Failures are logged but do not throw —
 * persistence is best-effort; the in-memory gate is the source of truth.
 */
function persistSnapshot(): void {
  const path = getThrottleStatePath();
  try {
    if (!throttled) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    const snapshot: ThrottleSnapshot = {
      paused: true,
      engagedAt: Date.now(),
      engagedBy: engageContext?.engagedBy ?? 'operator',
      ...(engageContext?.resetsAt !== undefined ? { resetsAt: engageContext.resetsAt } : {}),
    };
    writeFileSync(path, JSON.stringify(snapshot), 'utf-8');
  } catch (err) {
    getLog().warn({ err: err as Error, path }, 'throttle.snapshot_write_failed');
  }
}

/**
 * Read persisted snapshot. Returns null on missing/corrupt files.
 * Caller decides whether to re-engage based on `resetsAt`.
 */
function readSnapshot(): ThrottleSnapshot | null {
  const path = getThrottleStatePath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ThrottleSnapshot>;
    if (typeof parsed.paused !== 'boolean') return null;
    if (typeof parsed.engagedAt !== 'number') return null;
    if (parsed.engagedBy !== 'operator' && parsed.engagedBy !== 'auto') return null;
    return parsed as ThrottleSnapshot;
  } catch (err) {
    getLog().warn({ err: err as Error, path }, 'throttle.snapshot_read_failed');
    return null;
  }
}

/**
 * Restore throttle state from the persisted snapshot if the rate-limit window
 * has not yet rolled over. Called once at module load.
 */
function restoreFromSnapshot(): void {
  const snap = readSnapshot();
  if (!snap?.paused) return;
  // If a resetsAt was recorded and it has already passed, the throttle would
  // have auto-released — clear the stale snapshot.
  if (
    snap.resetsAt !== undefined &&
    snap.resetsAt * 1000 + AUTO_THROTTLE_RELEASE_GRACE_MS <= Date.now()
  ) {
    try {
      unlinkSync(getThrottleStatePath());
    } catch {
      // best-effort cleanup
    }
    getLog().info({ snapshot: snap }, 'throttle.snapshot_expired_on_boot');
    return;
  }
  throttled = true;
  engageContext = {
    engagedBy: snap.engagedBy,
    ...(snap.resetsAt !== undefined ? { resetsAt: snap.resetsAt } : {}),
  };
  getLog().warn({ snapshot: snap }, 'throttle.re_engaged_from_snapshot');
}

restoreFromSnapshot();

/** True when the gate is closed and SDK calls must wait. */
export function isThrottled(): boolean {
  return throttled;
}

/** Read-only view of why the gate is currently closed (undefined when open). */
export function getEngageContext(): ThrottleEngageContext | undefined {
  return engageContext;
}

/**
 * Engage or release the gate. No-op when the requested state matches current
 * state. Releasing drains all pending waiters FIFO.
 */
export function setThrottled(paused: boolean, context?: ThrottleEngageContext): void {
  if (paused === throttled) {
    // Refresh context if engaging again with new info (e.g., auto-engage after operator).
    if (paused && context) {
      engageContext = context;
      persistSnapshot();
    }
    return;
  }
  throttled = paused;
  engageContext = paused ? (context ?? { engagedBy: 'operator' }) : undefined;
  persistSnapshot();
  if (!paused) {
    // Drain all waiters in FIFO order.
    const toResolve = waiters.splice(0, waiters.length);
    for (const w of toResolve) {
      if (w.signal && w.onAbort) {
        w.signal.removeEventListener('abort', w.onAbort);
      }
      w.resolve();
    }
  }
}

/**
 * Resolve immediately when the gate is open; otherwise wait until release or
 * until `abortSignal` fires. Throws `'Query aborted'` on abort so the caller
 * can treat throttle-cancel the same as any other abort.
 */
export function waitForRelease(abortSignal?: AbortSignal): Promise<void> {
  if (!throttled) return Promise.resolve();
  if (abortSignal?.aborted) {
    return Promise.reject(new Error('Query aborted'));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject };
    if (abortSignal) {
      const onAbort = (): void => {
        // Remove from queue so we don't resolve twice on subsequent release.
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error('Query aborted'));
      };
      waiter.signal = abortSignal;
      waiter.onAbort = onAbort;
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    waiters.push(waiter);
  });
}

/**
 * Process a rate-limit info payload from the Claude SDK and auto-engage or
 * auto-release the gate as appropriate. Idempotent — calling repeatedly with
 * the same info is safe.
 *
 * Engage when:
 *   - utilization >= AUTO_THROTTLE_UTILIZATION (default 0.85)
 *   - resetsAt is within AUTO_THROTTLE_LEAD_MS (default 5 min) of now
 *   - not already engaged
 *
 * Release when:
 *   - status === 'allowed'
 *   - resetsAt is in the future (fresh window)
 *   - currently engaged via auto (operator-engaged throttles stay engaged)
 *
 * `resetsAt` in the SDK is a UNIX timestamp in seconds; multiply by 1000 for ms.
 */
export function checkRateLimitAndMaybeThrottle(rateLimitInfo: Record<string, unknown>): void {
  const utilizationRaw = rateLimitInfo.utilization;
  const surpassedThresholdRaw = rateLimitInfo.surpassedThreshold;
  const resetsAtRaw = rateLimitInfo.resetsAt;
  const status = rateLimitInfo.status;
  const rateLimitType = rateLimitInfo.rateLimitType;

  const utilization = typeof utilizationRaw === 'number' ? utilizationRaw : undefined;
  const surpassedThreshold =
    typeof surpassedThresholdRaw === 'number' ? surpassedThresholdRaw : undefined;
  const resetsAtSec = typeof resetsAtRaw === 'number' ? resetsAtRaw : undefined;
  const resetsAtMs = resetsAtSec !== undefined ? resetsAtSec * 1000 : undefined;
  const now = Date.now();

  // Auto-engage: utilization threshold AND imminent reset.
  if (
    !throttled &&
    utilization !== undefined &&
    utilization >= AUTO_THROTTLE_UTILIZATION &&
    resetsAtMs !== undefined &&
    resetsAtMs - now > 0 &&
    resetsAtMs - now < AUTO_THROTTLE_LEAD_MS
  ) {
    const context: ThrottleEngageContext = {
      engagedBy: 'auto',
      resetsAt: resetsAtSec,
      utilization,
      ...(typeof rateLimitType === 'string' ? { rateLimitType } : {}),
    };
    setThrottled(true, context);
    getLog().warn(
      {
        utilization,
        surpassedThreshold,
        resetsAt: resetsAtSec,
        msUntilReset: resetsAtMs - now,
        rateLimitType,
      },
      'auto_throttle_engaged'
    );
    return;
  }

  // Auto-release: fresh window opened.
  // Only auto-release auto-engaged throttles; operator-engaged ones require
  // explicit operator release.
  if (
    throttled &&
    engageContext?.engagedBy === 'auto' &&
    status === 'allowed' &&
    resetsAtMs !== undefined &&
    resetsAtMs > now
  ) {
    // Only release if the new resetsAt is later than the one we engaged at —
    // means the window has actually rolled over.
    const engagedResetsAtMs =
      engageContext.resetsAt !== undefined ? engageContext.resetsAt * 1000 : undefined;
    if (engagedResetsAtMs === undefined || resetsAtMs > engagedResetsAtMs) {
      setThrottled(false);
      getLog().info(
        {
          newResetsAt: resetsAtSec,
          previousResetsAt: engageContext.resetsAt,
          rateLimitType,
        },
        'auto_throttle_released'
      );
    }
  }
}

/**
 * Reset internal state. Test-only — production code should not call this.
 * Resolves any pending waiters cleanly to avoid leaks across test runs.
 */
export function resetThrottleForTests(): void {
  const toResolve = waiters.splice(0, waiters.length);
  for (const w of toResolve) {
    if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    w.resolve();
  }
  throttled = false;
  engageContext = undefined;
  try {
    const path = getThrottleStatePath();
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

/** Singleton object for convenience imports. */
export const claudeProviderThrottle = {
  isThrottled,
  setThrottled,
  waitForRelease,
  checkRateLimitAndMaybeThrottle,
  getEngageContext,
};
