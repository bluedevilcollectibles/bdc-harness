export type CanaryVerdict =
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'aborted'
  | 'probe_passed'
  | 'probe_failed'
  | 'static_only'
  | 'build_failed';

export interface LaneManifest {
  readonly name: CanaryLaneName;
  readonly order: number;
}

export interface ConductorProbe {
  readonly id: string;
  readonly woClass?: 'CODE' | 'INFRA' | 'MIXED';
  readonly tags: readonly string[];
  readonly expectedTier: string;
  readonly expectedWorkflow: CanaryLaneName;
}

export interface CanaryManifest {
  readonly schemaVersion: 1;
  readonly environment: {
    readonly id: 'hetzner-production';
    readonly project: 'bdc-harness';
    readonly canonicalRemote: 'thinmansoftware/bdc-harness';
    readonly baseBranch: 'dev';
  };
  readonly artifactRoot: string;
  readonly lanes: readonly LaneManifest[];
  readonly conductorProbes: readonly ConductorProbe[];
}

export interface CanaryWorkflowSnapshot {
  readonly name: string;
  readonly source: 'project' | 'bundled' | 'global';
  readonly revision: string;
  readonly capabilityIssues: readonly string[];
}

export interface CanaryProviderSnapshot {
  readonly id: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly capabilities: {
    readonly execution: {
      readonly text: boolean;
      readonly repositoryRead: boolean;
      readonly repositoryWrite: boolean;
      readonly shell: boolean;
    };
    readonly sessionResume: boolean;
    readonly mcp: boolean;
    readonly hooks: boolean;
    readonly skills: boolean;
    readonly agents: boolean;
    readonly toolRestrictions: boolean;
    readonly structuredOutput: boolean;
    readonly envInjection: boolean;
    readonly costControl: boolean;
    readonly effortControl: boolean;
    readonly thinkingControl: boolean;
    readonly fallbackModel: boolean;
    readonly sandbox: boolean;
  };
}

export interface CanarySnapshot {
  readonly observedAt: string;
  readonly codebase: {
    readonly id: string;
    readonly canonicalRemote: string;
    readonly defaultCwd: string;
    readonly baseBranch: 'dev';
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly revisions: {
    readonly engineRevision: string;
    readonly bundleRevision: string;
    readonly runtimeImageRevision: string | null;
  };
  readonly drain: {
    readonly mode: 'normal' | 'draining';
    readonly drained: boolean;
    readonly activeLeaseCount: number;
    readonly activeRunCount: number;
    readonly activeRunIds: readonly string[];
    readonly updatedAt: string | null;
  };
  readonly workflows: readonly CanaryWorkflowSnapshot[];
  readonly providers: readonly CanaryProviderSnapshot[];
  readonly loaderErrors: readonly {
    readonly filename: string;
    readonly path?: string;
    readonly error: string;
    readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
  }[];
  readonly ladder: {
    readonly tiers: readonly {
      readonly name: string;
      readonly workflowName: string;
      readonly isFrontier: boolean;
    }[];
  };
  readonly ruleset: {
    readonly defaultEntry: string;
    readonly rules: readonly {
      readonly match: { readonly woClass?: string; readonly tags?: readonly string[] };
      readonly entry: string;
    }[];
  };
}

export interface CanaryDirectRoute {
  readonly lane: CanaryLaneName;
  readonly matches: readonly CanaryWorkflowSnapshot[];
}

export interface CanaryConductorRoute {
  readonly probeId: string;
  readonly expectedTier: string;
  readonly expectedWorkflow: CanaryLaneName;
  readonly tier: string;
  readonly workflowName: string | null;
}

export interface CanaryPlan {
  readonly requestId: string;
  readonly manifest: CanaryManifest;
  readonly snapshot: CanarySnapshot;
  readonly directRoutes: readonly CanaryDirectRoute[];
  readonly conductorRoutes: readonly CanaryConductorRoute[];
}

export interface CanaryReduction {
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reasonClass?: 'infra' | 'fixture' | 'static';
}

export interface CanaryLaneReport {
  readonly lane: CanaryLaneName;
  readonly level: 0 | 1;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly workflowRevision: string | null;
  readonly capabilityStatus: 'passed' | 'failed' | 'missing' | 'duplicate';
  readonly evidenceRefs: readonly string[];
}

export interface CanaryReport {
  readonly schemaVersion: 1;
  readonly suiteRunId: string;
  readonly level: 0 | 1;
  readonly generatedAt: string;
  readonly requestId: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly lanes: readonly CanaryLaneReport[];
}

export interface RunCanaryResult {
  readonly plan: CanaryPlan;
  readonly report: CanaryReport;
  readonly artifactPaths: readonly string[];
}

export type LifecycleLegId =
  | 'taskmaster-fire'
  | 'codex-lane-build-pr'
  | 'overseer-catch-defect'
  | 'remediation-reaches-pr'
  | 'overseer-reapprove'
  | 'autonomous-merge'
  | 'reconcile-closes-issue'
  | 'dispatch-readable-reply'
  | 'duty-officer-reports'
  | 'canary-reverts';

// Ordered list of the ten lifecycle legs; single source of truth for iteration
// and report ordering. Titles mirror Section 6 of WO-HARNESS-LIFECYCLE-CANARY-01.
export const LIFECYCLE_LEGS: readonly { readonly id: LifecycleLegId; readonly title: string }[] = [
  { id: 'taskmaster-fire', title: 'Taskmaster proposes/dispatches the canary WO' },
  { id: 'codex-lane-build-pr', title: 'codex lane builds and opens a PR' },
  { id: 'overseer-catch-defect', title: 'Overseer requests changes on the planted defect' },
  { id: 'remediation-reaches-pr', title: 'remediation reaches the PR' },
  { id: 'overseer-reapprove', title: 'Overseer re-approves on push' },
  { id: 'autonomous-merge', title: 'Merge Manager merges without a human' },
  { id: 'reconcile-closes-issue', title: 'reconcile closes the GitHub issue' },
  { id: 'dispatch-readable-reply', title: 'Dispatch worker delivers a readable reply' },
  { id: 'duty-officer-reports', title: 'Duty Officer reports the run, flags nothing stale' },
  { id: 'canary-reverts', title: 'the canary change reverts so dev stays clean' },
];

export interface LifecycleLegReport {
  readonly legId: LifecycleLegId;
  readonly title: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  // Populated when a leg proceeded through a documented gap/fallback rather than
  // the intended autonomous path (e.g. Taskmaster never fired, manual remediation).
  readonly gap?: string;
}

export interface LifecycleCanaryReport {
  readonly schemaVersion: 1;
  readonly suiteRunId: string;
  readonly generatedAt: string;
  readonly verdict: CanaryVerdict;
  readonly reasonCodes: readonly string[];
  // Invariant violations are checked independently of leg verdicts and, when
  // present, force the suite verdict to failed regardless of any leg result.
  readonly invariantViolations: readonly string[];
  readonly legs: readonly LifecycleLegReport[];
}

export const CANARY_LANES = [
  'bdc-feature-development-zero-open',
  'bdc-feature-development-zero',
  'bdc-feature-development-fusion-cx-qwen',
  'bdc-feature-development-grok',
  'bdc-feature-development-codex-only',
  'bdc-feature-development-codex',
  'bdc-feature-development',
  'bdc-feature-development-fable',
  'bdc-multi-stage-development',
] as const;

export type CanaryLaneName = (typeof CANARY_LANES)[number];
