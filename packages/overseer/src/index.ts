/**
 * @archon/overseer -- Cauldron workflow-failure decision layer.
 *
 * Minimal v1 (2026-05-16):
 *   - classifyError: maps a workflow failure to a known error class
 *   - decide: given an error class + attempt, returns a decision
 *
 * v2+ (deferred to Cauldron 2.0 era):
 *   - LLM proxy with provider failover (OpenAI  Anthropic)
 *   - Grader integration for output scoring
 *   - bdc_harness_events Supabase logging
 *   - Mission Control "Workflow Decisions" tab
 *
 * Design authority: 2026-05-09 WO-HARNESS-OVERLORD-* specs (Python prior art at
 * C:/Users/pcmed/projects/overlord/overlord/router.py). This skeleton ports the
 * load-bearing slice to TypeScript so it integrates with the bun-only bdc-harness
 * runtime without a Python sidecar.
 *
 * Anchor: 2026-05-16 Wave 1 sortie hit 6 distinct workflow-failure classes that
 * killed valid implementation work. This package centralizes the recognition + recovery
 * logic so future workflows don't bolt that intelligence into each persona prompt.
 */

export { classifyError } from './classify';
export type { ErrorClass, ClassifyInput } from './classify';

export { decide } from './decide';
export type { Decision, DecideInput, DecisionResult } from './decide';

export { runAuthorizedEscalation } from './authorized-escalation';
export { parseM31ActionPermit, permitFromMetadata } from './permit';
export { buildDispatchRunReportBody, lookupNotionPageId, runEscalation } from './escalate';
export type { EscalationContext, EscalationSourceEvent } from './escalate';
export {
  buildOperatorCard,
  canonicalizeActionableEvent,
  deriveOperatorCardId,
  OPERATOR_CARD_IDENTITY_VERSION,
} from './operator-card';
export type { ActionableEventIdentity, OperatorCard, OperatorCardPayload } from './operator-card';
export {
  createDefaultOperatorCardChannels,
  deliverOperatorCard,
  runDueOperatorCardDeliveries,
} from './escalation-delivery';
export {
  extractBoardSeat,
  resolveWoBoardSeatOwner,
  type BoardSeat,
  type OwnerResolutionOctokitLike,
} from './owner-resolution';
export type {
  ChannelDeliveryResult,
  DeliveryStore,
  OperatorCardChannel,
  OperatorCardChannelDeps,
} from './escalation-delivery';

export { watchLoop, watchOnce, DEFAULT_WATCH_INTERVAL_MS } from './watch';
export { judgePullRequest, isPrGreen, isPrMergeReady } from './judge-pr';
export { judgeWithGrok } from './judge-second-opinion';
export { assembleQualifiedMergeEvidence, coordinateMergeReady } from './merge-coordinator';
export { MERGE_MANAGER_IDENTITY, createMergeManager } from './merge-manager';
export { createGitHubQualifiedMergeAdapter } from './adapters/github-qualified-merge';
export { resolveDefaultDeps, runOverseerService } from './service';
export {
  buildEvidenceComment,
  classifyPullRequestStems,
  createDefaultReconcileDeps,
  extractDeclaredWoStems,
  extractReconcileSkipStems,
  extractWoStems,
  readReconcileCursorFromActions,
  RECONCILE_ACTION,
  RECONCILE_SKIP_ACTION,
  runReconcileOnce,
} from './reconcile';
export type {
  PullRequestStemClassification,
  ReconcileActionRecord,
  ReconcileDeps,
  ReconcileLogger,
  ReconcileMergedPullRequest,
  ReconcileResult,
  ReconcileTrackerIssue,
  RunReconcileInput,
} from './reconcile';

// M-31 merge-steward substrate (M-42 Slice 2): read-only permit preparation.
export { prepareM31ActionPermit, createFailClosedM31CapabilityGate } from './m31-substrate';
export type {
  M31LiveStateReader,
  M31CapabilityGate,
  M31GateRequest,
  M31GateDecision,
  M31GateDenial,
  PrepareM31ActionPermitInput,
  PrepareM31ActionPermitResult,
  M31PermitPreparationDeps,
  M31ActionKind,
  M31ActionPermit,
  M31ActionProposal,
  M31ExecutionReceipt,
  M31LiveObservation,
  M31TypedFailure,
} from './m31-substrate';

// M-42 Slice 1 fail-closed action policy and deterministic fixture boundary.
export { authorizeOverseerAction, evaluateActionPolicy } from './action-policy';
export type {
  ActionPolicyDenialReason,
  ActionPolicyInput,
  AuthorizeOverseerActionDeps,
  AuthorizeOverseerActionInput,
  OverseerActionPolicy,
} from './action-policy';
export { createFakeGitHubAdapter } from './adapters/fake-github';
export type {
  FakeGitHubAdapter,
  FakeGitHubAdapterDeps,
  FakeGitHubMutationRequest,
  FakeGitHubReceipt,
  FakeGitHubReceiptReason,
} from './adapters/fake-github';
export type {
  GrokJudgeDeps,
  GrokJudgeEvidence,
  GrokDispositionReceipt,
  MergeOperatorIdentity,
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types';

// M-42 Slice 8 integration, scenarios, and unsigned activation packets.
export {
  buildOverseerParentManifest,
  reduceParentEvidence,
  REQUIRED_M42_CHILD_WO_IDS,
} from './integration-manifest';
export {
  assertBuilderMatchesManifest,
  assertCandidateIsCurrentHead,
  INDEPENDENT_REVIEW_SCHEMA_VERSION,
  validateIndependentReviewEvidence,
} from './independent-review-evidence';
export {
  finalizeExternalEvidence,
  prepareExternalManifest,
  resolveExternalArtifactInput,
  resolveExternalArtifactRoot,
} from './external-finalization';
export type {
  CompleteRollbackProof,
  CompleteStagingProof,
  ExternalSeedChild,
  ExternalSeedManifest,
  FinalizeExternalEvidenceInput,
  FinalizeExternalEvidenceResult,
} from './external-finalization';
export type {
  ExpectedIndependentReview,
  IndependentReviewArtifact,
  IndependentReviewFinding,
  IndependentReviewValidationResult,
  IndependentReviewVerdict,
  ReviewAgentIdentity,
} from './independent-review-evidence';
export type {
  ChildEvidenceRecord,
  ChildReviewEvidence,
  EvidenceState,
  OverseerParentManifest,
  ParentEvidenceInput,
  ParentReadinessPacket,
  ReducedParentEvidence,
  SliceEvidenceSummary,
} from './integration-manifest';
export {
  assertOverseerDefaultOff,
  runOverseerAdversarialScenario,
  runOverseerAdversarialMatrix,
  runIntegratedSuccessChain,
  invokeRealProviderBoundary,
  ADVERSARIAL_SCENARIO_IDS,
  OVERSEER_CAPABILITIES,
} from './integration-scenarios';
export type {
  DefaultOffInput,
  DefaultOffResult,
  ScenarioDeps,
  ScenarioId,
  ScenarioRunInput,
  ScenarioRunResult,
  SuccessChainResult,
  MatrixResult,
  ChainReceipt,
} from './integration-scenarios';
export { createRealCallTracker } from './integration-fixtures';
export type { RealCallTracker } from './integration-fixtures';
export {
  assertActivationPackageInput,
  buildUnsignedSandboxProofRequest,
  buildUnsignedActivationRequest,
  verifyWrittenActivationArtifactDigests,
  writeNonGovernanceActivationArtifacts,
  canonicalJsonStringify,
} from './activation-package';
export type {
  ActivationPackageInput,
  ActivationArtifactBundle,
  UnsignedSandboxProofRequest,
  UnsignedActivationRequest,
  WrittenActivationArtifacts,
  StagingProofEvidence,
  RollbackProofEvidence,
} from './activation-package';
export { createOverseerControlPlaneService } from './control-plane';
export type {
  OverseerControlPlaneService,
  OverseerControlPlaneServiceDependencies,
} from './control-plane';
