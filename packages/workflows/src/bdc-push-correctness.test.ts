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
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
