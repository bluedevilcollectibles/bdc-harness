import type { CanaryVerdict } from '../types';

export type MechanismId =
  | 'cauldron-lanes'
  | 'review-gate'
  | 'dispatch-transport'
  | 'xo-lease'
  | 'taskmaster'
  | 'ledger-writes'
  | 'operator-inbox'
  | 'knowledge-layer'
  | 'deploy-pipeline';

export interface MechanismProbeResult {
  readonly verdict: Extract<CanaryVerdict, 'passed' | 'failed' | 'blocked'>;
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface MechanismProbeContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly outputRoot: string;
}

export interface MechanismDefinition {
  readonly id: MechanismId;
  readonly description: string;
  readonly level: 0 | 1;
  readonly probe: (context: MechanismProbeContext) => Promise<MechanismProbeResult>;
}

export interface MechanismReport {
  readonly schemaVersion: 1;
  readonly suiteRunId: string;
  readonly level: 0 | 1;
  readonly generatedAt: string;
  readonly verdict: 'passed' | 'failed' | 'blocked';
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly mechanisms: readonly (MechanismProbeResult & { readonly id: MechanismId })[];
}
