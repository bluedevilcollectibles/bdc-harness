import { createLogger } from '@archon/paths';
import {
  assembleQualifiedMergeEvidence,
  type AssembledQualifiedMergeEvidence,
  type MergeEvidenceAssemblyDeps,
} from './merge-coordinator';
import { judgeWithGrok } from './judge-second-opinion';
import {
  readWorktreeHeadShaWithGit,
  verifyMergeProvenance,
  type MergeProvenanceResult,
} from './merge-provenance';
import type { QualifiedMergeEvidence } from './actions/merge-ready';
import type { OverseerDeploymentEffect } from './policy-registry';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  GrokJudgeEvidence,
  MergeOperatorIdentity,
  OverseerActionsDeps,
  WatchedRunRecord,
} from './types.ts';

export const MERGE_MANAGER_IDENTITY = 'overseer-merge-manager-v1';
export const PRODUCTION_EFFECT_HOLD_REASON = 'production_effect_held_for_john' as const;
export const MERGE_MANAGER_MODE_ENV = 'OVERSEER_MERGE_MANAGER_MODE' as const;
export const MERGE_MANAGER_MUTATIONS_ENABLED_ENV = 'MERGE_MANAGER_MUTATIONS_ENABLED' as const;
export const MERGE_MANAGER_ALLOWED_BASES_ENV = 'MERGE_MANAGER_ALLOWED_BASES' as const;
export const MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV =
  'MERGE_MANAGER_BASE_EFFECT_OVERRIDES' as const;
export const MERGE_MANAGER_REVIEW_GATE_LOGIN_ENV = 'MERGE_MANAGER_REVIEW_GATE_LOGIN' as const;
export const MERGE_MANAGER_MODES = ['hold-canary', 'comment_findings', 'execute'] as const;
export type MergeManagerMode = (typeof MERGE_MANAGER_MODES)[number];
export const DEFAULT_MERGE_MANAGER_MODE: MergeManagerMode = 'hold-canary';

const DEFAULT_OPERATOR: MergeOperatorIdentity = {
  identity: MERGE_MANAGER_IDENTITY,
  provider: 'overseer',
  modelFamily: 'merge-manager',
};
const log = createLogger('overseer/merge-manager');

export interface MergeManagerDeps extends OverseerActionsDeps, GitHubClientDeps {
  readonly assembleEvidence?: (
    record: WatchedRunRecord
  ) => Promise<AssembledQualifiedMergeEvidence>;
  readonly evidenceAssemblyDeps?: MergeEvidenceAssemblyDeps;
  readonly judge?: (input: GrokJudgeEvidence) => Promise<GrokDispositionReceipt>;
  /**
   * Resolve the tip SHA of a run's worktree for provenance binding. Defaults to reading
   * it with git. Injected in tests to avoid real subprocesses.
   */
  readonly readWorktreeHeadSha?: (workingPath: string) => Promise<string | null>;
  readonly execute?: (
    evidence: QualifiedMergeEvidence
  ) => Promise<{ readonly merged: boolean; readonly message?: string; readonly sha?: string }>;
  readonly operator?: MergeOperatorIdentity;
  /**
   * Explicit Merge Manager mode. When set, overrides OVERSEER_MERGE_MANAGER_MODE.
   * Unset/unknown env values fail closed to hold-canary (no GitHub write).
   */
  /** Explicit mode override for tests/DI. Unknown values fail closed via resolveMergeManagerMode. */
  readonly mode?: string;
  /** Explicit activation/configuration overrides for tests and dependency injection. */
  readonly mutationsEnabled?: boolean;
  readonly allowedBases?: readonly string[];
  /**
   * Per-repo base-branch effect declarations, normally parsed from
   * MERGE_MANAGER_BASE_EFFECT_OVERRIDES. Injected in tests. Distinct from allowedBases:
   * allowedBases gates WHICH base names may be merged at all (repo-blind, unchanged);
   * this reclassifies what merging into one named repo+branch actually DEPLOYS.
   */
  readonly baseEffectOverrides?: ReadonlyMap<string, OverseerDeploymentEffect>;
  readonly reviewGateLogin?: string;
}

export type MergeManagerResult =
  | {
      readonly status: 'executed';
      readonly receipt: GrokDispositionReceipt;
      readonly execution: {
        readonly merged: boolean;
        readonly message?: string;
        readonly sha?: string;
      };
    }
  | {
      readonly status: 'held';
      readonly receipt: GrokDispositionReceipt | null;
      readonly execution: null;
      readonly reason: string;
      /** Present when the hold came from the provenance gate. */
      readonly provenance?: MergeProvenanceResult;
      /** Mode active when the hold/canary path ran. */
      readonly mode?: MergeManagerMode;
    };

/**
 * Resolve Merge Manager mode. Precedence: deps.mode -> env -> hold-canary.
 * Unknown / empty values fail closed to hold-canary (zero GitHub writes).
 * Accepts alias `comment-findings` -> `comment_findings`.
 */
export function resolveMergeManagerMode(
  raw: string | null | undefined = process.env[MERGE_MANAGER_MODE_ENV]
): MergeManagerMode {
  const normalized = (raw ?? '').trim().toLowerCase().replace(/-/g, '_');
  if (!normalized) return DEFAULT_MERGE_MANAGER_MODE;
  if (normalized === 'hold_canary') return 'hold-canary';
  if (normalized === 'comment_findings') return 'comment_findings';
  if (normalized === 'execute') return 'execute';
  return DEFAULT_MERGE_MANAGER_MODE;
}

function associationFields(
  record: WatchedRunRecord,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string,
  mode: MergeManagerMode
): Record<string, string | number> {
  return {
    runId: record.runId,
    woId: record.woId,
    owner: evidence.owner,
    repo: evidence.repository,
    prNumber: evidence.pr_number,
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    mode,
  };
}

function buildCanaryCommentBody(
  record: WatchedRunRecord,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string,
  mode: MergeManagerMode,
  disposition: string
): string {
  return [
    'Overseer Merge Manager canary (comment_findings).',
    `mode=${mode}`,
    `disposition=${disposition}`,
    `runId=${record.runId}`,
    `woId=${record.woId}`,
    `pr=${evidence.owner}/${evidence.repository}#${evidence.pr_number}`,
    `headSha=${evidence.head_sha}`,
    `baseSha=${evidence.base_sha}`,
    `evidenceDigest=${evidenceDigest}`,
    'merge=hard_off',
  ].join('\n');
}

function metadataString(record: WatchedRunRecord, keys: readonly string[]): string | null {
  const metadata = record.metadata ?? {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeEffect(value: string | null | undefined): OverseerDeploymentEffect {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'production';
  if (normalized === 'staging' || normalized === 'stage') return 'staging';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'none') return 'none';
  if (normalized === 'unknown') return 'unknown';
  return 'none';
}

const EFFECT_SEVERITY: Record<OverseerDeploymentEffect, number> = {
  none: 0,
  staging: 1,
  unknown: 2,
  production: 3,
};

/**
 * A declared, per-repo classification of one base branch, keyed `owner/repo:branch`.
 *
 * The branch regex below is REPO-BLIND: it reads a base branch name and nothing else.
 * That is correct for lspro-react `main` (auto-promotes to production), shopops
 * `master`, and every `release/*` lineage -- and wrong for a repo whose `main` is not
 * a deployed surface at all. thinmansoftware/bdc-xo is docs, specs and scripts; merging
 * to its `main` deploys nothing, yet the regex called it production and the Merge
 * Manager held every one of its PRs for John forever.
 *
 * John's 2026-09-07 ruling ("yes add main") is executed here as a NARROW, DECLARED
 * exemption rather than a change to the regex: production mains stay production, and a
 * repo is only reclassified when an operator names it explicitly in the environment.
 */
type BaseEffectOverrides = ReadonlyMap<string, OverseerDeploymentEffect>;

function baseEffectOverrideKey(owner: string, repo: string, branch: string): string {
  return `${owner.trim().toLowerCase()}/${repo.trim().toLowerCase()}:${branch.trim().toLowerCase()}`;
}

/**
 * Parse MERGE_MANAGER_BASE_EFFECT_OVERRIDES: comma-separated `owner/repo:branch=effect`
 * entries, e.g. `thinmansoftware/bdc-xo:main=none`. Effects are the normal vocabulary
 * (none | staging | production; dev/prod/stage aliases accepted by normalizeEffect).
 *
 * NEVER THROWS. A malformed entry is dropped with a warn log naming it, so one bad
 * character in an env var cannot take the Merge Manager down -- it only means that one
 * repo keeps its branch-derived classification, which is the safe direction.
 */
export function parseBaseEffectOverrides(raw: string | undefined): BaseEffectOverrides {
  const overrides = new Map<string, OverseerDeploymentEffect>();
  if (!raw?.trim()) return overrides;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.lastIndexOf('=');
    if (eq <= 0) {
      log.warn(
        { entry: trimmed, env: MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV },
        'merge_manager.base_effect_override_malformed -- expected owner/repo:branch=effect'
      );
      continue;
    }
    const target = trimmed.slice(0, eq).trim();
    const rawEffect = trimmed
      .slice(eq + 1)
      .trim()
      .toLowerCase();
    const slash = target.indexOf('/');
    const colon = target.indexOf(':', slash + 1);
    if (slash <= 0 || colon <= slash + 1 || colon === target.length - 1) {
      log.warn(
        { entry: trimmed, env: MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV },
        'merge_manager.base_effect_override_malformed -- expected owner/repo:branch=effect'
      );
      continue;
    }
    // normalizeEffect() falls back to 'none' for anything it does not recognize, which
    // would silently turn a typo into the most permissive value. Validate the literal.
    if (rawEffect !== 'none' && rawEffect !== 'staging' && rawEffect !== 'production') {
      log.warn(
        { entry: trimmed, effect: rawEffect, env: MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV },
        'merge_manager.base_effect_override_malformed -- effect must be none|staging|production'
      );
      continue;
    }
    const owner = target.slice(0, slash);
    const repo = target.slice(slash + 1, colon);
    const branch = target.slice(colon + 1);
    overrides.set(baseEffectOverrideKey(owner, repo, branch), normalizeEffect(rawEffect));
  }
  return overrides;
}

/**
 * Classify the deployment effect of merging this PR.
 *
 * PRECEDENCE IS DELIBERATE, and reads in one direction only -- toward the stricter value:
 *
 *   1. BRANCH REGEX (repo-blind) -- production for main/master/release/prod/production.
 *   2. PER-REPO OVERRIDE (operator-declared env) -- replaces the branch verdict for the
 *      one repo+branch it names. This is the only step that may LOWER severity, and it
 *      exists because the regex cannot tell a deployed `main` from a docs `main`.
 *   3. RUN METADATA (agent-written) -- may only ESCALATE, never downgrade.
 *
 * Before 2026-07-25 metadata was consulted FIRST and returned outright, so a run whose
 * metadata said `environment: dev` while targeting `main` was classified `none` and
 * skipped John's production hold entirely -- an agent-authored string could switch off
 * the gate. That ordering is preserved: an agent can declare something MORE dangerous
 * than it looks (useful, and safe), but can never declare a production merge harmless.
 *
 * The override is deliberately WEAKER than metadata: if run metadata already declares
 * 'production', an override to 'none' is REFUSED with a warn log and 'production' stands.
 * An operator's static env line never silently overrules a run that said, at build time,
 * that it touches production.
 */
function determineDeploymentEffect(
  record: WatchedRunRecord,
  baseBranch: string | null,
  overrides: BaseEffectOverrides = new Map()
): OverseerDeploymentEffect {
  const branch = baseBranch?.toLowerCase() ?? '';
  const branchEffect: OverseerDeploymentEffect =
    /^(main|master|release|prod|production)(\/|-|$)/.test(branch) ? 'production' : 'none';

  const declared = metadataString(record, [
    'resulting_deployment_effect',
    'resultingDeploymentEffect',
    'deployment_effect',
    'deploymentEffect',
    'environment',
  ]);
  const declaredEffect = declared ? normalizeEffect(declared) : null;

  const override =
    record.owner && record.repo && branch
      ? overrides.get(baseEffectOverrideKey(record.owner, record.repo, branch))
      : undefined;

  let baseline: OverseerDeploymentEffect = branchEffect;
  if (override !== undefined) {
    if (declaredEffect === 'production' && EFFECT_SEVERITY[override] < EFFECT_SEVERITY.production) {
      log.warn(
        {
          runId: record.runId,
          woId: record.woId,
          owner: record.owner,
          repo: record.repo,
          baseBranch: branch,
          override,
          env: MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV,
        },
        'merge_manager.base_effect_override_refused -- run metadata declares production; keeping production'
      );
    } else {
      if (override !== branchEffect) {
        log.info(
          {
            runId: record.runId,
            woId: record.woId,
            owner: record.owner,
            repo: record.repo,
            baseBranch: branch,
            branchEffect,
            override,
          },
          'merge_manager.base_effect_override_applied'
        );
      }
      baseline = override;
    }
  }

  if (declaredEffect === null) return baseline;
  return EFFECT_SEVERITY[declaredEffect] > EFFECT_SEVERITY[baseline] ? declaredEffect : baseline;
}

async function defaultAssembleEvidence(
  record: WatchedRunRecord,
  deps: MergeManagerDeps
): Promise<AssembledQualifiedMergeEvidence> {
  if (deps.evidenceAssemblyDeps) {
    return assembleQualifiedMergeEvidence(record, deps.evidenceAssemblyDeps);
  }
  // Fail closed on unknown identity: a merge is the one action that must never run
  // against a repository we inferred. The repo used to be silently defaulted upstream,
  // which meant "no repo recorded" and "bdc-harness" were the same value here.
  if (!record.owner || !record.repo) {
    throw new Error('merge_manager_run_repo_identity_missing');
  }
  const owner = record.owner;
  const repository = record.repo;
  const prEvidence = await deps.findPullRequest({
    owner,
    repo: repository,
    headBranch: record.headBranch,
    woId: record.woId,
  });
  const pr = prEvidence.pr ?? record.prEvidence.pr;
  // 17th canary defect (2026-08-26): run metadata never carries head_sha
  // (the same metadata that carried no repo and no branch -- defects 2-3),
  // so this resolved to '' and the exact-head approval precondition compared
  // reviews against an empty string: review_gate_approval_missing_for_head,
  // forever, structurally. GitHub's own view of the head -- fetched two lines
  // up and explicitly documented as the provenance anchor -- is the truth.
  const headSha = metadataString(record, ['head_sha', 'headSha']) ?? prEvidence.headSha ?? '';
  const baseSha = metadataString(record, ['base_sha', 'baseSha']) ?? '';
  const baseBranch = metadataString(record, ['base_branch', 'baseBranch']) ?? 'dev';
  const changedFiles = metadataString(record, ['changed_files', 'changedFiles'])
    ?.split(',')
    .map(path => path.trim())
    .filter(Boolean);
  return assembleQualifiedMergeEvidence(record, {
    operator: deps.operator ?? DEFAULT_OPERATOR,
    readPolicy: async () => ({
      registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
      credentialPrincipal: deps.operator?.identity ?? MERGE_MANAGER_IDENTITY,
      resultingDeploymentEffect: determineDeploymentEffect(
        record,
        baseBranch,
        deps.baseEffectOverrides ??
          parseBaseEffectOverrides(process.env[MERGE_MANAGER_BASE_EFFECT_OVERRIDES_ENV])
      ),
    }),
    readPullRequest: async () => ({
      owner: pr?.owner ?? owner,
      repository: pr?.repo ?? repository,
      baseBranch,
      changedFiles: changedFiles ?? [],
      prNumber: pr?.number ?? 0,
      headSha,
      baseSha,
      prEvidence,
      requiredChecks:
        prEvidence.checks.total > 0
          ? [{ name: 'required-checks', conclusion: 'success', head_sha: headSha }]
          : [],
      reviews: [{ resolved: true }],
    }),
    readIndependentReview: async () => null,
    readManifestV2: async () => null,
    readM31Proposal: async () => ({
      proposalId: null,
      present: false,
      verifierRegistryDigest: '',
    }),
    readFusionEvidence: async () => null,
    compareFinalState: async () => true,
  });
}

function buildJudgeEvidence(
  record: WatchedRunRecord,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string
): GrokJudgeEvidence {
  const pr = evidence.record.prEvidence;
  return {
    woId: record.woId,
    prNumber: evidence.pr_number,
    prTitle: pr.prTitle ?? '',
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    operator: {
      identity: evidence.operator.identity,
      provider: evidence.operator.provider,
      modelFamily: evidence.operator.model_family,
    },
    checksSummary: pr.checks,
    filesChangedCount: pr.filesChangedCount ?? evidence.changed_files.length,
    diffStat: pr.diffStat ?? '',
  };
}

function receiptMatches(
  receipt: GrokDispositionReceipt,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string
): boolean {
  return (
    receipt.schemaVersion === 'overseer-grok-merge-disposition-v1' &&
    receipt.woId === evidence.record.woId &&
    receipt.prNumber === evidence.pr_number &&
    receipt.headSha === evidence.head_sha &&
    receipt.baseSha === evidence.base_sha &&
    receipt.evidenceDigest === evidenceDigest &&
    receipt.operator.identity === evidence.operator.identity &&
    receipt.operator.provider === evidence.operator.provider &&
    receipt.operator.modelFamily === evidence.operator.model_family &&
    ((receipt.disposition === 'approve' && receipt.reason === 'judge_approve') ||
      (receipt.disposition === 'hold' && receipt.reason !== 'judge_approve'))
  );
}

function holdReceipt(
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string,
  reason: GrokDispositionReceipt['reason']
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition: 'hold',
    reason,
    woId: evidence.record.woId,
    prNumber: evidence.pr_number,
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    operator: {
      identity: evidence.operator.identity,
      provider: evidence.operator.provider,
      modelFamily: evidence.operator.model_family,
    },
  };
}

async function recordManagerAction(
  deps: MergeManagerDeps,
  record: WatchedRunRecord,
  action: string,
  result: string
): Promise<void> {
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: record.errorClass ?? 'tail_node_false_fail',
    action,
    result,
  });
}

async function defaultExecute(
  deps: MergeManagerDeps,
  evidence: QualifiedMergeEvidence
): Promise<{ readonly merged: boolean; readonly message?: string; readonly sha?: string }> {
  return deps.mergePullRequest({
    owner: evidence.owner,
    repo: evidence.repository,
    number: evidence.pr_number,
    commitTitle: `Overseer merge ${evidence.record.woId}`,
  });
}

function envFlagEnabled(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'true';
}

function allowedBasesFromEnv(raw: string | undefined): readonly string[] {
  return (raw ?? 'dev,staging')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

async function mergePreconditionMiss(
  deps: MergeManagerDeps,
  evidence: QualifiedMergeEvidence,
  allowedBases: readonly string[],
  reviewGateLogin: string
): Promise<string | null> {
  const headSha = evidence.head_sha;
  const checks = evidence.required_checks;
  if (
    checks.length === 0 ||
    checks.some(check => check.conclusion !== 'success' || check.head_sha !== headSha)
  ) {
    return 'required_checks_not_green_on_head';
  }
  if (!allowedBases.includes(evidence.base_branch.trim().toLowerCase())) {
    return 'base_branch_not_allowed';
  }
  if (evidence.record.prEvidence.mergeable !== true) {
    return 'pull_request_not_mergeable';
  }
  if (!reviewGateLogin) return 'review_gate_login_unconfigured';
  if (!deps.listPullRequestReviews) return 'review_gate_reviews_unavailable';

  let reviews: Awaited<ReturnType<NonNullable<GitHubClientDeps['listPullRequestReviews']>>>;
  try {
    reviews = await deps.listPullRequestReviews({
      owner: evidence.owner,
      repo: evidence.repository,
      number: evidence.pr_number,
    });
  } catch {
    return 'review_gate_reviews_lookup_failed';
  }
  const normalizedLogin = reviewGateLogin.toLowerCase();
  return reviews.some(
    review =>
      review.login.toLowerCase() === normalizedLogin &&
      review.state.toUpperCase() === 'APPROVED' &&
      review.commitId === headSha
  )
    ? null
    : 'review_gate_approval_missing_for_head';
}

/**
 * Option B from the approved WO plan: this manager deliberately does not call
 * the legacy merge-ready assessment path, because that path contains a narrow
 * policy-tuple gate. This component owns the all-merging lifecycle directly.
 */
export function createMergeManager(
  deps: MergeManagerDeps
): (record: WatchedRunRecord) => Promise<MergeManagerResult> {
  const assembleEvidence =
    deps.assembleEvidence ??
    ((record: WatchedRunRecord): Promise<AssembledQualifiedMergeEvidence> =>
      defaultAssembleEvidence(record, deps));
  const judge = deps.judge ?? judgeWithGrok;
  const readWorktreeHeadSha = deps.readWorktreeHeadSha ?? readWorktreeHeadShaWithGit;
  const execute =
    deps.execute ??
    ((
      evidence: QualifiedMergeEvidence
    ): Promise<{ readonly merged: boolean; readonly message?: string; readonly sha?: string }> =>
      defaultExecute(deps, evidence));
  // deps.mode wins for tests/DI; else env; else hold-canary (fail closed).
  const mode = resolveMergeManagerMode(
    deps.mode !== undefined ? deps.mode : process.env[MERGE_MANAGER_MODE_ENV]
  );
  const mutationsEnabled =
    deps.mutationsEnabled ?? envFlagEnabled(process.env[MERGE_MANAGER_MUTATIONS_ENABLED_ENV]);
  const allowedBases =
    deps.allowedBases ?? allowedBasesFromEnv(process.env[MERGE_MANAGER_ALLOWED_BASES_ENV]);
  const reviewGateLogin = (
    deps.reviewGateLogin ??
    process.env[MERGE_MANAGER_REVIEW_GATE_LOGIN_ENV] ??
    ''
  ).trim();

  return async (record: WatchedRunRecord): Promise<MergeManagerResult> => {
    const assembled = await assembleEvidence(record);
    const { evidence, evidenceDigest } = assembled;

    if (evidence.resulting_deployment_effect === 'production') {
      await recordManagerAction(deps, record, 'merge_denied', PRODUCTION_EFFECT_HOLD_REASON);
      log.warn(
        { runId: record.runId, woId: record.woId, effect: 'production', mode },
        'merge_manager.production_effect_held_for_john'
      );
      return {
        status: 'held',
        receipt: null,
        execution: null,
        reason: PRODUCTION_EFFECT_HOLD_REASON,
        mode,
      };
    }

    // Provenance gate (John, 2026-07-23: "only act on runs it actually oversaw").
    // Runs BEFORE the judge: if we cannot attribute this PR to this run, there is
    // nothing worth judging. Fails closed -- any unresolvable input holds.
    const provenance = await verifyMergeProvenance(record, evidence.record.prEvidence.headSha, {
      readWorktreeHeadSha,
    });
    if (!provenance.verified) {
      await recordManagerAction(deps, record, 'merge_denied', `provenance_${provenance.reason}`);
      log.warn(
        {
          runId: record.runId,
          woId: record.woId,
          reason: provenance.reason,
          runHeadSha: provenance.runHeadSha,
          prHeadSha: provenance.prHeadSha,
          mode,
        },
        'merge_manager.provenance_unverified'
      );
      return {
        status: 'held',
        receipt: null,
        execution: null,
        reason: `provenance_${provenance.reason}`,
        provenance,
        mode,
      };
    }

    let receipt: GrokDispositionReceipt;
    try {
      receipt = await judge(buildJudgeEvidence(record, evidence, evidenceDigest));
    } catch {
      receipt = holdReceipt(evidence, evidenceDigest, 'judge_error');
    }
    if (!receiptMatches(receipt, evidence, evidenceDigest)) {
      receipt = holdReceipt(evidence, evidenceDigest, 'judge_output_invalid');
    }
    if (receipt.disposition !== 'approve') {
      await recordManagerAction(deps, record, 'merge_denied', receipt.reason);
      return { status: 'held', receipt, execution: null, reason: receipt.reason, mode };
    }

    const association = associationFields(record, evidence, evidenceDigest, mode);

    // hold-canary (default): log would-comment / would-merge with association proof;
    // never call comment or merge APIs.
    if (mode === 'hold-canary') {
      log.info(association, 'merge_manager.would_comment');
      log.info(association, 'merge_manager.would_merge');
      await recordManagerAction(
        deps,
        record,
        'would_comment',
        JSON.stringify({ ...association, disposition: receipt.disposition })
      );
      await recordManagerAction(
        deps,
        record,
        'would_merge',
        JSON.stringify({ ...association, disposition: receipt.disposition, hold: 'hold_canary' })
      );
      return {
        status: 'held',
        receipt,
        execution: null,
        reason: 'hold_canary',
        mode,
      };
    }

    // comment_findings: may post one PR comment; merge stays hard-off.
    if (mode === 'comment_findings') {
      const body = buildCanaryCommentBody(
        record,
        evidence,
        evidenceDigest,
        mode,
        receipt.disposition
      );
      if (!deps.commentOnPullRequest) {
        log.warn(association, 'merge_manager.comment_channel_unavailable');
        await recordManagerAction(
          deps,
          record,
          'comment_channel_unavailable',
          JSON.stringify(association)
        );
        return {
          status: 'held',
          receipt,
          execution: null,
          reason: 'comment_channel_unavailable',
          mode,
        };
      }
      try {
        const commentResult = await deps.commentOnPullRequest({
          owner: evidence.owner,
          repo: evidence.repository,
          number: evidence.pr_number,
          body,
        });
        log.info(
          { ...association, commented: commentResult.commented, url: commentResult.url },
          'merge_manager.comment_findings'
        );
        await recordManagerAction(
          deps,
          record,
          'comment_findings',
          JSON.stringify({
            ...association,
            commented: commentResult.commented,
            url: commentResult.url ?? null,
            merge: 'hard_off',
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ ...association, error: message }, 'merge_manager.comment_findings_failed');
        await recordManagerAction(
          deps,
          record,
          'comment_findings_failed',
          JSON.stringify({ ...association, error: message, merge: 'hard_off' })
        );
      }
      return {
        status: 'held',
        receipt,
        execution: null,
        reason: 'comment_findings_merge_hard_off',
        mode,
      };
    }

    // execute: both legacy mode and the mutation flag are explicit opt-ins.
    if (!mutationsEnabled) {
      return {
        status: 'held',
        receipt,
        execution: null,
        reason: 'mutations_disabled',
        mode,
      };
    }

    const preconditionMiss = await mergePreconditionMiss(
      deps,
      evidence,
      allowedBases,
      reviewGateLogin
    );
    if (preconditionMiss) {
      await recordManagerAction(
        deps,
        record,
        'merge_denied',
        JSON.stringify({ ...association, precondition_miss_reason: preconditionMiss })
      );
      return {
        status: 'held',
        receipt,
        execution: null,
        reason: preconditionMiss,
        mode,
      };
    }

    const execution = await execute(evidence);
    await recordManagerAction(
      deps,
      record,
      execution.merged ? 'merged' : 'merge_failed',
      JSON.stringify({
        ...association,
        message:
          execution.message ??
          (execution.merged ? 'merge_manager_executed' : 'merge_manager_failed'),
        mutation_sent: execution.merged,
        merged_sha: execution.merged ? (execution.sha ?? null) : null,
      })
    );
    return { status: 'executed', receipt, execution };
  };
}
