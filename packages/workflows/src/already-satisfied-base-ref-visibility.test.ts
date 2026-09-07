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

// WO-HARNESS-PRECHECK-BASE-REF-VISIBILITY-01 (M-85, RATIFIED 2026-07-25)
// The check-already-satisfied precheck must consult origin/<base> when a
// deliverable is absent locally, so a WO merged by a concurrent sibling run
// is recognized as already-satisfied instead of being redundantly rebuilt.
// These assertions are string-level on the prompt wiring, matching how
// already-satisfied-lane-wiring.test.ts tests wiring rather than agent cognition.

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// The 15 lanes that carry the check-already-satisfied precheck node (spec Section 5).
// Hardcoded on purpose: this is the tripwire that forces a NEW lane to be given the
// base-ref precheck rather than silently inheriting the old worktree-only prompt.
// Kimi canary lanes added here 2026-07-25 -- they were cloned from fusion-cx-qwen
// BEFORE the M-85 fix landed, so they arrived carrying the forbidding
// "Do NOT consult origin/main" instruction and no BASE_CHECK. This test caught that
// before merge; the fix was ported into both.
const EXPECTED_PRECHECK_LANES = [
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
  'bdc-harness-ascii-autofix-01.yaml',
  'bdc-harness-commit-guard-pause-not-fail-01.yaml',
  'bdc-harness-mc-negan-diagnostic-graph.yaml',
].sort();

const PRECHECK_LANE_FILES = readdirSync(LANES_DIR)
  .filter(file => file.endsWith('.yaml'))
  .filter(file => {
    const content = readFileSync(join(LANES_DIR, file), 'utf-8');
    return content.includes('- id: check-already-satisfied');
  })
  .sort();

function precheckPrompt(file: string): string {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  const node = result.workflow.nodes.find(n => n.id === 'check-already-satisfied');
  if (!node) throw new Error(`${file}: no check-already-satisfied node`);
  const prompt = node.prompt;
  if (typeof prompt !== 'string') {
    throw new Error(`${file}: check-already-satisfied has no string prompt`);
  }
  return prompt;
}

describe('already-satisfied base-ref visibility (WO-HARNESS-PRECHECK-BASE-REF-VISIBILITY-01)', () => {
  it('discovers exactly the 15 expected precheck lanes', () => {
    expect(PRECHECK_LANE_FILES).toEqual(EXPECTED_PRECHECK_LANES);
  });

  // Stop condition 1 / M-85 binding condition 1: the forbidding instruction is
  // REPLACED, not merely contradicted. It must not survive anywhere under defaults.
  it('has zero occurrences of the forbidding "Do NOT consult origin/main" instruction', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(LANES_DIR).filter(f => f.endsWith('.yaml'))) {
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      if (content.includes('Do NOT consult origin/main')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  for (const file of EXPECTED_PRECHECK_LANES) {
    describe(file, () => {
      // Stop condition 2: BASE_CHECK instruction present in the precheck prompt.
      it('instructs a BASE_CHECK against origin/<base>', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('BASE_CHECK');
        // Reuses the supported $BASE_BRANCH variable with the standard dev fallback.
        expect(prompt).toContain('git fetch origin ${BASE_BRANCH:-dev}');
        expect(prompt).toContain('origin/${BASE_BRANCH:-dev}');
      });

      // Decision matrix row: absent local + present base -> ALREADY_SATISFIED=true.
      it('directs ALREADY_SATISFIED=true when deliverables are present on origin/<base> only', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('origin/<base>');
        expect(prompt).toContain('ALREADY_SATISFIED=true');
      });

      // Decision matrix row + M-85 binding condition 2: fetch failure degrades to
      // today's local-only answer with BASE_CHECK=unavailable, never a hard fail.
      it('degrades to ALREADY_SATISFIED=false with BASE_CHECK=unavailable on fetch failure', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('BASE_CHECK=unavailable');
        expect(prompt).toContain('ALREADY_SATISFIED=false');
        expect(prompt.toLowerCase()).toContain('do not hard-fail');
      });

      // M-85 binding condition 3: base-present-only branch SKIPS the build; no rebase.
      it('forbids rebase/merge and relies on the existing skip logic', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('Do NOT rebase');
        expect(prompt).toContain('do NOT merge');
      });

      // Existing local fast path (decision matrix row 1) is unchanged: still judges
      // THIS worktree's HEAD first.
      it('preserves the local worktree-HEAD-first fast path', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain("worktree's HEAD");
        expect(prompt).toContain('READ-ONLY');
      });

      // Base-only contract: the precheck must emit an explicit SATISFIED_ON_BASE=true
      // marker so the gate can distinguish base-only evidence from a local hit. Without
      // a machine-readable marker the gate cannot preserve the local verdict while
      // routing base-only satisfaction to the already-merged-on-base disposition.
      it('instructs the precheck to emit SATISFIED_ON_BASE=true for base-only evidence', () => {
        const prompt = precheckPrompt(file);
        expect(prompt).toContain('SATISFIED_ON_BASE=true');
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Behavioral coverage of gate-already-satisfied dispositions.
//
// Prior tests here only asserted prompt strings. The gate-already-satisfied bash
// node is what actually maps the precheck verdict onto the PRECHECK_VERDICT
// disposition that downstream `when:` guards consume, so the four required
// outcomes must be EXECUTED, not merely searched for in prompt text:
//   1. local-absent / base-present  -> skip with PRECHECK_VERDICT=already-merged-on-base
//   2. both-absent                  -> build (PRECHECK_VERDICT=needs-build)
//   3. local-present                -> retain the already-satisfied fast path
//   4. fetch failure (agent false)  -> false + needs-build with NO hard failure (exit 0)
//
// check-already-satisfied is an AI node whose cognition cannot be executed here;
// its origin/<base> + BASE_CHECK=unavailable contract is asserted at the prompt
// level above. What IS deterministic and executable is the gate's translation of
// the agent verdict, which we drive here.
//
// We execute the real gate bash with the PRODUCTION executor's substitution
// (substituteNodeOutputRefs with escapedForBash=true), not a naive
// String.prototype.replace. This matches how dag-executor.ts renders bash nodes
// at runtime and is required to prove the base-only skip path actually fires:
// naive substitution masks the shellQuote-wrapping that broke the previous
// heredoc-based gate. Only the JSON-emitting feature-development lanes are
// executed behaviorally, mirroring already-satisfied-lane-wiring.test.ts's
// LANE_FILES scope; the line-emitting harness lanes carry the identical source
// disposition change and are covered by the string/wiring assertions.
const JSON_GATE_FEATURE_LANES = EXPECTED_PRECHECK_LANES.filter(file => {
  if (!file.startsWith('bdc-feature-development')) return false;
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  const gate = result.workflow?.nodes.find(n => n.id === 'gate-already-satisfied');
  return typeof gate?.bash === 'string' && gate.bash.includes("python3 - <<'PY'");
});

function gateBash(file: string): string {
  const content = readFileSync(join(LANES_DIR, file), 'utf-8');
  const result = parseWorkflow(content, file);
  if (!result.workflow) {
    throw new Error(`${file}: ${result.error?.error ?? 'failed to parse'}`);
  }
  const node = result.workflow.nodes.find(n => n.id === 'gate-already-satisfied');
  if (!node || typeof node.bash !== 'string') {
    throw new Error(`${file}: no gate-already-satisfied bash node`);
  }
  return node.bash;
}

async function runGate(file: string, checkOutput: string) {
  // Real production substitution: dag-executor wraps `$node.output` refs in
  // `escapedForBash=true` mode, which shellQuote-wraps the multi-line value.
  // Using String.prototype.replace here would hide the very failure mode that
  // broke the prior heredoc gate at runtime.
  const nodeOutputs = new Map([
    ['check-already-satisfied', { state: 'completed' as const, output: checkOutput }],
  ]);
  const rendered = substituteNodeOutputRefs(gateBash(file), nodeOutputs, true);
  const proc = Bun.spawn(['bash', '-c', rendered], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe('gate-already-satisfied disposition (behavioral)', () => {
  it('executes exactly the 12 JSON-gate feature-development lanes', () => {
    // The two Kimi canary lanes appear here only because they now carry the MODERN
    // gate node. They were cloned from fusion-cx-qwen before both the M-85 base-ref
    // fix AND the heredoc-to-shellQuote gate fix landed, so on arrival they had the
    // old broken gate and were correctly excluded by the filter above. Their
    // presence in this list is the evidence that both ports took.
    expect(JSON_GATE_FEATURE_LANES).toEqual([
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

  for (const file of JSON_GATE_FEATURE_LANES) {
    describe(file, () => {
      // Outcome 1: local-absent / base-present. ALREADY_SATISFIED stays true so the
      // build skip guards still fire, but the disposition is the distinct
      // already-merged-on-base and the diagnostic must NOT claim local satisfaction.
      it('local-absent/base-present -> skip with already-merged-on-base', async () => {
        const forceBuild =
          file === 'bdc-feature-development-zero.yaml' ||
          file === 'bdc-feature-development-zero-open.yaml';
        const { stdout, stderr, exitCode } = await runGate(
          file,
          [
            'ALREADY_SATISFIED=true',
            'SATISFIED_ON_BASE=true',
            'SATISFIED_EVIDENCE=deliverable merged on origin/dev by concurrent sibling run',
          ].join('\n')
        );
        expect(exitCode).toBe(0);
        const doc = JSON.parse(stdout);
        if (forceBuild) {
          // Zero-lane recovery: advisory base-present cannot skip plan/build.
          expect(doc.ALREADY_SATISFIED).toBe(false);
          expect(doc.PRECHECK_VERDICT).toBe('needs-build');
          expect(stderr).toContain('zero-lane forces needs-build');
          return;
        }
        expect(doc.ALREADY_SATISFIED).toBe(true); // skip guard: != 'true' is false -> build skipped
        expect(doc.PRECHECK_VERDICT).toBe('already-merged-on-base');
        expect(doc.SATISFIED_ON_BASE).toBe(true);
        expect(doc.SATISFIED_EVIDENCE).toContain('origin/dev');
        // Corrected diagnostic: names origin/<base>, does not falsely claim the work
        // is satisfied "in this worktree".
        expect(stderr).toContain('already merged on origin/<base>');
        expect(stderr).toContain('not in this worktree');
        expect(stderr).not.toContain('appears already implemented in this worktree');
      });

      // Outcome 2: both-absent -> the run must build.
      it('both-absent -> needs-build', async () => {
        const forceBuild =
          file === 'bdc-feature-development-zero.yaml' ||
          file === 'bdc-feature-development-zero-open.yaml';
        const { stdout, stderr, exitCode } = await runGate(file, 'ALREADY_SATISFIED=false');
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          ALREADY_SATISFIED: false,
          PRECHECK_VERDICT: 'needs-build',
        });
        if (forceBuild) {
          expect(stderr).toContain('zero-lane forces needs-build');
        } else {
          expect(stderr).toBe('');
        }
      });

      // Outcome 3: local-present -> the pre-existing fast path is preserved verbatim
      // (already-satisfied, no SATISFIED_ON_BASE key, worktree diagnostic).
      it('local-present -> retains the already-satisfied fast path', async () => {
        const forceBuild =
          file === 'bdc-feature-development-zero.yaml' ||
          file === 'bdc-feature-development-zero-open.yaml';
        const { stdout, stderr, exitCode } = await runGate(
          file,
          ['ALREADY_SATISFIED=true', 'SATISFIED_EVIDENCE=present in this worktree HEAD'].join('\n')
        );
        expect(exitCode).toBe(0);
        const doc = JSON.parse(stdout);
        if (forceBuild) {
          // Zero-lane recovery: advisory local-present cannot skip plan/build.
          expect(doc.ALREADY_SATISFIED).toBe(false);
          expect(doc.PRECHECK_VERDICT).toBe('needs-build');
          expect(stderr).toContain('zero-lane forces needs-build');
          return;
        }
        expect(doc.ALREADY_SATISFIED).toBe(true);
        expect(doc.PRECHECK_VERDICT).toBe('already-satisfied');
        expect(doc).not.toHaveProperty('SATISFIED_ON_BASE');
        expect(doc.SATISFIED_EVIDENCE).toBe('present in this worktree HEAD');
        expect(stderr).toContain('already implemented in this worktree');
      });

      // Outcome 4: fetch failure. The precheck emits BASE_CHECK=unavailable and degrades
      // to ALREADY_SATISFIED=false; the gate must translate that to needs-build and
      // MUST NOT hard-fail (exit 0), so the run proceeds to a normal build.
      it('fetch failure (agent reports false) -> needs-build without hard failure', async () => {
        const { stdout, exitCode } = await runGate(
          file,
          ['BASE_CHECK=unavailable', 'ALREADY_SATISFIED=false'].join('\n')
        );
        expect(exitCode).toBe(0);
        expect(JSON.parse(stdout)).toEqual({
          ALREADY_SATISFIED: false,
          PRECHECK_VERDICT: 'needs-build',
        });
      });
    });
  }
});
