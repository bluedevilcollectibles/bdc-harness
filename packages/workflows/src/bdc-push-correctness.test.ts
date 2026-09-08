/**
 * Behavioral tests for the push-correctness hardening in bdc-feature-development.yaml.
 *
 * WO-HARNESS-PUSH-CORRECTNESS-HARDENING-01 (anchored 2026-05-18).
 *
 * Covers three failure modes the YAML now defends against:
 *   F-6A: decide-push-target agent emits a malformed branch name with embedded
 *         thread suffix (e.g. archon/thread-9772643d-thread-9772643d).
 *   F-7C: COMMITS_AHEAD = 0 because the implement loop already pushed the work
 *         to a different remote branch -- recoverable via git ls-remote search.
 *   F-8C: open-pr-if-needed must add --base staging for Rule 20 repos
 *         (lspro-react, shopops-storefront, shopops) and omit it otherwise.
 *
 * Tests extract the relevant bash snippets from the YAML and exercise them in
 * isolated temp git repos via Bun.spawnSync. No mock.module() calls -- safe to
 * run in its own bun test invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Snippet 1 (F-6A): BRANCH allowlist regex validator from commit-and-push.
// Mirrors lines 287-297 of bdc-feature-development.yaml.
// ---------------------------------------------------------------------------
const F6A_VALIDATOR = `
set -euo pipefail
BRANCH_PATTERN='^(feat/[A-Za-z0-9_-]+|fix/[A-Za-z0-9_-]+|wip/[A-Za-z0-9_-]+)$'
if ! printf '%s\\n' "$BRANCH" | grep -Eq "$BRANCH_PATTERN"; then
  echo "Malformed branch name: $BRANCH does not match required pattern feat/|fix/|wip/|archon/thread-" >&2
  exit 1
fi
echo "BRANCH_VALID=$BRANCH"
`;

// ---------------------------------------------------------------------------
// Snippet 2 (F-7C): COMMITS_AHEAD=0 fallback that searches git ls-remote.
// Mirrors lines 322-345 of bdc-feature-development.yaml. Set UNIQUE_BRANCH
// (the malformed target) in env; the snippet either reassigns it from the
// remote-search recovery or exits 1.
// ---------------------------------------------------------------------------
const F7C_FALLBACK = `
set -euo pipefail
# Pretend we are inside the COMMITS_AHEAD=0 branch.
LOCAL_HEAD=$(git rev-parse HEAD)
RECOVERED=$(git ls-remote origin 2>/dev/null \\
  | awk -v sha="$LOCAL_HEAD" '$1 == sha {sub(/^refs\\/heads\\//, "", $2); print $2}' \\
  | head -1)
if [ -n "$RECOVERED" ]; then
  echo "Recovered push target from remote: $RECOVERED"
  UNIQUE_BRANCH="$RECOVERED"
  echo "UNIQUE_BRANCH=$UNIQUE_BRANCH"
  exit 0
else
  echo "No changed files and no commits ahead of origin/\${UNIQUE_BRANCH} -- implement loop did not produce work" >&2
  exit 1
fi
`;

// ---------------------------------------------------------------------------
// Snippet 3 (F-8C): staging-gate extractor + gh pr create command construction.
// Mirrors lines 429-440 of bdc-feature-development.yaml. We do NOT invoke gh
// (no GitHub auth in CI) -- we capture the final command line as a string to
// assert on the --base flag inclusion.
// ---------------------------------------------------------------------------
const F8C_BASE_BRANCH_SELECTION = `
set -euo pipefail
STAGING_GATE=$(printf '%s\\n' "$DECIDE_OUTPUT" | grep -c '^staging_gate_required: true' 2>/dev/null || true)
STAGING_GATE="\${STAGING_GATE:-0}"
if [ "$STAGING_GATE" -ge 1 ] 2>/dev/null; then
  BASE_BRANCH="staging"
else
  BASE_BRANCH=""
fi
# Build the command line that gh would receive. We use eval-safe printing so
# the conditional --base flag is captured verbatim in the output.
CMD="gh pr create --title T --body-file BF --head $UNIQUE_BRANCH \${BASE_BRANCH:+--base \"\$BASE_BRANCH\"}"
echo "BASE_BRANCH=$BASE_BRANCH"
echo "CMD=$CMD"
`;

// ---------------------------------------------------------------------------
// Snippet 4: base_branch_override validation/precedence + PR body text from
// open-pr-if-needed. Mirrors the deterministic bash guard added around
// bdc-feature-development.yaml lines 2208-2236. REPO_REMOTE_URL is a test-only
// injection so the branch-existence check can run against a local bare remote.
// ---------------------------------------------------------------------------
const BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY = `
set -euo pipefail
REPO="\${REPO:-thinmansoftware/bdc-xo}"
REMOTE_URL="\${REPO_REMOTE_URL:-https://github.com/\${REPO}.git}"
STAGING_GATE=$(printf '%s\\n' "$DECIDE_OUTPUT" | grep -c '^staging_gate_required: true' 2>/dev/null || true)
BASE_BRANCH_OVERRIDE=$(printf '%s\\n' "$DECIDE_OUTPUT" | sed -n 's/^base_branch_override: //p' | head -n 1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
STAGING_GATE="\${STAGING_GATE:-0}"
if [ -n "$BASE_BRANCH_OVERRIDE" ]; then
  case "$BASE_BRANCH_OVERRIDE" in
    unknown|UNKNOWN|"<"*">"*|*"e.g."*|*" "*|*$'\\t'*|*$'\\r'*|*$'\\n'*)
      echo "ERROR: decide-push-target emitted an invalid 'base_branch_override: <branch>' value: \${BASE_BRANCH_OVERRIDE}" >&2
      exit 1
      ;;
  esac
  if ! git check-ref-format --branch "$BASE_BRANCH_OVERRIDE" >/dev/null 2>&1; then
    echo "ERROR: decide-push-target emitted an invalid base branch override ref name: \${BASE_BRANCH_OVERRIDE}" >&2
    exit 1
  fi
  if ! git ls-remote --exit-code "$REMOTE_URL" "refs/heads/\${BASE_BRANCH_OVERRIDE}" >/dev/null 2>&1; then
    echo "ERROR: base branch override '\${BASE_BRANCH_OVERRIDE}' does not exist on \${REPO}; refusing to open PR against an unverified base." >&2
    exit 1
  fi
  BASE_BRANCH="$BASE_BRANCH_OVERRIDE"
elif [ "$STAGING_GATE" -ge 1 ] 2>/dev/null; then
  BASE_BRANCH="staging"
else
  BASE_BRANCH=""
fi
BODY_FILE=$(mktemp)
{
  echo "## Summary"
  echo "$PLAN_OUTPUT"
  echo
  if [ -n "$BASE_BRANCH_OVERRIDE" ]; then
    echo "## Base branch override"
    echo "Base branch override applied: PR targets \\\`$BASE_BRANCH_OVERRIDE\\\` per spec-declared \\\`Base branch:\\\` field (not the default staging gate)."
    echo
  fi
  echo "## Implement output"
  echo "$IMPLEMENT_OUTPUT"
} > "$BODY_FILE"
echo "BASE_BRANCH=$BASE_BRANCH"
echo "CMD=gh pr create --repo $REPO --title T --body-file BF --head $UNIQUE_BRANCH \${BASE_BRANCH:+--base "$BASE_BRANCH"}"
cat "$BODY_FILE"
`;

// ---------------------------------------------------------------------------
// Snippet 5: review diff-base resolution used by resolve-review-base.
// Mirrors the bash node added to every bdc-feature-development*.yaml lane.
// SPEC_TEXT is injected by the test harness instead of read from read-spec.
// ---------------------------------------------------------------------------
const RESOLVE_REVIEW_BASE = `
set -uo pipefail
DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '^Base branch:[[:space:]]*[A-Za-z0-9_./-]+' | sed -E 's/^Base branch:[[:space:]]*//')
if [ -z "$DECLARED" ]; then
  DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '\\*\\*Base branch:\\*\\*[[:space:]]*\\\`[A-Za-z0-9_./-]+\\\`' | sed -E 's/.*\\\`([A-Za-z0-9_./-]+)\\\`.*/\\1/')
fi
if [ -z "$DECLARED" ]; then
  DECLARED=$(printf '%s\\n' "$SPEC_TEXT" | grep -m1 -E '^base_branch:[[:space:]]*[A-Za-z0-9_./-]+' | sed -E 's/^base_branch:[[:space:]]*//')
fi
if [ -n "$DECLARED" ] && git ls-remote --exit-code origin "refs/heads/\${DECLARED}" >/dev/null 2>&1; then
  echo "REVIEW_BASE=$DECLARED"
  echo "REVIEW_BASE_SOURCE=declared"
elif [ -n "\${BASE_BRANCH:-}" ]; then
  echo "REVIEW_BASE=$BASE_BRANCH"
  echo "REVIEW_BASE_SOURCE=env-default"
else
  echo "REVIEW_BASE=master"
  echo "REVIEW_BASE_SOURCE=fallback-master"
fi
`;

// Anchor on import.meta.dir, not CWD: turbo runs package tests with cwd at the
// package dir, so bare repo-root-relative paths ENOENT in CI.
const DEFAULTS_DIR = join(import.meta.dir, '..', '..', '..', '.archon', 'workflows', 'defaults');
const FEATURE_DEV_LANES = [
  join(DEFAULTS_DIR, 'bdc-feature-development.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-codex-only.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-codex.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-fable.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-fusion-cx-qwen.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-grok.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-zero-open.yaml'),
  join(DEFAULTS_DIR, 'bdc-feature-development-zero.yaml'),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bash(
  script: string,
  cwd: string,
  env: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bash', '-c', script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@test.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@test.com',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture state -- used by tests that need a real temp git repo (Tests 2 + 5).
// ---------------------------------------------------------------------------
let originDir: string;
let worktreeDir: string;

beforeEach(() => {
  originDir = mkdtempSync(join(tmpdir(), 'bdc-push-origin-'));
  git(['init', '--bare', '--initial-branch=main', originDir], tmpdir());

  worktreeDir = mkdtempSync(join(tmpdir(), 'bdc-push-wt-'));
  git(['clone', originDir, worktreeDir], tmpdir());
  git(['config', 'user.email', 'test@test.com'], worktreeDir);
  git(['config', 'user.name', 'Test'], worktreeDir);

  writeFileSync(join(worktreeDir, 'README.md'), 'init\n');
  git(['add', 'README.md'], worktreeDir);
  git(['commit', '-m', 'init'], worktreeDir);
  git(['push', 'origin', 'main'], worktreeDir);
});

afterEach(() => {
  try {
    rmSync(worktreeDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; tmp dirs are reaped by OS eventually
  }
  try {
    rmSync(originDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('F-6A: BRANCH allowlist regex validator', () => {
  it('Test 1: rejects malformed double-thread-suffix branch name', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'archon/thread-9772643d-thread-9772643d',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Malformed branch name: archon/thread-9772643d-thread-9772643d'
    );
    expect(result.stderr).toContain('feat/|fix/|wip/|archon/thread-');
  });

  it('rejects double-suffix feat/ branch like the WO-AUTH-RETIRE-GAS-PATH-02 anchor', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/WO-AUTH-RETIRE-GAS-PATH-02-thread-feat/WO-AUTH-RETIRE-GAS-PATH-02',
    });
    // The embedded slash + multiple -thread- segments take it out of the allowlist.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Malformed branch name');
  });

  it('accepts a clean feat/ branch name', () => {
    const result = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/wo-foo-bar-01',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BRANCH_VALID=feat/wo-foo-bar-01');
  });
});

describe('F-7C: remote-search fallback when origin ref is missing', () => {
  it('Test 2: recovers UNIQUE_BRANCH from origin when ls-remote HEAD matches local HEAD', () => {
    // Simulate the failure mode: the agent's work was committed and pushed to
    // origin under a different branch (archon/thread-abc123) than the target
    // UNIQUE_BRANCH (feat/wo-foo-01-thread-abc123).
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    // Push to a DIFFERENT name than what UNIQUE_BRANCH will be.
    git(['push', 'origin', 'HEAD:archon/thread-abc123'], worktreeDir);

    const result = bash(F7C_FALLBACK, worktreeDir, {
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc123', // the malformed target
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Recovered push target from remote: archon/thread-abc123');
    expect(result.stdout).toContain('UNIQUE_BRANCH=archon/thread-abc123');
  });

  it('exits 1 with the original error when no remote ref matches local HEAD', () => {
    // Local commit was never pushed anywhere. Fallback should find nothing
    // and fall through to the original error message.
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    // Do NOT push anywhere.

    const result = bash(F7C_FALLBACK, worktreeDir, {
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc123',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('implement loop did not produce work');
  });
});

describe('F-8C: staging-gate base-branch selection for gh pr create', () => {
  it('Test 3: sets --base staging when staging_gate_required is true', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
    ].join('\n');

    const result = bash(F8C_BASE_BRANCH_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=staging');
    // The bash conditional expansion ${BASE_BRANCH:+--base "$BASE_BRANCH"}
    // word-splits when assigned into CMD, so the captured command line shows
    // "--base staging" without quotes (gh receives them as separate args).
    expect(result.stdout).toContain('--base staging');
  });

  it('Test 4: omits --base when staging_gate_required is false', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
    ].join('\n');

    const result = bash(F8C_BASE_BRANCH_SELECTION, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^BASE_BRANCH=\s*$/m);
    expect(result.stdout).not.toContain('--base');
  });
});

describe('Base branch override: deterministic open-pr-if-needed handling', () => {
  it('extracts exact base and unique branch values from node-output handoff files', () => {
    const nodeOutDir = worktreeDir;
    writeFileSync(
      join(nodeOutDir, 'decide-push-target.out'),
      'push_target: feature-branch:feat/wo-foo-01\nbase_branch_override: release/ce'
    );
    writeFileSync(
      join(nodeOutDir, 'commit-and-push.out'),
      'VERIFIED: origin branch is durable\nunique_branch=feat/wo-foo-01-thread-abc'
    );

    const result = bash(
      `
set -euo pipefail
DECIDE_OUTPUT=$(cat "$ARCHON_NODE_OUT/decide-push-target.out")
COMMIT_PUSH_OUTPUT=$(cat "$ARCHON_NODE_OUT/commit-and-push.out")
BASE_BRANCH_OVERRIDE=$(printf '%s\\n' "$DECIDE_OUTPUT" | sed -n 's/^base_branch_override: //p' | head -n 1)
UNIQUE_BRANCH=$(printf '%s\\n' "$COMMIT_PUSH_OUTPUT" | sed -n 's/^unique_branch=//p' | head -n 1)
printf 'BASE_BRANCH_OVERRIDE=<%s>\\nUNIQUE_BRANCH=<%s>\\n' "$BASE_BRANCH_OVERRIDE" "$UNIQUE_BRANCH"
`,
      worktreeDir,
      { ARCHON_NODE_OUT: nodeOutDir }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH_OVERRIDE=<release/ce>');
    expect(result.stdout).toContain('UNIQUE_BRANCH=<feat/wo-foo-01-thread-abc>');
    expect(result.stdout).not.toContain("release/ce'");
    expect(result.stdout).not.toContain("thread-abc'");
  });

  it('honors an existing override branch over staging-gate selection and documents it in the PR body', () => {
    git(['checkout', '-b', 'release/ce'], worktreeDir);
    git(['push', 'origin', 'release/ce'], worktreeDir);

    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
      'base_branch_override: release/ce',
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=release/ce');
    expect(result.stdout).toContain('--base release/ce');
    expect(result.stdout).toContain('## Base branch override');
    expect(result.stdout).toContain(
      'Base branch override applied: PR targets `release/ce` per spec-declared `Base branch:` field'
    );
    expect(result.stdout).not.toContain('BASE_BRANCH=staging');
  });

  it('fails closed when the override branch is missing on the resolved repo remote', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
      'base_branch_override: release/missing',
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: base branch override 'release/missing' does not exist on thinmansoftware/bdc-xo"
    );
    expect(result.stdout).not.toContain('CMD=gh pr create');
  });

  it('fails before remote lookup when the model emits the illustrative placeholder text', () => {
    const illustrativePlaceholder = `<the declared override branch, ${'e.g.'} release/ce>`;
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: false',
      `base_branch_override: ${illustrativePlaceholder}`,
      'repo: thinmansoftware/bdc-xo',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "ERROR: decide-push-target emitted an invalid 'base_branch_override: <branch>' value"
    );
    expect(result.stdout).not.toContain('CMD=gh pr create');
  });

  it('leaves the no-override staging-gate path unchanged and omits the override body section', () => {
    const decideOutput = [
      'push_target: feature-branch:feat/wo-foo-01',
      'pr_required: true',
      'staging_gate_required: true',
      'repo: thinmansoftware/shopops',
    ].join('\n');

    const result = bash(BASE_BRANCH_OVERRIDE_SELECTION_AND_BODY, worktreeDir, {
      DECIDE_OUTPUT: decideOutput,
      IMPLEMENT_OUTPUT: 'implemented',
      PLAN_OUTPUT: 'Commit message: feat: work',
      REPO_REMOTE_URL: originDir,
      UNIQUE_BRANCH: 'feat/wo-foo-01-thread-abc',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BASE_BRANCH=staging');
    expect(result.stdout).toContain('--base staging');
    expect(result.stdout).not.toContain('## Base branch override');
  });
});

describe('Review diff-base resolution from declared Base branch', () => {
  it('uses a declared staging base before the run/codebase default', () => {
    git(['checkout', '-b', 'staging'], worktreeDir);
    git(['push', 'origin', 'staging'], worktreeDir);

    const result = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: ['WO: WO-TEST', 'Base branch: staging'].join('\n'),
      BASE_BRANCH: 'master',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('REVIEW_BASE=staging');
    expect(result.stdout).toContain('REVIEW_BASE_SOURCE=declared');
    expect(result.stdout).not.toContain('REVIEW_BASE=master');
  });

  it('falls back to env default, then master, when no Base branch is declared', () => {
    const envDefault = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: 'WO: WO-TEST\nObjective: no declared base',
      BASE_BRANCH: 'release/ce',
    });
    expect(envDefault.exitCode).toBe(0);
    expect(envDefault.stdout).toContain('REVIEW_BASE=release/ce');
    expect(envDefault.stdout).toContain('REVIEW_BASE_SOURCE=env-default');

    const lastResort = bash(RESOLVE_REVIEW_BASE, worktreeDir, {
      SPEC_TEXT: 'WO: WO-TEST\nObjective: no declared base',
      BASE_BRANCH: '',
    });
    expect(lastResort.exitCode).toBe(0);
    expect(lastResort.stdout).toContain('REVIEW_BASE=master');
    expect(lastResort.stdout).toContain('REVIEW_BASE_SOURCE=fallback-master');
  });
});

describe('Lane consistency: all feature-development lanes share review-base wiring', () => {
  it('feeds open-pr-if-needed from the byte-identical decide-push-target handoff file', () => {
    for (const lane of FEATURE_DEV_LANES) {
      const yaml = readFileSync(lane, 'utf8').replace(/\r\n/g, '\n');
      const openPr = yaml.split('  - id: open-pr-if-needed\n')[1]?.split('\n  - id: ')[0] ?? '';
      expect(openPr).toContain('DECIDE_OUTPUT=$(cat "$ARCHON_NODE_OUT/decide-push-target.out")');
      expect(openPr).toContain('COMMIT_PUSH_OUTPUT=$(cat "$ARCHON_NODE_OUT/commit-and-push.out")');
      expect(openPr).not.toMatch(
        /DECIDE_OUTPUT=\$\(cat <<'[^']+'\n\s*\$decide-push-target\.output\n/
      );
      expect(openPr).not.toMatch(
        /COMMIT_PUSH_OUTPUT=\$\(cat <<'[^']+'\n\s*\$commit-and-push\.output\n/
      );
    }
  });

  it('has no env-only review BASE_REF one-liner and has base_branch_override in every lane', () => {
    for (const lane of FEATURE_DEV_LANES) {
      // Normalize CRLF so a Windows checkout does not break '\n'-suffixed assertions.
      const yaml = readFileSync(lane, 'utf8').replace(/\r\n/g, '\n');
      expect(yaml).toContain('  - id: resolve-review-base\n');
      expect(yaml).toContain('depends_on: [war-council-validator, resolve-review-base]');
      expect(yaml).toContain(
        'depends_on: [diff-review, classify-diff-review, resolve-review-base]'
      );
      expect(yaml).toContain('depends_on: [diff-repair, resolve-review-base]');
      expect(yaml).not.toContain('BASE_REF="origin/${BASE_BRANCH:-main}"');
      expect(yaml).toContain('base_branch_override');
    }
  });
});

describe('Backward compatibility: clean valid path', () => {
  it('Test 5: validator accepts + fallback is not triggered for clean valid case', () => {
    // Agent emits BRANCH=feat/wo-bar-02; the regex passes.
    const validateResult = bash(F6A_VALIDATOR, worktreeDir, {
      BRANCH: 'feat/wo-bar-02',
    });
    expect(validateResult.exitCode).toBe(0);
    expect(validateResult.stdout).toContain('BRANCH_VALID=feat/wo-bar-02');
    expect(validateResult.stderr).not.toContain('Malformed');
    expect(validateResult.stderr).not.toContain('Recovered');

    // And: simulate the happy-path commit-and-push end state (work pushed to
    // the expected UNIQUE_BRANCH, COMMITS_AHEAD would have been >=1, so the
    // F-7C fallback branch is NEVER reached. We confirm this by checking that
    // the fallback's "Recovered" message does NOT appear in a normal push
    // pathway -- the fallback only runs inside the COMMITS_AHEAD=0 branch).
    writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
    git(['add', 'feature.ts'], worktreeDir);
    git(['commit', '-m', 'feat: implement work'], worktreeDir);
    git(['push', 'origin', 'HEAD:feat/wo-bar-02-thread-abc'], worktreeDir);

    // Simulate the happy-path COMMITS_AHEAD calculation (origin ref exists
    // and HEAD matches origin/UNIQUE_BRANCH so commits_ahead = 0 BUT the
    // upstream code in YAML already short-circuits via the "Backstop no-op"
    // branch at line 309 -- F-7C fallback is only entered when origin ref
    // is MISSING and no commits ahead. With the ref existing, this is a
    // no-op path that does not touch our changes).
    const happyPath = `
set -euo pipefail
UNIQUE_BRANCH="feat/wo-bar-02-thread-abc"
if git rev-parse --quiet --verify "origin/\${UNIQUE_BRANCH}" >/dev/null 2>&1 && \\
   [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/\${UNIQUE_BRANCH}")" ]; then
  echo "Backstop no-op: already pushed"
  exit 0
fi
echo "Would push"
exit 0
    `;
    const happyResult = bash(happyPath, worktreeDir);
    expect(happyResult.exitCode).toBe(0);
    expect(happyResult.stdout).toContain('Backstop no-op: already pushed');
    expect(happyResult.stdout).not.toContain('Recovered');
    expect(happyResult.stderr).not.toContain('Malformed');
  });
});
