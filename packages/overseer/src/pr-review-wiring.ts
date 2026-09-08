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
import * as dispatch from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';
import {
  createRealFetchExactHeadPullRequestEvidence,
  createRealOctokitClient,
  createRealReadOnlyPatOctokitClient,
  createRealSubmitPullRequestReview,
} from './adapters/github-real-deps';
import { isAutoRereviewReason } from './pr-review-ingest';
import type { IngestDeps, PriorReviewWork } from './pr-review-ingest.ts';
import {
  configuredReviewIdentity,
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
 * Binds the pure ingest dependencies to the live dispatch queue.
 *
 * Reuses `agent_dispatch_messages` with `task_type: 'run_review'`. Its UNIQUE
 * `idempotency_key` is what makes a duplicate webhook delivery a no-op rather
 * than a second queued review, so dedupe is enforced by the database, not by
 * application logic that could race.
 */
export function createRealIngestDeps(config: ReviewRouteConfig): IngestDeps {
  return {
    webhookSecret: config.webhookSecret,
    reviewerIdentity: config.reviewerIdentity,

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
  if (!code) return INDETERMINATE_REVIEW_SUMMARY;
  return `${INDETERMINATE_REVIEW_SUMMARY} Reason code: ${code}.\n\nReason: ${publicReviewReason(error) ?? code}`;
}

/**
 * Codes whose detail half is a LADDER BINARY NAME and nothing else (#798).
 *
 * `model_timeout:codex` is built as `${code}:${binary}` from the configured
 * ladder in the evaluator, so its suffix is a short identifier the operator
 * chose -- safe to post, and the single most useful fact about an
 * INDETERMINATE ("which judge died"). Every other code's suffix is free text
 * from a model, an API, or an exception message and stays code-only.
 */
const BINARY_SUFFIX_CODES: ReadonlySet<string> = new Set([
  'model_timeout',
  'model_exit_nonzero',
  'model_output_invalid',
]);

/**
 * The reason string that may appear in a PUBLIC review body.
 *
 * Whitelist, not blacklist: the suffix is emitted only for codes whose detail
 * half is known to be a ladder binary name, and only after it passes the same
 * conservative identifier charset `reviewErrorCode` applies to the code. Every
 * other error -- `evidence_error:<api message>`, `model_error:<exception>` --
 * degrades to its bare code, because those suffixes carry text this code did
 * not construct and cannot vouch for.
 */
export function publicReviewReason(error: string | undefined): string | null {
  const code = reviewErrorCode(error);
  if (!code) return null;
  if (!BINARY_SUFFIX_CODES.has(code)) return code;
  const detail = (error ?? '').slice(code.length + 1).trim();
  return /^[A-Za-z0-9_.-]{1,40}$/.test(detail) ? `${code}:${detail}` : code;
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
      // ONE structured line per evaluation (#798). Emitted before the verdict
      // mapping below so it covers EVERY branch -- including the early returns
      // for CHECKS_PENDING / CHECKS_UNAVAILABLE / TRANSPORT_ERROR, which
      // previously left no record of why the reviewer declined to judge.
      //
      // The full `reason` is safe HERE and only here: container logs are an
      // operator surface, unlike the PR body, which gets the redacted form.
      log.info(
        {
          correlationId: work.correlationId,
          owner: work.owner,
          repo: work.repo,
          prNumber: work.prNumber,
          headSha: work.headSha,
          verdict: result.verdict,
          reason: result.error ?? null,
          ladderTried: result.ladder_tried ?? [],
          durationMs: result.duration_ms ?? null,
          judgeStderrRungs: Object.keys(result.judge_stderr ?? {}),
        },
        'overseer_pr_review_verdict'
      );
      // The reason and the judge's own stderr travel on EVERY verdict so the
      // submit path can persist them on the receipt. Read `reasonDetail` and
      // `judgeStderr` as operator-only; the PR body uses `summary`.
      const diagnostics = {
        ...(result.error ? { reasonDetail: result.error } : {}),
        ...(result.judge_stderr ? { judgeStderr: result.judge_stderr } : {}),
        ...(result.ladder_tried ? { ladderTried: result.ladder_tried } : {}),
      };
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
          ...diagnostics,
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
          ...diagnostics,
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
          ...diagnostics,
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
        ...diagnostics,
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
