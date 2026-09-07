/**
 * engine-availability.ts -- runtime engine-dark tracking for router-dispatcher.
 * M-20260726-87-model-roster-indirection-and-opus-5-sweep (Cause 1).
 *
 * The bug this closes: `UNREACHABLE_ENGINES` in router-dispatcher.ts is a
 * hardcoded, compile-time, one-member set (LAN-topology only). Nothing marks
 * an engine unavailable at runtime, so when Fable ran out of subscription
 * quota the week of 2026-07-26, the router never learned to route around it
 * -- six runs, zero code (event store: 38 `node_failed` events carrying
 * "SDK returned success", 2026-07-26).
 *
 * BINDING DETECTION RULE (do not deviate; amended post-vote by the GPT seat's
 * ABSTAIN, see the motion's Ruling section): an engine is marked dark ONLY on
 * the token signature `tokens.input == 0 AND tokens.output == 0 AND cost ==
 * 0`. NEVER on the error string `SDK returned success` -- that string covers
 * at least three distinct failure classes (quota wall, pre-call infra
 * failure, SDK success-contradiction with a truncated-but-nonzero response).
 * Of the 38 production `SDK returned success` failures queried against the
 * event store, 4 had tokens flowing -- including one `sonnet` event
 * (input:6254, output:2) that under a loose error-string rule would have
 * marked Sonnet dark across every lane and taken out the workhorse tier. The
 * token-signature rule is strictly narrower and is what the board carried.
 *
 * This module intentionally does NOT touch `hasPositiveUsage` /
 * `classifyResourceExhaustedSdkResult` in dag-executor.ts. That existing code
 * answers a different question -- "should we start a long resource-exhausted
 * wait based on explicit quota text in the SDK error fields" -- and
 * deliberately refuses to treat zero-token-alone as evidence for that
 * decision (a bounded SDK-contradiction retry must not become an hours-long
 * wait). This module answers a narrower, separate question -- "should the
 * NEXT dispatch route around this engine" -- fed by the same telemetry but
 * consumed by a different caller (resolveEntryLane's ladder walk and the
 * explicit-fire refusal check). The two mechanisms coexist without
 * conflicting: a zero-token SDK-contradiction still gets its one bounded
 * node retry AND marks the engine dark for future dispatch decisions.
 *
 * SCOPE: marking is per-ENGINE (the router.yaml engine key, e.g.
 * `fable-session`), never per-node and never per-lane. A lane mixes models
 * (e.g. the fable lane's review nodes may run other providers); darkening
 * the lane would take out healthy seats. The router.yaml tier ladder is
 * already engine-keyed, so per-engine is the natural unit for
 * resolveEntryLane's ladder walk.
 *
 * EXPIRY: every mark carries a mandatory cooling-off window and auto-expires
 * -- a permanently-poisoned engine is a worse failure than the one being
 * fixed. See DEFAULT_COOLDOWN_MS for the chosen window and its
 * justification.
 *
 * PERSISTENCE: the in-memory set is the fast path consulted by the pure,
 * synchronous `resolveEntryLane` ladder walk (router-dispatcher.ts keeps its
 * "no provider/model call in the resolve path" contract -- this module has
 * zero DB/store dependency itself). Callers that DO have a WorkflowDeps.store
 * (dag-executor.ts, executor.ts) are responsible for also persisting a
 * `node_failed`-adjacent event when they call markEngineDarkIfZeroUsage /
 * markEngineDark, via recordAvailabilityEvent's returned event payload --
 * this keeps the module store-free while still making every mark/expiry
 * reconstructable from the event store, tagged to the workflow_run_id that
 * triggered it.
 */

/** A single engine's dark-mark state. */
interface EngineDarkMark {
  /** Epoch ms when the engine was marked dark. */
  markedAt: number;
  /** Epoch ms when this mark auto-expires. Always markedAt + cooldownMs. */
  expiresAt: number;
  /** workflow_run_id of the node_failed event that triggered the mark. */
  triggeringRunId: string;
  /** Node id within that run whose zero-usage failure triggered the mark. */
  triggeringNodeId: string;
  /** How many consecutive times this engine has been (re-)marked without an
   *  intervening successful call. Used only for observability; does not
   *  extend or shorten the fixed cooldown (extension-on-remark would risk
   *  the "permanently poisoned engine" failure mode the motion warns against). */
  hitCount: number;
}

/**
 * Default cooling-off window: 20 minutes.
 *
 * Justification (per the motion's open requirement -- propose a number from
 * observed quota-reset behavior, board left deliberately unset):
 *
 * - Subscription quota walls (the proven failure: Fable ran dry mid-week) do
 *   not reliably reset on a short cycle -- rolling multi-hour/day windows are
 *   typical for flat-rate subscription products. A short TTL (5 min) would
 *   thrash: re-probe the same exhausted window repeatedly, burning the exact
 *   one-node-per-attempt cost this mechanism exists to bound, for no benefit.
 * - A window long enough to matter for subscription exhaustion (hours) risks
 *   the "permanently poisoned engine" failure mode when the real cause was
 *   transient (a single pre-call infra hiccup that happened to log
 *   zero-token, not a real wall) -- 38 zero-token-adjacent events were
 *   observed in ONE week, so false positives are not rare enough to justify
 *   an hours-long sticky mark.
 * - 20 minutes is chosen as a middle ground: long enough that a real quota
 *   wall does not get re-hit by the very next dispatch (avoids the
 *   thrash/burn-one-node-repeatedly failure), short enough that a
 *   misattributed transient mark self-heals within one work session rather
 *   than silently routing around a healthy engine for the rest of the day.
 * - This is a starting number, not a tuned one -- no historical quota-reset
 *   telemetry exists yet to fit it against (Grok's design-round review could
 *   not verify the production event-store stats locally either). Revisit
 *   once real mark/expiry/re-mark events accumulate in the event store this
 *   mechanism now writes.
 */
export const DEFAULT_COOLDOWN_MS = 20 * 60 * 1000;

/** Module-level runtime state. Process-scoped (matches UNREACHABLE_ENGINES'
 *  existing module-constant pattern) -- NOT persisted across process
 *  restarts by this module. A restarted process starts with a clean slate
 *  and re-learns dark engines from the next zero-usage failure, which is the
 *  correct fail-open behavior (never worse than today's fully-blind state,
 *  and a container rebuild should not require manual un-poisoning). */
const darkEngines = new Map<string, EngineDarkMark>();

/** Token usage shape consumed by the detector. Deliberately narrow (not
 *  imported from dag-executor.ts) to keep this module dependency-free. */
export interface TokenUsageLike {
  input?: number;
  output?: number;
  total?: number;
}

/** Result of a mark attempt / expiry sweep, for callers to persist as an
 *  event-store row. `null` when no state change occurred. */
export interface AvailabilityEventPayload {
  event: 'engine_marked_dark' | 'engine_mark_expired';
  engine: string;
  markedAt: string;
  expiresAt: string;
  cooldownMs: number;
  hitCount: number;
  triggeringRunId?: string;
  triggeringNodeId?: string;
}

/**
 * BINDING DETECTION RULE: true only when tokens.input == 0 AND
 * tokens.output == 0 AND cost == 0. Never derived from an error message.
 * `total` is honored only when both input and output are also present and
 * zero (a total-only shape with no input/output breakdown is not proof of a
 * hard zero on both counters); when input/output are absent entirely this
 * returns false -- absence of usage data is not evidence of zero usage.
 */
export function isZeroUsageSignature(
  tokens: TokenUsageLike | undefined,
  cost: number | undefined
): boolean {
  if (!tokens) return false;
  if (tokens.input === undefined || tokens.output === undefined) return false;
  const zeroTokens = tokens.input === 0 && tokens.output === 0;
  const zeroCost = cost === undefined || cost === 0;
  return zeroTokens && zeroCost;
}

/**
 * Mark an engine dark if-and-only-if the token signature matches the binding
 * rule. No-op (returns null) on any other failure shape -- a quality
 * failure, a transient error with partial usage, or an SDK-contradiction
 * with nonzero tokens all climb/retry through existing machinery unchanged.
 *
 * Idempotent-ish: re-marking a still-dark engine refreshes markedAt/expiresAt
 * to NOW + cooldownMs (does not stack/extend beyond one cooldown window) and
 * increments hitCount for observability.
 */
export function markEngineDarkIfZeroUsage(
  engine: string,
  tokens: TokenUsageLike | undefined,
  cost: number | undefined,
  context: { runId: string; nodeId: string },
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  now: number = Date.now()
): AvailabilityEventPayload | null {
  if (!isZeroUsageSignature(tokens, cost)) return null;

  const prior = darkEngines.get(engine);
  const hitCount = (prior?.hitCount ?? 0) + 1;
  const mark: EngineDarkMark = {
    markedAt: now,
    expiresAt: now + cooldownMs,
    triggeringRunId: context.runId,
    triggeringNodeId: context.nodeId,
    hitCount,
  };
  darkEngines.set(engine, mark);

  return {
    event: 'engine_marked_dark',
    engine,
    markedAt: new Date(mark.markedAt).toISOString(),
    expiresAt: new Date(mark.expiresAt).toISOString(),
    cooldownMs,
    hitCount,
    triggeringRunId: context.runId,
    triggeringNodeId: context.nodeId,
  };
}

/**
 * True when `engine` is currently marked dark AND the mark has not expired.
 * Expiry is evaluated lazily here (no background timer) -- an expired mark
 * is treated as available without requiring a separate sweep, though callers
 * that want an explicit expiry event for the log should call
 * sweepExpiredMarks() periodically or before reading isEngineDark in a
 * user-facing path.
 */
export function isEngineDark(engine: string, now: number = Date.now()): boolean {
  const mark = darkEngines.get(engine);
  if (!mark) return false;
  return mark.expiresAt > now;
}

/**
 * Remove all marks whose cooldown has elapsed and return an expiry event
 * payload for each, so callers can persist "why did this engine become
 * available again" to the event store. Mandatory per the motion: "every
 * mark and expiry writes to the event store."
 */
export function sweepExpiredMarks(now: number = Date.now()): AvailabilityEventPayload[] {
  const expired: AvailabilityEventPayload[] = [];
  for (const [engine, mark] of darkEngines.entries()) {
    if (mark.expiresAt <= now) {
      darkEngines.delete(engine);
      expired.push({
        event: 'engine_mark_expired',
        engine,
        markedAt: new Date(mark.markedAt).toISOString(),
        expiresAt: new Date(mark.expiresAt).toISOString(),
        cooldownMs: mark.expiresAt - mark.markedAt,
        hitCount: mark.hitCount,
        triggeringRunId: mark.triggeringRunId,
        triggeringNodeId: mark.triggeringNodeId,
      });
    }
  }
  return expired;
}

/** Snapshot of all currently-dark engines (non-expired), for diagnostics /
 *  the explicit-fire refusal check. Evaluates expiry lazily like
 *  isEngineDark -- does not mutate state or emit expiry events (call
 *  sweepExpiredMarks for that). */
export function listDarkEngines(now: number = Date.now()): string[] {
  return [...darkEngines.entries()]
    .filter(([, mark]) => mark.expiresAt > now)
    .map(([engine]) => engine);
}

/** Test-only: clear all runtime state. Never called from production code. */
export function resetEngineAvailabilityForTests(): void {
  darkEngines.clear();
}

/**
 * Map a node's (provider, declared model) pair to the router.yaml engine key
 * it corresponds to, so a node-level zero-usage failure can mark the right
 * router-layer engine dark. These are genuinely two different vocabularies
 * (confirmed in the M-87 design-round review: router.yaml engines like
 * `fable-session` are a routing-layer concept; `provider` + `model:` pins on
 * a node are an execution-layer concept) -- this table is the intentional,
 * explicit bridge between them. Returns undefined for provider/model
 * combinations with no corresponding router engine (e.g. a review node
 * running a different model within a lane); callers should no-op rather than
 * inventing a synthetic engine key.
 *
 * Extend this table when router.yaml gains new engines. Keep in sync with
 * config/router.yaml's tiers[].engines and router-dispatcher.ts's
 * DEFAULT_ENGINE_TO_LANE keys.
 */
const PROVIDER_MODEL_TO_ROUTER_ENGINE: readonly {
  provider: string;
  /** Exact declared model id, or a prefix match when it ends with '*'. */
  model: string;
  engine: string;
}[] = [
  { provider: 'claude', model: 'claude-fable-5', engine: 'fable-session' },
  { provider: 'claude', model: 'claude-sonnet-*', engine: 'sonnet-subscription' },
  { provider: 'claude', model: 'sonnet', engine: 'sonnet-subscription' },
  { provider: 'claude', model: 'claude-opus-*', engine: 'opus-api' },
  { provider: 'claude', model: 'opus', engine: 'opus-api' },
  { provider: 'claude', model: 'opus[1m]', engine: 'opus-api' },
  { provider: 'claude', model: 'claude-haiku-*', engine: 'claude-haiku-api' },
  { provider: 'claude', model: 'haiku', engine: 'claude-haiku-api' },
  { provider: 'codex', model: '*', engine: 'codex-subscription' },
  { provider: 'codex-native-strict', model: '*', engine: 'codex-subscription' },
];

export function resolveRouterEngine(
  provider: string,
  declaredModelId: string | undefined
): string | undefined {
  const model = declaredModelId ?? '';
  for (const entry of PROVIDER_MODEL_TO_ROUTER_ENGINE) {
    if (entry.provider !== provider) continue;
    if (entry.model === '*') return entry.engine;
    if (entry.model.endsWith('*')) {
      if (model.startsWith(entry.model.slice(0, -1))) return entry.engine;
      continue;
    }
    if (entry.model === model) return entry.engine;
  }
  return undefined;
}

/**
 * Cause 2 (explicit-lane availability check): given a lane workflow name and
 * the engine -> lane map (router-dispatcher.ts's DEFAULT_ENGINE_TO_LANE),
 * return true only when EVERY engine that maps to this lane is currently
 * dark. A lane with even one healthy engine is not refused -- the explicit
 * fire still wins (John's ruling: operators must be able to force a lane),
 * this only stops burning a run against a lane whose ENTIRE engine set is
 * known-dark for its cooldown window.
 *
 * A lane with no engines mapped to it at all (not present as any value in
 * engineToLane) is never considered dark by this check -- absence of a
 * routing-layer mapping is not evidence of unavailability; only an actual
 * dark mark is.
 */
export function isLaneFullyDark(
  workflowName: string,
  engineToLane: Readonly<Record<string, string | null>>,
  now: number = Date.now()
): boolean {
  const engines = Object.entries(engineToLane)
    .filter(([, lane]) => lane === workflowName)
    .map(([engine]) => engine);
  if (engines.length === 0) return false;
  return engines.every(engine => isEngineDark(engine, now));
}
