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
import {
  createRealFetchExactHeadPullRequestEvidence,
  createRealOctokitClient,
  createRealSubmitPullRequestReview,
} from './adapters/github-real-deps';
import type { IngestDeps, PriorReviewWork } from './pr-review-ingest.ts';
import {
  configuredReviewIdentity,
  evaluatePullRequest,
  invokeConfiguredReviewModel,
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
      const receipts = await dispatch.listMessages({
        recipient: 'operator',
        subject_key: subjectKey,
      });
      const verdictByMessageId = new Map<
        string,
        { verdict: PriorReviewWork['verdict']; verdictId: string }
      >();
      for (const receipt of receipts) {
        try {
          const body = JSON.parse(receipt.body) as {
            kind?: string;
            messageId?: string;
            disposition?: string;
          };
          if (body.kind !== 'pr_review_submit_receipt' || !body.messageId) continue;
          verdictByMessageId.set(body.messageId, {
            verdict:
              body.disposition === 'approved'
                ? 'approved'
                : body.disposition === 'changes_requested'
                  ? 'changes_requested'
                  : 'other',
            verdictId: receipt.id,
          });
        } catch {
          // Malformed and unrelated reports are not verdict evidence.
        }
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
            isAutoRereview: message.repeat_reason !== null,
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
  reviewerModel?: string;
  evaluate?: (input: PrReviewInput, deps: PrReviewDeps) => Promise<PrReviewResult>;
  invokeModel?: PrReviewDeps['invokeModel'];
}

const INDETERMINATE_REVIEW_SUMMARY =
  'The independent review could not reach a determinate verdict. No approval was issued.';

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
  const fetchEvidence = createRealFetchExactHeadPullRequestEvidence(octokit);
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
      const summary =
        result.findings.length > 0
          ? result.findings
              .map(finding => `[${finding.severity}] ${finding.scope}: ${finding.summary}`)
              .join('\n')
          : result.verdict === 'INDETERMINATE'
            ? INDETERMINATE_REVIEW_SUMMARY
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
      await dispatch.createAuthenticatedMessage(
        { kind: 'system', sender: REVIEW_SENDER },
        {
          correlation_id: input.correlationId,
          idempotency_key: `pr-review-submit-receipt:${input.messageId}:${input.disposition}`,
          task_type: 'run_report',
          recipient: 'operator',
          subject_key: reviewSubjectKey(input.owner, input.repo, input.prNumber),
          repeat_reason: `review_verdict_receipt:${input.messageId}:${input.disposition}`,
          body: JSON.stringify({ kind: 'pr_review_submit_receipt', ...input }),
        }
      );
    },
  };
}
