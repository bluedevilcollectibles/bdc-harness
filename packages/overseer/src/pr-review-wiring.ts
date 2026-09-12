/**
 * Real dependency composition for the PR-event review route
 * (WO-HARNESS-OVERSEER-REVIEW-ROUTE-01; route registration authorized by XO
 * 2026-08-17).
 *
 * `pr-review-ingest.ts` is pure and injectable by design. This module is the
 * ONLY place its abstract dependencies are bound to real infrastructure:
 * the existing `agent_dispatch_messages` queue and the existing overseer
 * audit tables. Keeping the binding here means the ingest logic stays
 * hermetically testable while the wiring itself remains small enough to read.
 *
 * ACTIVATION IS STILL EXPLICIT. Registering the route does not enable it:
 * `resolveReviewRouteConfig` returns null unless BOTH the webhook secret and
 * the reviewer identity are configured, and the route refuses to accept
 * events when it is not configured. Enabling the App's `pull_request` event
 * subscription remains a separate, external step.
 */
import { randomUUID } from 'node:crypto';
import * as dispatch from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';
import {
  createRealFetchExactHeadPullRequestEvidence,
  createRealOctokitClient,
  createRealReadOnlyPatOctokitClient,
  createRealSubmitPullRequestReview,
  summarizeChecks,
} from './adapters/github-real-deps';
import type { ExactHeadPullRequestEvidence } from './adapters/github-real-deps.ts';
import {
  MAX_REREVIEW_ATTEMPTS_ENV,
  MAX_TOTAL_REREVIEWS_ENV,
  isAutoRereviewReason,
  resolveMaxRereviewAttempts,
  resolveMaxTotalRereviews,
} from './pr-review-ingest';
import type { IngestDeps, PriorReviewWork } from './pr-review-ingest.ts';
import {
  configuredReviewIdentity,
  checksAreTerminal,
  evaluatePullRequest,
  invokeConfiguredReviewModel,
  reviewErrorCode,
} from './pr-review-evaluator';
import type { PrReviewDeps, PrReviewInput, PrReviewResult } from './pr-review-evaluator';
import type { ReviewerVerdict, SubmitDeps } from './pr-review-submit.ts';

/** Env var carrying the shared GitHub webhook secret for the review route. */
export const REVIEW_WEBHOOK_SECRET_ENV = 'OVERSEER_REVIEW_WEBHOOK_SECRET';
/** Env var naming the reviewer bot identity, e.g. 'thinman-overseer[bot]'. */
export const REVIEW_REVIEWER_IDENTITY_ENV = 'OVERSEER_REVIEW_IDENTITY';
const REVIEW_WEBHOOK_SECRET_FALLBACK_ENV = 'WEBHOOK_SECRET';
const REVIEW_REVIEWER_IDENTITY_FALLBACK_ENV = 'MERGE_MANAGER_REVIEW_GATE_LOGIN';
const REVIEW_REVIEWER_IDENTITY_DEFAULT = 'thinman-overseer[bot]';

/** Code-fixed Overseer sender that owns queued review work. */
export const REVIEW_SENDER = 'overseer';
const log = createLogger('overseer/pr-review-wiring');

export const REVIEW_RECIPIENT = 'overseer-reviewer';

export interface ReviewRouteConfig {
  webhookSecret: string;
  reviewerIdentity: string;
}

/** Fail-closed CI-green decision shared by the production binding and tests. */
export function isExactHeadCiGreen(evidence: ExactHeadPullRequestEvidence): boolean {
  const summary = summarizeChecks(evidence.checks);
  return (
    checksAreTerminal(evidence.checks, evidence.requiredContexts) &&
    summary.failed === 0 &&
    summary.pending === 0
  );
}

/**
 * Resolves route configuration from the environment. Returns null when the
 * route is not configured, which the caller MUST treat as "do not register /
 * do not accept" rather than as a default-open condition.
 */
export function resolveReviewRouteConfig(
  env: Record<string, string | undefined> = process.env
): ReviewRouteConfig | null {
  const webhookSecret =
    env[REVIEW_WEBHOOK_SECRET_ENV]?.trim() ?? env[REVIEW_WEBHOOK_SECRET_FALLBACK_ENV]?.trim() ?? '';
  const reviewerIdentity =
    env[REVIEW_REVIEWER_IDENTITY_ENV]?.trim() ??
    env[REVIEW_REVIEWER_IDENTITY_FALLBACK_ENV]?.trim() ??
    REVIEW_REVIEWER_IDENTITY_DEFAULT;
  if (!webhookSecret || !reviewerIdentity) return null;
  return { webhookSecret, reviewerIdentity };
}

/** Body persisted on the queued review work item. */
export interface ReviewWorkBody {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  author: string;
  headCiGreen: boolean;
}

export function parseReviewWorkBody(body: string): ReviewWorkBody | null {
  try {
    const value = JSON.parse(body) as Partial<ReviewWorkBody>;
    if (
      typeof value.owner !== 'string' ||
      typeof value.repo !== 'string' ||
      typeof value.prNumber !== 'number' ||
      typeof value.headSha !== 'string'
    ) {
      return null;
    }
    return {
      owner: value.owner,
      repo: value.repo,
      prNumber: value.prNumber,
      headSha: value.headSha,
      baseRef: typeof value.baseRef === 'string' ? value.baseRef : '',
      author: typeof value.author === 'string' ? value.author : '',
      headCiGreen: value.headCiGreen === true,
    };
  } catch {
    return null;
  }
}

/**
 * Subject key for a PR's review work. Head-independent on purpose: it groups
 * every review attempt for one pull request so stale-head lookup can find
 * prior attempts regardless of which commit they were bound to.
 *
 * MUST match the shape createAuthenticatedMessage/listMessages enforce via
 * normalizeDispatchSubjectKey: 'wo:WO-XXX' or 'gh:owner/repo#123' -- any
 * other shape throws dispatch_subject_key_invalid:shape and every enqueue
 * fails. Integration-test finding (2026-08-19): the original
 * 'pr-review:owner/repo#N' prefix was never a valid shape; 'gh:' is the
 * correct form for a GitHub PR/issue reference and is used verbatim.
 */
export function reviewSubjectKey(owner: string, repo: string, prNumber: number): string {
  return `gh:${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Head-independent prefix of every review correlation id for one PR.
 *
 * `reviewCorrelationId` produces `pr-review:owner/repo#N@<head>`; trimming the
 * head yields the group key. This is the ONLY identifier legacy submit
 * receipts carry that ties them to a pull request, which is what makes the
 * fallback below possible.
 */
export function reviewCorrelationPrefix(owner: string, repo: string, prNumber: number): string {
  return `pr-review:${owner}/${repo}#${prNumber}@`;
}

interface PriorVerdict {
  verdict: PriorReviewWork['verdict'];
  verdictId: string;
}

function classifyVerdict(disposition: string | undefined): PriorReviewWork['verdict'] {
  if (disposition === 'approved') return 'approved';
  if (disposition === 'changes_requested') return 'changes_requested';
  return 'other';
}

/**
 * Folds submit receipts into a messageId -> verdict map.
 *
 * `receipts` MUST arrive newest-first: the first receipt seen for a message
 * wins, so an older failed attempt cannot overwrite a later, authoritative
 * submission verdict. Entries already present are never replaced, which also
 * makes the legacy pass below strictly additive -- a subject_key-bearing
 * receipt always outranks a legacy one for the same message.
 */
function collectVerdicts(
  receipts: { id: string; body: string }[],
  into: Map<string, PriorVerdict>
): Map<string, PriorVerdict> {
  for (const receipt of receipts) {
    try {
      const body = JSON.parse(receipt.body) as {
        kind?: string;
        messageId?: string;
        disposition?: string;
      };
      if (body.kind !== 'pr_review_submit_receipt' || !body.messageId) continue;
      if (into.has(body.messageId)) continue;
      into.set(body.messageId, {
        verdict: classifyVerdict(body.disposition),
        verdictId: receipt.id,
      });
    } catch {
      // Malformed and unrelated reports are not verdict evidence.
    }
  }
  return into;
}

/**
 * Comment pages scanned when looking for the cap-exhausted marker (#803 review).
 *
 * Five pages is 500 comments, well past any real PR thread (the longest in this
 * org is under 200), and bounds the scan so a pathological thread cannot spend
 * the rate budget. The scan stops early on the first short page, so the normal
 * cost is one call. Running out of pages without finding the marker falls
 * through to posting, which is the safe direction: a duplicate comment is
 * recoverable, a block nobody was told about is the bug being fixed.
 */
export const CAP_COMMENT_MAX_COMMENT_PAGES = 5;

/**
 * Durable per-head key that decides which caller posts the cap comment.
 *
 * `attempt` exists so a claim can be RELEASED (#803 review 2). The dispatch
 * store has no delete, and cancelling a message is reserved for real
 * cancellation -- so "release" is implemented by advancing to the next key.
 * The failed attempt's row stays as an audit trail of the attempt that did not
 * post, and the next delivery claims a key nobody holds.
 */
export function capCommentIdempotencyKey(
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  },
  attempt = 0
): string {
  const base = `pr-review-rereview-cap-comment:${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}`;
  return attempt === 0 ? base : `${base}:retry${attempt}`;
}

/**
 * How many claim attempts one head may burn before the claim stops being the
 * gate (#803 review 2).
 *
 * Past this, `claimCapCommentViaDispatch` returns true unconditionally and the
 * paginated marker scan is the only guard. That is the correct trade: after
 * several failures the risk of a duplicate comment is far smaller than the risk
 * of a head that is permanently silent, and the marker scan still prevents the
 * duplicate in every case where the earlier comment actually landed.
 */
export const CAP_COMMENT_MAX_CLAIM_ATTEMPTS = 5;

/**
 * Per-process MEMO of the durable attempt count -- an optimisation, never the
 * source of truth.
 *
 * Review finding (Overseer, #803 review 3): this map WAS the record. The claim
 * rows it counted are durable, so after `createComment` failed, a retry picked
 * up by another worker or after a restart started again at attempt 0 -- an
 * idempotency key already held by the abandoned claim. That retry always loses,
 * and the head is never announced: exactly the silent block this path exists to
 * end. The count is now derived from the dispatch store (see
 * `currentCapCommentAttempt`); this map only caches what that read returned.
 */
const capCommentClaimAttempts = new Map<string, number>();

/** Test seam: forget every cached attempt count. */
export function resetCapCommentClaimAttempts(): void {
  capCommentClaimAttempts.clear();
}

/**
 * How many claim attempts this head has already burned, read from the DURABLE
 * dispatch rows rather than process memory.
 *
 * Every claim writes one row whose `idempotency_key` is
 * `<base>` for attempt 0 and `<base>:retry<n>` thereafter, all sharing the
 * head's `subject_key`. Counting the retry keys that exist therefore
 * reconstructs the attempt number on any worker, after any restart.
 *
 * A read failure falls back to the cached in-memory value rather than throwing:
 * the caller's own catch already treats a broken claim store as "post anyway",
 * and staying silent is the worse failure.
 */
export async function currentCapCommentAttempt(
  input: CapCommentInput,
  // Seam: the durable read. Defaults to the live dispatch store; a test supplies
  // the rows a prior process would have left behind, which is the only way to
  // exercise recovery without a database.
  listClaims: (filters: {
    recipient: string;
    subject_key: string;
    limit?: number;
  }) => Promise<{ idempotency_key: string }[]> = dispatch.listMessages
): Promise<number> {
  const base = capCommentIdempotencyKey(input);
  const cached = capCommentClaimAttempts.get(base) ?? 0;
  try {
    const rows = await listClaims({
      recipient: 'operator',
      subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
      limit: CAP_COMMENT_MAX_CLAIM_ATTEMPTS + 1,
    });
    let durable = 0;
    for (const row of rows) {
      const key = row.idempotency_key;
      if (typeof key !== 'string' || !key.startsWith(base)) continue;
      if (key === base) {
        durable = Math.max(durable, 1);
        continue;
      }
      const retry = /^:retry(\d+)$/.exec(key.slice(base.length));
      if (retry) durable = Math.max(durable, Number(retry[1]) + 1);
    }
    // The durable rows and the local memo can disagree only when a write landed
    // that this process did not make; the higher value is the safe one, because
    // reusing a held key guarantees a lost claim.
    const attempt = Math.max(durable, cached);
    capCommentClaimAttempts.set(base, attempt);
    return attempt;
  } catch {
    return cached;
  }
}

/** Correlation prefix the claim's winning nonce is appended to. */
export function capCommentCorrelationPrefix(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): string {
  return `${capCommentIdempotencyKey(input)}:`;
}

/**
 * Search the PR's comments for the per-head marker, PAGINATED.
 *
 * Review finding (Overseer, PR #803): scanning a single 100-comment page misses
 * a marker on any thread longer than that -- and a PR that has already burned
 * three re-review rounds is precisely the long-thread case.
 */
async function hasMarkerComment(
  octokit: ReturnType<typeof createRealOctokitClient>,
  input: { owner: string; repo: string; prNumber: number; marker: string }
): Promise<boolean> {
  const issues = octokit.issues;
  if (!issues?.listComments) return false;
  for (let page = 1; page <= CAP_COMMENT_MAX_COMMENT_PAGES; page += 1) {
    // Called through the object, not via a detached reference: Octokit's
    // endpoint methods are bound to their client.
    const response = await issues.listComments({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.prNumber,
      per_page: 100,
      page,
    });
    if (response.data.some(comment => (comment.body ?? '').includes(input.marker))) return true;
    if (response.data.length < 100) return false;
  }
  return false;
}

export interface CapCommentInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  body: string;
  marker: string;
}

export interface CapCommentSeams {
  octokit: () => ReturnType<typeof createRealOctokitClient>;
  /**
   * Claim the exclusive right to post this head's comment. Returns true for
   * EXACTLY ONE caller across every process, or true for all callers when the
   * claim store itself is unavailable (see the fallback rationale below).
   */
  claim: (input: CapCommentInput) => Promise<boolean>;
  /**
   * Give the claim back when this call failed to post (#803 review 2).
   *
   * Without it a claim taken and then abandoned silences the head forever: the
   * next delivery loses the claim, skips GitHub, and no comment ever appears.
   * Best-effort -- a release that itself fails leaves the marker scan as the
   * recovery path once the comment does eventually land.
   */
  releaseClaim: (input: CapCommentInput) => Promise<void>;
}

/**
 * ONE COMMENT PER HEAD, enforced by TWO independent mechanisms (#803 review).
 *
 * Review finding (Overseer, PR #803): a single 100-comment page plus a
 * list-then-create sequence guarantees nothing. A long PR pushes the marker off
 * page one, and two concurrent webhook deliveries both read "absent" before
 * either writes.
 *
 * 1. A DURABLE CLAIM decides the winner. `agent_dispatch_messages` has a UNIQUE
 *    idempotency_key and inserts ON CONFLICT DO NOTHING, so exactly one caller
 *    can claim a given per-head key. This is the race fix, and unlike a
 *    process-local lock it holds across worker processes and restarts.
 * 2. A PAGINATED MARKER SEARCH decides whether one already exists, covering the
 *    case the reviewer named: a marker beyond the first page.
 *
 * Either alone is insufficient. Together, a duplicate needs the claim row AND
 * every scanned page of comments to be wrong at the same moment.
 *
 * Extracted from the deps object so both halves are testable without a GitHub
 * credential -- the seams are the only reason this is a free function.
 */
export async function postCapExhaustedCommentWith(
  seams: CapCommentSeams,
  input: CapCommentInput
): Promise<{ posted: boolean }> {
  // ORDER MATTERS, and this order is the fix for a second review finding
  // (Overseer, PR #803, second pass).
  //
  // The first cut took the claim FIRST and never released it. Every path after
  // that point could return without posting -- a client missing `listComments`,
  // a throw from the marker scan, a throw from `createComment` -- and the claim
  // stayed taken. The next delivery then LOST the claim, skipped GitHub, and
  // returned `posted: false`, so the cap-exhaustion notice was permanently
  // invisible for that head. A guard against duplicate comments had become a
  // guarantee of NO comment, which is strictly worse than the duplicate: an
  // un-announced block is the entire defect #797 exists to fix.
  //
  // Now: the MARKER SCAN is the pre-check (it is the durable, self-healing
  // source of truth -- the comment either exists on the PR or it does not), the
  // claim is only the RACE BREAKER between simultaneous deliveries, and it is
  // RELEASED whenever this call fails to post, so a later delivery retries.
  const octokit = seams.octokit();
  // `listComments` is optional on the narrow client interface; without it we
  // cannot prove absence, and posting blind would risk spamming the thread --
  // so we decline rather than duplicate. No claim has been taken yet, so a
  // client that regains the method later still posts.
  if (!octokit.issues?.listComments || !octokit.issues?.createComment) {
    return { posted: false };
  }
  if (await hasMarkerComment(octokit, input)) return { posted: false };

  // Race breaker: exactly one concurrent delivery proceeds past here.
  if (!(await seams.claim(input))) return { posted: false };

  try {
    await octokit.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.prNumber,
      body: input.body,
    });
  } catch (error) {
    // RELEASE, then rethrow. Holding the claim through a transient GitHub
    // failure is what made the notice permanently invisible; releasing it means
    // the next delivery re-scans (finding no marker) and tries again.
    await seams.releaseClaim(input);
    throw error;
  }
  return { posted: true };
}

/**
 * The durable claim, backed by the dispatch store's UNIQUE idempotency_key.
 *
 * The insert RETURNS a row only for the winner; a loser is handed the EXISTING
 * row back, whose correlation_id carries the winner's nonce -- so comparing the
 * returned correlation id against this call's own nonce identifies the winner
 * without needing the DAL to report which branch it took.
 */
export async function claimCapCommentViaDispatch(input: CapCommentInput): Promise<boolean> {
  const attempt = await currentCapCommentAttempt(input);
  // Past the attempt bound the claim stops gating: a permanently silent head is
  // a worse outcome than a possible duplicate, and the marker scan still
  // catches the duplicate whenever the earlier comment landed.
  if (attempt >= CAP_COMMENT_MAX_CLAIM_ATTEMPTS) return true;
  const nonce = randomUUID();
  try {
    const claim = await dispatch.createAuthenticatedMessage(
      { kind: 'system', sender: REVIEW_SENDER },
      {
        correlation_id: `${capCommentCorrelationPrefix(input)}${nonce}`,
        idempotency_key: capCommentIdempotencyKey(input, attempt),
        task_type: 'run_report',
        recipient: 'operator',
        subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
        body: JSON.stringify({
          kind: 'pr_review_rereview_cap_comment_claim',
          owner: input.owner,
          repo: input.repo,
          prNumber: input.prNumber,
          headSha: input.headSha,
          nonce,
        }),
      }
    );
    return claim?.correlation_id?.endsWith(nonce) ?? false;
  } catch {
    // The claim store is unavailable. Fall back to the marker search alone
    // rather than staying silent: an UN-ANNOUNCED BLOCK is the defect this
    // whole path exists to fix, and a rare duplicate comment is a far smaller
    // harm than a PR the reviewer quietly stopped answering.
    return true;
  }
}

/**
 * Release a claim taken by `claimCapCommentViaDispatch` (#803 review 2).
 *
 * Advances this head's attempt counter so the NEXT claim uses a fresh
 * idempotency key that nobody holds. The abandoned row is left in place as the
 * audit record of an attempt that did not post -- the dispatch store has no
 * delete, and cancelling a message is reserved for genuine cancellation
 * (XO doctrine: never cancel a message merely to clear bookkeeping).
 */
export async function releaseCapCommentClaimViaDispatch(input: CapCommentInput): Promise<void> {
  const key = capCommentIdempotencyKey(input);
  // Advance the LOCAL memo so an immediate in-process retry skips the key it
  // just abandoned without paying for another store read. Recovery on a
  // different worker or after a restart does not depend on this line -- the
  // abandoned row itself is the durable record, and `currentCapCommentAttempt`
  // counts it. This is a fast path, not the mechanism.
  const attempt = await currentCapCommentAttempt(input);
  capCommentClaimAttempts.set(key, attempt + 1);
}

/**
 * Binds the pure ingest dependencies to the live dispatch queue.
 *
 * Reuses `agent_dispatch_messages` with `task_type: 'run_review'`. Its UNIQUE
 * `idempotency_key` is what makes a duplicate webhook delivery a no-op rather
 * than a second queued review, so dedupe is enforced by the database, not by
 * application logic that could race.
 */
export function createRealIngestDeps(config: ReviewRouteConfig): IngestDeps {
  // #797: the automatic re-review budget is now configurable, so the EFFECTIVE
  // value has to be visible at boot. An operator debugging a PR that stopped
  // getting reviews should be able to read the cap out of the container log
  // rather than inferring it from source.
  const maxRereviewAttempts = resolveMaxRereviewAttempts();
  const maxTotalRereviews = resolveMaxTotalRereviews();
  log.info(
    {
      maxRereviewAttempts,
      maxTotalRereviews,
      source: process.env[MAX_REREVIEW_ATTEMPTS_ENV] ? MAX_REREVIEW_ATTEMPTS_ENV : 'default',
      totalSource: process.env[MAX_TOTAL_REREVIEWS_ENV] ? MAX_TOTAL_REREVIEWS_ENV : 'default',
    },
    'overseer.pr_review.rereview_budget_configured'
  );
  return {
    webhookSecret: config.webhookSecret,
    reviewerIdentity: config.reviewerIdentity,

    async isHeadCiGreen(input): Promise<boolean> {
      const evidence = await createRealFetchExactHeadPullRequestEvidence(
        createRealOctokitClient(),
        createRealReadOnlyPatOctokitClient() ?? undefined
      )(input);
      return isExactHeadCiGreen(evidence);
    },

    async postCapExhaustedComment(input): Promise<{ posted: boolean }> {
      return postCapExhaustedCommentWith(
        {
          // The client is built HERE, not at deps-construction time.
          // `createRealOctokitClient` throws without GH_TOKEN, and ingest has
          // always been constructible without one -- the integration suite
          // builds these deps against a real SqliteAdapter and no GitHub
          // credential. Constructing eagerly would make every ingest path
          // require a token to exist at all.
          octokit: () => createRealOctokitClient(),
          claim: claimCapCommentViaDispatch,
          releaseClaim: releaseCapCommentClaimViaDispatch,
        },
        input
      );
    },

    async listPriorReviewWork(input): Promise<PriorReviewWork[]> {
      const subjectKey = reviewSubjectKey(input.owner, input.repo, input.prNumber);
      // listMessages supports subject_key natively -- filter in the query
      // rather than pulling the whole recipient queue into memory.
      const messages = await dispatch.listMessages({
        recipient: REVIEW_RECIPIENT,
        subject_key: subjectKey,
      });
      // listMessages orders subject_key queries newest-first, which is what
      // collectVerdicts requires.
      const receipts = await dispatch.listMessages({
        recipient: 'operator',
        subject_key: subjectKey,
      });
      const verdictByMessageId = collectVerdicts(receipts, new Map<string, PriorVerdict>());

      // LEGACY FALLBACK. Review finding (Overseer, PR #772): subject_key on
      // submit receipts is NEW in this change -- recordReceipt did not persist
      // it before. So every receipt written prior to deployment is invisible
      // to the query above, and the completed CHANGES_REQUESTED reviews that
      // exist today -- precisely the historical cases this change intends to
      // repair -- could not authorize an automatic re-review at all.
      //
      // Legacy receipts do carry `correlation_id`
      // (`pr-review:owner/repo#N@<head>`), so they are still attributable to a
      // PR. Only pay for this lookup when the indexed query left work
      // unexplained, and never let it override a subject_key-bearing receipt
      // (collectVerdicts keeps the first entry per message).
      //
      // The prefix match runs IN SQL. A client-side scan of a listMessages
      // page cannot work here: listMessages hard-caps limit at 500 and offers
      // no offset or cursor, while the live store holds ~2,700 queued operator
      // rows (bdc-harness #761 backlog) plus completed ones. A genuinely old
      // CHANGES_REQUESTED receipt therefore sits well outside any single page
      // -- which is precisely the receipt this fallback exists to find.
      const needsLegacyLookup = messages.some(message => !verdictByMessageId.has(message.id));
      if (needsLegacyLookup) {
        // Already newest-first from the DAL, as collectVerdicts requires.
        const legacy = await dispatch.listMessagesByCorrelationPrefixWithoutSubjectKey({
          recipient: 'operator',
          correlationPrefix: reviewCorrelationPrefix(input.owner, input.repo, input.prNumber),
        });
        collectVerdicts(legacy, verdictByMessageId);
      }

      return messages
        .map(message => {
          const body = parseReviewWorkBody(message.body);
          return {
            messageId: message.id,
            headSha: body?.headSha ?? '',
            status: message.status,
            verdict: verdictByMessageId.get(message.id)?.verdict ?? null,
            verdictId: verdictByMessageId.get(message.id)?.verdictId ?? null,
            // Only a reason THIS module stamped counts toward the attempt cap.
            // repeat_reason is shared free text (legacy `review_exact_head:`
            // rows, Taskmaster nudges, hand-written operator requests), so
            // `!== null` would exhaust the budget on rows that were never
            // automatic re-reviews. See AUTO_REREVIEW_REASON_PREFIX.
            isAutoRereview: isAutoRereviewReason(message.repeat_reason),
            headCiGreen: body?.headCiGreen === true,
          };
        })
        .filter((work): work is PriorReviewWork => work.headSha !== '');
    },

    async cancelReviewWork(input): Promise<string[]> {
      const cancelled: string[] = [];
      for (const messageId of input.messageIds) {
        try {
          // cancelMessage enforces sender match: only the principal that
          // queued the work may cancel it, which is why REVIEW_SENDER is
          // passed rather than an operator identity. It returns a structured
          // result ({ok:false, reason:'terminal'|'actor_mismatch'|...})
          // instead of throwing on a refusal.
          const result = await dispatch.cancelMessage({ id: messageId, sender: REVIEW_SENDER });
          if (result.ok) cancelled.push(messageId);
        } catch {
          // A message that cannot be cancelled (already terminal, or claimed
          // under a newer fence) is not fatal to ingest: the new work item is
          // still bound to the current head. Report only what was ACTUALLY
          // invalidated so the receipt stays honest.
        }
      }
      return cancelled;
    },

    async enqueueReviewWork(input): Promise<{ messageId: string; alreadyExisted: boolean }> {
      const body: ReviewWorkBody = {
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseRef: input.baseRef,
        author: input.author,
        headCiGreen: input.headCiGreen,
      };
      const subjectKey = reviewSubjectKey(input.owner, input.repo, input.prNumber);
      // createAuthenticatedMessage is idempotent on idempotency_key: it returns the
      // EXISTING row rather than inserting a duplicate. To report the replay
      // honestly we look for a prior row bound to this exact head BEFORE
      // creating, rather than inferring it after the fact.
      const prior = await dispatch.listMessages({
        recipient: REVIEW_RECIPIENT,
        subject_key: subjectKey,
      });
      const alreadyExisted = prior.some(
        message => parseReviewWorkBody(message.body)?.headSha === input.headSha
      );
      const message = await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId,
          idempotency_key: input.idempotencyKey,
          task_type: 'run_review',
          recipient: REVIEW_RECIPIENT,
          body: JSON.stringify(body),
          subject_key: subjectKey,
          repeat_reason: input.repeatReason,
        }
      );
      return { messageId: message.id, alreadyExisted };
    },

    async recordReceipt(input): Promise<void> {
      // Receipts ride the same durable store as the work itself. A receipt is
      // never allowed to fail the ingest path (the caller wraps this), but it
      // must be attempted for every terminal disposition.
      await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId || `pr-review-receipt:${input.deliveryId}`,
          idempotency_key: `pr-review-receipt:${input.deliveryId}:${input.disposition}`,
          task_type: 'run_report',
          recipient: 'operator',
          body: JSON.stringify({
            kind: 'pr_review_ingest_receipt',
            deliveryId: input.deliveryId,
            owner: input.owner,
            repo: input.repo,
            prNumber: input.prNumber,
            headSha: input.headSha,
            disposition: input.disposition,
            reason: input.reason ?? null,
            messageId: input.messageId ?? null,
          }),
        }
      );
    },
  };
}

interface RealSubmitWiringOverrides {
  octokit?: ReturnType<typeof createRealOctokitClient>;
  /**
   * PAT-identity client used only as the second identity for the
   * branch-protection required-contexts lookup the App cannot read. Pass `null`
   * to assert "no PAT identity" explicitly (tests); omit to resolve from env.
   */
  patOctokit?: ReturnType<typeof createRealOctokitClient> | null;
  reviewerModel?: string;
  evaluate?: (input: PrReviewInput, deps: PrReviewDeps) => Promise<PrReviewResult>;
  invokeModel?: PrReviewDeps['invokeModel'];
}

const INDETERMINATE_REVIEW_SUMMARY =
  'The independent review could not reach a determinate verdict. No approval was issued.';

/**
 * The body posted on the PR when the required status-check contexts could not
 * be read after the attempt bound (#775).
 *
 * It states the attempt count and whether the cause was a PERMISSION or a
 * TRANSIENT fault, because those need different human actions: grant the App
 * the branch-protection scope (or supply GH_TOKEN / OVERSEER_REQUIRED_CONTEXTS_JSON)
 * versus wait out a GitHub API fault. It says explicitly that the PR is BLOCKED
 * and NOT approved, so nobody reads a comment-only review as a soft pass.
 */
export function buildRequiredContextsBlockedSummary(error: string | undefined): string {
  const attemptsMatch = /attempts=(\d+)/.exec(error ?? '');
  const attempts = attemptsMatch?.[1] ?? 'the configured number of';
  const reasonMatch = /reason=(permission|transient)/.exec(error ?? '');
  const reason = reasonMatch?.[1] ?? 'transient';
  const remedy =
    reason === 'permission'
      ? 'The reviewing identity lacks permission to read branch protection. Grant the Overseer GitHub App the branch-protection read scope, provide a PAT via GH_TOKEN, or declare the contexts with OVERSEER_REQUIRED_CONTEXTS_JSON.'
      : 'The GitHub API did not answer the branch-protection lookup. This may clear on its own; if it persists, treat it as a permission problem.';
  return [
    `Required status-check contexts unavailable after ${attempts} attempts (reason: ${reason}); review blocked, not approved.`,
    '',
    'The reviewer could not determine which status checks this base branch requires, so it cannot tell whether CI is genuinely complete. It will not approve on the checks that happen to have reported.',
    '',
    remedy,
  ].join('\n');
}

/**
 * The INDETERMINATE summary, plus the evaluator's error CODE when there is one.
 *
 * An INDETERMINATE review used to post the bare sentence above, so a blocked PR
 * carried no clue why -- the author could not tell a bad model response from an
 * unreachable judge (#789). The CODE (the identifier before the first colon:
 * `model_error`, `model_timeout`, `model_output_invalid`, `evidence_error`,
 * `reviewed_head_mismatch`) is enough to act on.
 *
 * ONLY the code. The detail half of the error carries model output, API
 * messages, and binary names that may embed tokens or provider internals, and
 * `reviewErrorCode` additionally refuses anything outside a conservative
 * identifier charset, so a malformed error string cannot smuggle text into a
 * public review body.
 */
export function buildIndeterminateSummary(error: string | undefined): string {
  const code = reviewErrorCode(error);
  return code
    ? `${INDETERMINATE_REVIEW_SUMMARY} Reason code: ${code}.`
    : INDETERMINATE_REVIEW_SUMMARY;
}

/**
 * Bind WO-2's evaluator into WO-1's injected submit-side reviewer seam.
 * `reviewerIdentity` is specifically the GitHub actor used for custody checks;
 * the model identity is captured separately from the configured model ladder.
 */
export function createRealSubmitDeps(
  reviewerIdentity = REVIEW_REVIEWER_IDENTITY_DEFAULT,
  overrides: RealSubmitWiringOverrides = {}
): SubmitDeps {
  const octokit = overrides.octokit ?? createRealOctokitClient();
  const patOctokit =
    overrides.patOctokit === undefined
      ? (createRealReadOnlyPatOctokitClient() ?? undefined)
      : (overrides.patOctokit ?? undefined);
  const fetchEvidence = createRealFetchExactHeadPullRequestEvidence(octokit, patOctokit);
  const configuredModelReviewer = configuredReviewIdentity();
  const modelReviewer = {
    provider: configuredModelReviewer.provider,
    model: overrides.reviewerModel ?? configuredModelReviewer.model,
  };
  const runEvaluation = overrides.evaluate ?? evaluatePullRequest;
  return {
    reviewerIdentity,
    async runReviewer(work): Promise<ReviewerVerdict> {
      const result = await runEvaluation(
        {
          owner: work.owner,
          repo: work.repo,
          pr_number: work.prNumber,
          head_sha: work.headSha,
        },
        {
          reviewer: modelReviewer,
          fetchEvidence: request =>
            fetchEvidence({
              owner: request.owner,
              repo: request.repo,
              prNumber: request.pr_number,
              headSha: request.head_sha,
            }),
          // No authorized runtime WO-spec source exists in this repository.
          // Missing criteria is an explicit, recorded degrade path.
          fetchAcceptanceCriteria: async () => null,
          invokeModel: overrides.invokeModel ?? invokeConfiguredReviewModel,
        }
      );
      // CHECKS_PENDING is a non-terminal defer, NOT a verdict. Surface it as a
      // distinct signal so the submit path can release-and-retry rather than
      // fall through to the summary/`approved` mapping below, which would
      // otherwise emit `approved: false` -- a de facto REQUEST_CHANGES on
      // checks-pending grounds (the exact bug this WO fixes).
      if (result.verdict === 'CHECKS_PENDING') {
        return {
          approved: false,
          summary: '',
          reviewedHeadSha: result.reviewed_head_sha,
          checksPending: true,
        };
      }
      // CHECKS_UNAVAILABLE (#775): terminal, never approving. Carries its own
      // summary because a COMMENT with no body says nothing, and the whole
      // point of this path is that a human can read why the PR is stuck.
      if (result.verdict === 'CHECKS_UNAVAILABLE') {
        return {
          approved: false,
          summary: buildRequiredContextsBlockedSummary(result.error),
          reviewedHeadSha: result.reviewed_head_sha,
          requiredContextsUnavailable: true,
        };
      }
      // TRANSPORT_ERROR is a deferral for the same reason CHECKS_PENDING is: no
      // model was ever reached, so no verdict was formed. It must NOT be
      // collapsed into `approved: false` (a de facto REQUEST_CHANGES on
      // argument-size or spawn grounds -- the #789 bug) nor into the terminal
      // INDETERMINATE summary below. The retry delay travels with it so the
      // worker requeues instead of spinning.
      if (result.verdict === 'TRANSPORT_ERROR') {
        const reasonCode = reviewErrorCode(result.error);
        return {
          approved: false,
          summary: '',
          reviewedHeadSha: result.reviewed_head_sha,
          transportError: true,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof result.retry_after_ms === 'number'
            ? { retryAfterMs: result.retry_after_ms }
            : {}),
        };
      }
      const summary =
        result.findings.length > 0
          ? result.findings
              .map(finding => `[${finding.severity}] ${finding.scope}: ${finding.summary}`)
              .join('\n')
          : result.verdict === 'INDETERMINATE'
            ? buildIndeterminateSummary(result.error)
            : 'No blocking findings.';
      return {
        approved: result.verdict === 'APPROVE',
        summary,
        reviewedHeadSha: result.reviewed_head_sha,
      };
    },
    submitReview: createRealSubmitPullRequestReview(octokit),
    async currentHeadSha(input): Promise<string> {
      const pr = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
      });
      return pr.data.head.sha;
    },
    async recordReceipt(input): Promise<void> {
      // This receipt IS the escalation path: every terminal disposition lands
      // in the operator dispatch inbox, which XO drains at session start. #775
      // additionally logs at error level and marks the body `needsOperator` so
      // a blocked-for-permissions PR is not just one more receipt in the list.
      const blocked = input.disposition === 'blocked_required_contexts_unavailable';
      if (blocked) {
        log.error(
          {
            owner: input.owner,
            repo: input.repo,
            prNumber: input.prNumber,
            headSha: input.headSha,
            reason: input.reason ?? null,
          },
          'overseer.pr_review.required_contexts_unavailable_blocked'
        );
      }
      await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId,
          idempotency_key: `pr-review-submit-receipt:${input.messageId}:${input.disposition}`,
          task_type: 'run_report',
          recipient: 'operator',
          subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
          repeat_reason: `review_verdict_receipt:${input.messageId}:${input.disposition}`,
          body: JSON.stringify({
            kind: 'pr_review_submit_receipt',
            ...input,
            ...(blocked ? { needsOperator: true } : {}),
          }),
        }
      );
    },
  };
}
