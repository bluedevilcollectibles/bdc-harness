import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import { substituteNodeOutputRefs } from './dag-executor';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const ALL_GATE_FILES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => {
    const content = readFileSync(join(LANES_DIR, file), 'utf-8');
    return content.includes('- id: gate-already-satisfied');
  })
  .sort();

const LANE_FILES = ALL_GATE_FILES.filter(file => file.startsWith('bdc-feature-development'));

async function runGateScript(script: string, checkOutput: string) {
  // Mirror the production executor's bash-node substitution (see
  // dag-executor.ts substituteNodeOutputRefs with escapedForBash=true). A naive
  // String.prototype.replace here would hide the shellQuote wrapping that broke
  // the previous heredoc-based gate at runtime.
  const nodeOutputs = new Map([
    ['check-already-satisfied', { state: 'completed' as const, output: checkOutput }],
  ]);
  const rendered = substituteNodeOutputRefs(script, nodeOutputs, true);
  const proc = Bun.spawn(['bash', '-c', rendered], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

describe('already-satisfied lane wiring', () => {
  it('discovers the 12 affected feature-development lanes', () => {
    // This list is the ONLY hardcoded part of this file -- LANE_FILES itself is
    // glob-derived, so the per-lane assertions below automatically cover any new
    // lane. Adding a lane therefore fails HERE and nowhere else, which is the
    // intended tripwire: it forces a deliberate acknowledgement that a new lane
    // exists rather than letting it slip in uncovered.
    // Kimi canary lanes added 2026-07-20 (WO-HARNESS-KIMI-QWEN-CANARY-LANES-01):
    // dispatchable canaries, NOT ladder-wired until John reviews canary results.
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

  for (const file of ALL_GATE_FILES) {
    it(`${file} wires implement to read gate-already-satisfied output`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);

      const implement = result.workflow.nodes.find(node => node.id === 'implement');
      expect(implement?.loop?.prompt).toContain('$gate-already-satisfied.output');
      expect(implement?.loop?.prompt).toContain('PRECHECK_VERDICT=already-satisfied');
      expect(implement?.loop?.prompt).toContain('Completion Criteria case 2');
    });
  }

  for (const file of LANE_FILES) {
    it(`${file} wires true node-skip guards and all_done downstream trigger rules`, () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);

      const node = (id: string) => result.workflow?.nodes.find(n => n.id === id);
      const skipWhen = "$gate-already-satisfied.output.ALREADY_SATISFIED != 'true'";

      expect(node('plan')?.when).toBe(skipWhen);
      expect(node('plan-review')?.when).toBe(skipWhen);
      expect(node('plan-review')?.trigger_rule).toBe('all_done');
      expect(node('implement')?.when).toBe(skipWhen);
      expect(node('implement')?.trigger_rule).toBe('all_done');

      for (const id of [
        'capture-run-scope',
        'checkpoint-push',
        'derive-run-source-scope',
        'ascii-gate',
      ]) {
        expect(node(id)?.trigger_rule).toBe('all_done');
      }

      expect(node('capture-run-scope')?.bash).toContain("git rev-parse --verify 'HEAD^{commit}'");
      expect(node('capture-run-scope')?.bash).not.toContain('$plan.output');
      expect(node('capture-run-scope')?.bash).not.toContain('$plan-review.output');

      expect(node('assert-implement-produced-work')?.bash).toContain(
        '$gate-already-satisfied.output'
      );
      expect(node('assert-implement-produced-work')?.bash).toContain(
        'GATE_ALREADY_SATISFIED=$GATE_ALREADY'
      );
      expect(node('assert-implement-produced-work')?.bash).toContain(
        'BUILD_OUTCOME=ALREADY_SATISFIED'
      );
    });

    it(`${file} emits exactly one JSON document from gate-already-satisfied stdout`, async () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);

      const gate = result.workflow.nodes.find(node => node.id === 'gate-already-satisfied');
      expect(gate?.bash).toBeString();
      const forceBuild =
        file === 'bdc-feature-development-zero.yaml' ||
        file === 'bdc-feature-development-zero-open.yaml';

      const already = await runGateScript(
        gate?.bash ?? '',
        [
          'ALREADY_SATISFIED=true',
          'SATISFIED_EVIDENCE=branch already contains required harness change',
        ].join('\n')
      );
      expect(already.exitCode).toBe(0);
      expect(already.stdout.trim().split('\n')).toHaveLength(1);
      if (forceBuild) {
        // WO-HARNESS-CLAUDE-FREE-LANE-RECOVERY-01: advisory true cannot skip zero lanes.
        expect(JSON.parse(already.stdout)).toEqual({
          ALREADY_SATISFIED: false,
          PRECHECK_VERDICT: 'needs-build',
        });
        expect(already.stderr).toContain('zero-lane forces needs-build');
      } else {
        expect(JSON.parse(already.stdout)).toEqual({
          ALREADY_SATISFIED: true,
          PRECHECK_VERDICT: 'already-satisfied',
          SATISFIED_EVIDENCE: 'branch already contains required harness change',
        });
        expect(already.stderr).toContain('build-only nodes will be skipped');
      }

      const needsBuild = await runGateScript(gate?.bash ?? '', 'ALREADY_SATISFIED=false');
      expect(needsBuild.exitCode).toBe(0);
      expect(needsBuild.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(needsBuild.stdout)).toEqual({
        ALREADY_SATISFIED: false,
        PRECHECK_VERDICT: 'needs-build',
      });
      if (forceBuild) {
        expect(needsBuild.stderr).toContain('zero-lane forces needs-build');
      } else {
        expect(needsBuild.stderr).toBe('');
      }
    }, 15000);

    it(`${file} preserves adversarial already-satisfied evidence through shell embedding`, async () => {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      const result = parseWorkflow(content, file);
      if (!result.workflow) throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);

      const gate = result.workflow.nodes.find(node => node.id === 'gate-already-satisfied');
      expect(gate?.bash).toBeString();
      expect(gate?.bash).not.toContain('BDC_CHECK_ALREADY_SATISFIED_OUTPUT');
      const forceBuild =
        file === 'bdc-feature-development-zero.yaml' ||
        file === 'bdc-feature-development-zero-open.yaml';

      const evidence = [
        "branch contains quoted value 'already done'",
        'literal backtick ` should remain data',
        'old heredoc marker BDC_CHECK_ALREADY_SATISFIED_OUTPUT should remain data',
      ].join(' / ');
      const already = await runGateScript(
        gate?.bash ?? '',
        [
          'ALREADY_SATISFIED=true',
          `SATISFIED_EVIDENCE=${evidence}`,
          'BDC_CHECK_ALREADY_SATISFIED_OUTPUT',
        ].join('\n')
      );

      expect(already.exitCode).toBe(0);
      expect(already.stdout.trim().split('\n')).toHaveLength(1);
      if (forceBuild) {
        expect(JSON.parse(already.stdout)).toEqual({
          ALREADY_SATISFIED: false,
          PRECHECK_VERDICT: 'needs-build',
        });
        expect(already.stderr).toContain('zero-lane forces needs-build');
      } else {
        expect(JSON.parse(already.stdout)).toEqual({
          ALREADY_SATISFIED: true,
          PRECHECK_VERDICT: 'already-satisfied',
          SATISFIED_EVIDENCE: evidence,
        });
        expect(already.stderr).toContain('build-only nodes will be skipped');
      }
    });
  }
});
