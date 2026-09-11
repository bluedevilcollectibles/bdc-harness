import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from './loader';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';

// bdc-xo #1940 (harness defect 2026-09-05, shopops #674 run 69f9d306 / lspro-react
// #580 run d31037ff): the engine-side build-manifest renders "Tests: N/A (required
// gates are reported separately)" and "Grep assertions: N/A" for every WO, and the
// validator's test claim was never tied to an executed command. Every
// bdc-feature-development lane must now carry four mechanical evidence nodes and
// the validator's executed-command contract. These are string-level wiring
// assertions (like already-satisfied-base-ref-visibility.test.ts), CI-enforced so
// a lane cannot silently drop the contract. The node cores themselves are tested
// by .archon/workflows/defaults/__tests__/{run-stop-tests,run-stop-greps,
// stamp-manifest-evidence,manifest-evidence-check}.sh, which extract them from the
// YAML and execute them.

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// Hardcoded on purpose: a NEW lane that carries an evidence: manifest_v2
// build-manifest must be added here AND given the evidence nodes.
const EXPECTED_LANES = [
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
].sort();

const EVIDENCE_NODES = [
  'run-stop-tests',
  'run-stop-greps',
  'stamp-manifest-evidence',
  'manifest-evidence-check',
] as const;

const MANIFEST_V2_LANES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => readFileSync(join(LANES_DIR, file), 'utf-8').includes('kind: manifest_v2'))
  .sort();

interface LaneNode {
  readonly id: string;
  readonly depends_on?: readonly string[];
  readonly when?: string;
  readonly bash?: string;
  readonly prompt?: string;
  readonly timeout?: number;
}

function laneNodes(file: string): readonly LaneNode[] {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  return result.workflow.nodes as unknown as readonly LaneNode[];
}

function node(nodes: readonly LaneNode[], id: string, file: string): LaneNode {
  const found = nodes.find(n => n.id === id);
  if (!found) throw new Error(`${file}: no ${id} node`);
  return found;
}

function coreOf(bash: string, marker: string): string {
  const begin = bash.indexOf(`# ---- BEGIN ${marker} core`);
  const end = bash.indexOf(`# ---- END ${marker} core`);
  if (begin < 0 || end < 0) throw new Error(`missing ${marker} core markers`);
  return bash.slice(begin, end);
}

describe('manifest evidence lane wiring (bdc-xo #1940)', () => {
  it('every lane with an evidence: manifest_v2 build-manifest is in the expected list', () => {
    expect(MANIFEST_V2_LANES).toEqual(EXPECTED_LANES);
  });

  for (const file of EXPECTED_LANES) {
    describe(file, () => {
      const nodes = laneNodes(file);

      it('carries the four mechanical evidence nodes as bash nodes', () => {
        for (const id of EVIDENCE_NODES) {
          const n = node(nodes, id, file);
          expect(typeof n.bash).toBe('string');
          expect(n.prompt).toBeUndefined();
        }
      });

      it('run-stop-tests runs after ascii-gate with a 30-minute budget', () => {
        const n = node(nodes, 'run-stop-tests', file);
        expect(n.depends_on).toEqual(['ascii-gate']);
        expect(n.timeout).toBe(1800000);
      });

      it('war-council-validator depends on both evidence nodes and carries the executed-command contract', () => {
        const n = node(nodes, 'war-council-validator', file);
        expect(n.depends_on).toEqual(['ascii-gate', 'run-stop-tests', 'run-stop-greps']);
        expect(n.prompt).toContain('$run-stop-tests.output');
        expect(n.prompt).toContain('$run-stop-greps.output');
        expect(n.prompt).toContain('TESTS_OBSERVED: <passed>/<total> (<command you executed>)');
        expect(n.prompt).toContain('TESTS_OBSERVED: not_run (<reason>)');
        expect(n.prompt).toContain('without an executed command');
        expect(n.prompt).toContain('needs_revision');
      });

      it('stamp-manifest-evidence rewrites the raw engine manifest from both evidence nodes', () => {
        const n = node(nodes, 'stamp-manifest-evidence', file);
        expect(n.depends_on).toEqual(['build-manifest', 'run-stop-tests', 'run-stop-greps']);
        expect(n.bash).toContain('$build-manifest.output');
        expect(n.bash).toContain('$run-stop-tests.output');
        expect(n.bash).toContain('$run-stop-greps.output');
      });

      it('manifest-evidence-check reads the stamped manifest and gates patch-pr-body', () => {
        const check = node(nodes, 'manifest-evidence-check', file);
        expect(check.depends_on).toContain('stamp-manifest-evidence');
        expect(check.bash).toContain('$stamp-manifest-evidence.output');
        const patch = node(nodes, 'patch-pr-body', file);
        expect(patch.depends_on).toContain('manifest-evidence-check');
        expect(patch.when).toContain("$manifest-evidence-check.output == 'OK'");
      });

      it('no consumer other than stamp-manifest-evidence reads the raw $build-manifest.output', () => {
        for (const n of nodes) {
          if (n.id === 'stamp-manifest-evidence') continue;
          const body = `${n.bash ?? ''}\n${n.prompt ?? ''}`;
          expect(body.includes('$build-manifest.output')).toBe(false);
        }
      });
    });
  }

  it('the four node cores are byte-identical across all lanes', () => {
    const canonical = laneNodes('bdc-feature-development-codex.yaml');
    const markers: Record<(typeof EVIDENCE_NODES)[number], string> = {
      'run-stop-tests': 'rst',
      'run-stop-greps': 'rsg',
      'stamp-manifest-evidence': 'sme',
      'manifest-evidence-check': 'mec',
    };
    for (const file of EXPECTED_LANES) {
      const nodes = laneNodes(file);
      for (const id of EVIDENCE_NODES) {
        const expected = coreOf(node(canonical, id, 'canonical').bash ?? '', markers[id]);
        const actual = coreOf(node(nodes, id, file).bash ?? '', markers[id]);
        expect(actual).toBe(expected);
      }
    }
  });

  it('the placeholder Tests text is still what the engine renders (so the stamp is load-bearing)', () => {
    const collector = readFileSync(
      join(REPO_ROOT, 'packages/workflows/src/reliability/evidence-collector.ts'),
      'utf-8'
    );
    expect(collector).toContain("'Tests: N/A (required gates are reported separately)'");
  });
});
