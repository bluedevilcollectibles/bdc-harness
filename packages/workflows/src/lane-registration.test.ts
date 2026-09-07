/**
 * lane-registration.test.ts
 *
 * Test scenario 4 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S4a: Each lane YAML passes parseWorkflow() validation (DAG valid, no loader errors).
 * S4b: war-council-validator pin matches the lane's dual-cap / quality intent:
 *      standard/codex/fable -> Claude judge; zero/zero-open/qwen dual-cap -> open models.
 *
 * Design: uses the real parseWorkflow() loader so validation logic matches production.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  getMissingProviderExecutionCapabilities,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { deriveNodeExecutionRequirements, isEvidenceNode } from './schemas/dag-node';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// All bdc-feature-development lane YAMLs
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
  .sort();

interface NodeDef {
  id: string;
  provider?: string;
  model?: string;
  fallbackModel?: string;
  bash?: string;
  prompt?: string;
  loop?: {
    prompt?: string;
  };
}

interface LaneDef {
  name: string;
  provider?: string;
  model?: string;
  nodes?: NodeDef[];
  run_authority?: {
    required?: boolean;
    spec_repository?: string;
    spec_revision?: string;
    spec_paths?: string[];
    allow_issue_fallback?: boolean;
  };
}

function loadLane(filename: string): LaneDef {
  const content = readFileSync(join(LANES_DIR, filename), 'utf-8');
  return (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(content) as LaneDef;
}

describe('lane registration and war-council-validator pin', () => {
  it('S4: enumerates exactly the twelve governed feature lanes', () => {
    // Kimi canary lanes added 2026-07-20 (WO-HARNESS-KIMI-QWEN-CANARY-LANES-01).
    // This enumeration is deliberately hardcoded: it is the tripwire that forces a
    // new lane to be acknowledged here AND given an explicit validator-pin branch
    // in S4b below, rather than silently inheriting a default.
    expect(LANE_FILES).toEqual([
      'bdc-feature-development-astra.yaml',
      'bdc-feature-development-codex-only.yaml',
      'bdc-feature-development-codex.yaml',
      'bdc-feature-development-fable.yaml',
      'bdc-feature-development-fusion-cx-kimi.yaml',
      'bdc-feature-development-fusion-cx-qwen.yaml',
      'bdc-feature-development-grok.yaml',
      'bdc-feature-development-kimi-k3.yaml',
      'bdc-feature-development-zero-claude.yaml',
      'bdc-feature-development-zero-open.yaml',
      'bdc-feature-development-zero.yaml',
      'bdc-feature-development.yaml',
    ]);
  });

  for (const file of LANE_FILES) {
    it(`S4a: ${file} passes parseWorkflow() validation`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      expect(result.error).toBeNull();
      expect(result.workflow).not.toBeNull();
    });

    it(`S4b: ${file} has the expected war-council-validator provider pin`, () => {
      const lane = loadLane(file);
      const nodes = lane.nodes ?? [];
      const wcv = nodes.find((n: NodeDef) => n.id === 'war-council-validator');

      if (!wcv) {
        // Some lanes may not have the validator (skip gracefully)
        return;
      }

      if (file === 'bdc-feature-development-zero.yaml') {
        // DeepSeek judge through the repository-capable OpenRouter tool loop.
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (file === 'bdc-feature-development-zero-open.yaml') {
        // DeepSeek judge through the repository-capable OpenRouter tool loop.
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (file === 'bdc-feature-development-zero-claude.yaml') {
        // DeepSeek judge through the repository-capable OpenRouter tool loop.
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (file === 'bdc-feature-development-fusion-cx-qwen.yaml') {
        // DeepSeek judge through the repository-capable OpenRouter tool loop.
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (
        file === 'bdc-feature-development-fusion-cx-kimi.yaml' ||
        file === 'bdc-feature-development-kimi-k3.yaml'
      ) {
        // Kimi canary lanes (WO-HARNESS-KIMI-QWEN-CANARY-LANES-01, 2026-07-20).
        // Both are clones of fusion-cx-qwen with the BUILDER seats swapped to
        // Kimi K3; the judge seat is deliberately unchanged, so they inherit the
        // same DeepSeek-via-OpenRouter validator pin. Keeping the judge off the
        // builder model is the point -- a lane must not grade its own work.
        // Dispatchable canaries only; NOT ladder-wired until John reviews results.
        expect(wcv.provider).toBe('codex-opr');
        return;
      }

      if (file === 'bdc-feature-development-grok.yaml') {
        // Grok builds; a repository-capable non-Grok judge validates.
        expect(wcv.provider).toBe('codex-opr');
        expect(wcv.model).not.toBe('x-ai/grok-4.6');
        return;
      }

      if (file === 'bdc-feature-development-astra.yaml') {
        expect(wcv.provider).toBe('claude');
        expect(wcv.model).toBe('claude-fable-5');
        return;
      }

      if (file === 'bdc-feature-development-codex-only.yaml') {
        // Claude-out / Codex-in: validator on codex with model-free persona.
        expect(wcv.provider).toBe('codex');
        return;
      }

      if (file === 'bdc-feature-development-codex.yaml') {
        // Fable test seat (John 2026-07-02: "add fable in to one for testing for
        // now"). Model swept claude-fable-5 -> claude-opus-5 by M-20260726-87
        // (this exact node, fusion-cx-qwen's sole Claude binding, was the
        // validator that hard-failed WO #1284 and #1274 the week Fable ran out
        // of subscription quota). Superseded by the apex-rung WO (bdc-xo issue
        // #575) when it lands.
        expect(wcv.provider).toBe('claude');
        expect(wcv.model).toBe('claude-opus-5');
        return;
      }

      // M-121 (John, 2026-08-04): the apex lane's judge serves real
      // claude-fable-5 again. M-87's sweep to claude-opus-5 was an outage
      // workaround, not an apex ruling; Opus 5 is the cheap Fable-substitute
      // and stays on the CLOSER rung (see the codex-lane branch above, which
      // is correct and unchanged).
      const expectedModel =
        file === 'bdc-feature-development-fable.yaml' ? 'claude-fable-5' : 'sonnet';
      expect(wcv.provider).toBe('claude');
      expect(wcv.model).toBe(expectedModel);
    });
  }

  it('S4j: zero and zero-open Claude-free recovery roster', () => {
    // WO-HARNESS-CLAUDE-FREE-LANE-RECOVERY-01: Qwen plans, Grok plan-reviews and
    // builds/repairs, DeepSeek independently reviews implementation. No Anthropic
    // executable binding, no overseer-opus persona, no false Claude/paid-seat trailer.
    for (const file of [
      'bdc-feature-development-zero.yaml',
      'bdc-feature-development-zero-open.yaml',
    ]) {
      const lane = loadLane(file);
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const nodes = lane.nodes ?? [];
      const node = (id: string) => nodes.find(candidate => candidate.id === id);

      // Plan author remains the root Qwen provider/model.
      expect(lane.provider === 'glm' || lane.provider === 'opr-zero').toBe(true);
      expect(lane.model?.startsWith('qwen/')).toBe(true);

      const planReview = node('plan-review');
      expect(planReview?.provider, `${file}:plan-review:provider`).toBe('grok');
      expect(planReview?.model, `${file}:plan-review:model`).toBe('x-ai/grok-4.6');

      for (const id of ['implement', 'diff-repair', 'opus-repair', 'apply-suggested-fix']) {
        const executionNode = node(id);
        expect(executionNode?.provider, `${file}:${id}:provider`).toBe('grok');
        expect(executionNode?.model, `${file}:${id}:model`).toBe('x-ai/grok-4.6');
      }

      expect(node('apply-suggested-fix')?.agent, `${file}:apply-suggested-fix:agent`).toBe(
        'major-build-opr'
      );

      // Independent DeepSeek implementation review seats.
      const deepseekSeats =
        file === 'bdc-feature-development-zero-open.yaml'
          ? [
              'war-council-validator',
              'diff-review',
              'diff-review-final',
              'opus-rereview',
              'apply-diff-review-final',
            ]
          : [
              'war-council-validator',
              'diff-review',
              'diff-review-final',
              'opus-rereview',
              'apply-diff-review-final',
            ];
      for (const id of deepseekSeats) {
        const reviewNode = node(id) as NodeDef & { agent?: string };
        expect(reviewNode?.provider, `${file}:${id}:provider`).toBe('codex-opr');
        expect(reviewNode?.model, `${file}:${id}:model`).toBe('deepseek/deepseek-v4-pro-0813');
        expect(reviewNode?.model, `${file}:${id}:not-gpt`).not.toMatch(/^gpt-/);
        expect(reviewNode?.model, `${file}:${id}:not-claude`).not.toMatch(/claude/i);
        expect(reviewNode?.model, `${file}:${id}:not-grok`).not.toBe('x-ai/grok-4.6');
      }

      // Executable Claude/Anthropic and overseer-opus exclusions.
      expect(content).not.toMatch(/^\s*provider:\s*claude\b/m);
      expect(content).not.toMatch(/^\s*model:\s*claude/m);
      expect(content).not.toContain('agent: overseer-opus');
      expect(content).not.toMatch(/^\s*failover_provider:\s*claude\b/m);
      expect(content).not.toMatch(/noreply@(anthropic|paid-seat-vendor)\.com/);
      expect(content).not.toMatch(/Co-Authored-By:\s*(Claude|paid-seat)/i);
    }
  });

  it('S4k: grok/zero/zero-open contain no false Claude or paid-seat commit trailers', () => {
    for (const file of [
      'bdc-feature-development-zero.yaml',
      'bdc-feature-development-zero-open.yaml',
      'bdc-feature-development-grok.yaml',
    ]) {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      expect(content, file).not.toMatch(/noreply@(anthropic|paid-seat-vendor)\.com/);
      expect(content, file).not.toMatch(/Co-Authored-By:\s*(Claude|paid-seat)/i);
      expect(content, file).not.toContain('agent: overseer-opus');
    }
  });

  it('S4i: the dedicated Grok lane pins execution to Grok and review to non-Grok seats', () => {
    const file = 'bdc-feature-development-grok.yaml';
    const lane = loadLane(file);
    const content = readFileSync(join(LANES_DIR, file), 'utf-8');
    const nodes = lane.nodes ?? [];
    const node = (id: string) => nodes.find(candidate => candidate.id === id);

    expect(lane.provider).toBe('grok');
    expect(lane.model).toBe('x-ai/grok-4.6');
    expect(content).not.toContain('provider: claude');
    expect(content).not.toContain('model: claude');
    expect(content).not.toContain('agent: overseer-opus');

    for (const id of [
      'check-already-satisfied',
      'plan',
      'implement',
      'diff-repair',
      'opus-repair',
      'apply-suggested-fix',
    ]) {
      const executionNode = node(id);
      expect(executionNode?.provider, `${file}:${id}:provider`).toBe('grok');
      expect(executionNode?.model, `${file}:${id}:model`).toBe('x-ai/grok-4.6');
      expect(executionNode?.fallbackModel, `${file}:${id}:fallbackModel`).toBeUndefined();
    }

    for (const id of [
      'plan-review',
      'war-council-validator',
      'diff-review',
      'diff-review-final',
      'opus-rereview',
      'findings-consolidate',
      'apply-diff-review-final',
    ]) {
      const reviewNode = node(id);
      expect(reviewNode?.provider, `${file}:${id}:provider`).toBe('codex-opr');
      expect(reviewNode?.model, `${file}:${id}:model`).not.toBe('x-ai/grok-4.6');
      expect(reviewNode?.fallbackModel, `${file}:${id}:fallbackModel`).toBeUndefined();
    }
  });

  for (const file of LANE_FILES) {
    it(`S4c: ${file} never assigns a chat-only provider to a builder or repair seat`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
      for (const node of result.workflow.nodes) {
        if (!['implement', 'diff-repair', 'opus-repair'].includes(node.id)) continue;
        const provider = node.provider ?? result.workflow.provider;
        if (!provider) continue;
        const missing = getMissingProviderExecutionCapabilities(
          provider,
          deriveNodeExecutionRequirements(node)
        );
        expect(missing, `${file}:${node.id}:${provider}`).toEqual([]);
      }
    });

    it(`S4d: ${file} consumes the frozen work-order artifact`, () => {
      const lane = loadLane(file);
      expect(lane.run_authority).toEqual({
        required: true,
        spec_repository: 'thinmansoftware/bdc-xo',
        spec_revision: 'main',
        spec_paths: ['docs/work-orders/{WO_ID}.md', 'docs/superpowers/specs/{WO_ID}.md'],
        allow_issue_fallback: true,
      });
      const readSpec = lane.nodes?.find(node => node.id === 'read-spec');
      const authoritativePrefix = readSpec?.bash?.split('exit 0', 1)[0] ?? '';
      expect(authoritativePrefix).toContain('run-authority.json');
      expect(authoritativePrefix).toContain('work-order.md');
      expect(authoritativePrefix).toContain('sha256sum');
      expect(authoritativePrefix).toContain('cat "$AUTHORITY_SPEC"');
    });

    it(`S4f: ${file} parseWorkflow() output carries run_authority (loader wiring)`, () => {
      // Regression pin for the 2026-07-10 factory-down incident: S4d validates the
      // RAW YAML (Bun.YAML.parse), but the loader used to drop run_authority from
      // the returned WorkflowDefinition, so the orchestrator/executor authority
      // freeze gate never fired and every /run lane fire died at read-spec with
      // "scope_authority_missing: run-authority.json". This asserts the PARSED
      // definition -- the object production dispatch actually sees.
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
      expect(result.workflow.run_authority).toEqual({
        required: true,
        spec_repository: 'thinmansoftware/bdc-xo',
        spec_revision: 'main',
        spec_paths: ['docs/work-orders/{WO_ID}.md', 'docs/superpowers/specs/{WO_ID}.md'],
        allow_issue_fallback: true,
      });
    });

    it(`S4g: ${file} wires implement to read gate-already-satisfied output`, () => {
      const lane = loadLane(file);
      const implement = lane.nodes?.find(node => node.id === 'implement');
      expect(implement?.loop?.prompt).toContain('$gate-already-satisfied.output');
      expect(implement?.loop?.prompt).toContain('PRECHECK_VERDICT=already-satisfied');
      expect(implement?.loop?.prompt).toContain('Completion Criteria case 2');
    });

    it(`S4h: ${file} wires plan/plan-review for already-satisfied verification`, () => {
      const lane = loadLane(file);
      const plan = lane.nodes?.find(node => node.id === 'plan');
      const planReview = lane.nodes?.find(node => node.id === 'plan-review');
      expect(plan?.prompt).toContain('$gate-already-satisfied.output');
      expect(plan?.prompt).toContain('PRECHECK_VERDICT=already-satisfied');
      expect(plan?.prompt).toContain('minimal plan that VERIFIES');
      expect(planReview?.loop?.prompt).toContain('$gate-already-satisfied.output');
      expect(planReview?.loop?.prompt).toContain('PRECHECK_VERDICT=already-satisfied');
      expect(planReview?.loop?.prompt).toContain('minimal plan that VERIFIES');
    });

    it(`S4e: ${file} derives its manifest from mechanical evidence`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
      const manifestNode = result.workflow.nodes.find(node => node.id === 'build-manifest');
      expect(manifestNode).toBeDefined();
      expect(manifestNode && isEvidenceNode(manifestNode)).toBe(true);
      expect(manifestNode && 'prompt' in manifestNode).toBe(false);
    });
  }
});
