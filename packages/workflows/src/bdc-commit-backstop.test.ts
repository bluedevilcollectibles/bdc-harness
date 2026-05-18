/**
 * Behavioral tests for the commit-and-push backstop fix.
 *
 * WO-HARNESS-COMMIT-AND-PUSH-BACKSTOP-FALSE-NEGATIVE-01
 *
 * Tests the bash logic used in bdc-feature-development.yaml, bdc-bug-fix.yaml,
 * bdc-cleanup-sweep.yaml, and bdc-doctrine-update.yaml commit-and-push nodes.
 *
 * Runs in a real temp git repo via Bun.spawnSync so no mock.module() calls are
 * needed — safe to run in its own bun test invocation without cross-file pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The core backstop bash logic extracted from the fixed commit-and-push nodes.
// Uses BRANCH variable passed via env to bash (set before this snippet in the workflow).
// $DIRTY, $BRANCH etc. without braces are fine in TS template literals; \${BRANCH}
// escapes the curly-brace form so TS doesn't try to interpolate it.
const BACKSTOP_SCRIPT = `
set -euo pipefail
DIRTY=$(git status --porcelain)
if [ -z "$DIRTY" ]; then
  if git rev-parse --quiet --verify "origin/$BRANCH" >/dev/null 2>&1 && \\
     [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ]; then
    echo "BACKSTOP_RESULT=already_synced"
    exit 0
  fi
  if git rev-parse --quiet --verify "origin/\${BRANCH}" >/dev/null 2>&1; then
    COMMITS_AHEAD=$(git rev-list --count "origin/\${BRANCH}..HEAD" 2>/dev/null || echo 0)
  else
    COMMITS_AHEAD=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)
  fi
  if [ "$COMMITS_AHEAD" = "0" ]; then
    echo "BACKSTOP_RESULT=true_noop"
    exit 1
  fi
  echo "BACKSTOP_RESULT=push_needed commits_ahead=$COMMITS_AHEAD"
  exit 0
else
  echo "BACKSTOP_RESULT=dirty_tree"
  exit 0
fi
`;

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

let originDir: string;
let worktreeDir: string;

beforeEach(() => {
  // Create a bare origin repo with explicit 'main' as initial branch
  originDir = mkdtempSync(join(tmpdir(), 'bdc-backstop-origin-'));
  git(['init', '--bare', '--initial-branch=main', originDir], tmpdir());

  // Create a local clone (simulates the workflow worktree)
  worktreeDir = mkdtempSync(join(tmpdir(), 'bdc-backstop-wt-'));
  git(['clone', originDir, worktreeDir], tmpdir());
  git(['config', 'user.email', 'test@test.com'], worktreeDir);
  git(['config', 'user.name', 'Test'], worktreeDir);

  // Make an initial commit on main so origin/main exists
  writeFileSync(join(worktreeDir, 'README.md'), 'init\n');
  git(['add', 'README.md'], worktreeDir);
  git(['commit', '-m', 'init'], worktreeDir);
  git(['push', 'origin', 'main'], worktreeDir);

  // Create and switch to the feature branch (simulates git checkout -B in the workflow)
  git(['checkout', '-B', 'feature-test'], worktreeDir);
});

afterEach(() => {
  try {
    rmSync(worktreeDir, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(originDir, { recursive: true, force: true });
  } catch {}
});

describe('commit-and-push backstop logic', () => {
  describe('Scenario A: implement loop committed AND pushed (already synced)', () => {
    it('exits 0 with already_synced when origin/BRANCH exists and HEAD matches', () => {
      // Simulate: implement loop made a commit and pushed it
      writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
      git(['add', 'feature.ts'], worktreeDir);
      git(['commit', '-m', 'feat: implement work'], worktreeDir);
      git(['push', 'origin', 'feature-test'], worktreeDir);

      // Working tree is clean; origin/feature-test exists and HEAD matches
      const result = bash(BACKSTOP_SCRIPT, worktreeDir, { BRANCH: 'feature-test' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('BACKSTOP_RESULT=already_synced');
    });
  });

  describe('Scenario B: implement loop committed but did NOT push (false-negative case)', () => {
    it('exits 0 with push_needed when tree is clean but commits exist ahead of origin', () => {
      // Simulate: implement loop committed but push was skipped/failed
      writeFileSync(join(worktreeDir, 'feature.ts'), 'export const x = 1;\n');
      git(['add', 'feature.ts'], worktreeDir);
      git(['commit', '-m', 'feat: implement work'], worktreeDir);
      // Do NOT push — this is the false-negative scenario

      // Working tree is clean; but HEAD is ahead of origin (no origin/feature-test yet)
      const result = bash(BACKSTOP_SCRIPT, worktreeDir, { BRANCH: 'feature-test' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('BACKSTOP_RESULT=push_needed');
      expect(result.stdout).toContain('commits_ahead=1');
    });

    it('exits 0 with push_needed when multiple commits exist ahead', () => {
      writeFileSync(join(worktreeDir, 'a.ts'), 'a\n');
      git(['add', 'a.ts'], worktreeDir);
      git(['commit', '-m', 'feat: first'], worktreeDir);
      writeFileSync(join(worktreeDir, 'b.ts'), 'b\n');
      git(['add', 'b.ts'], worktreeDir);
      git(['commit', '-m', 'feat: second'], worktreeDir);
      // Not pushed

      const result = bash(BACKSTOP_SCRIPT, worktreeDir, { BRANCH: 'feature-test' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('BACKSTOP_RESULT=push_needed');
      expect(result.stdout).toContain('commits_ahead=2');
    });
  });

  describe('Scenario C: implement loop did nothing (true no-op)', () => {
    it('exits 1 with true_noop when tree is clean and no commits ahead', () => {
      // No work done: HEAD is at origin/main, feature branch has no extra commits
      const result = bash(BACKSTOP_SCRIPT, worktreeDir, { BRANCH: 'feature-test' });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('BACKSTOP_RESULT=true_noop');
    });
  });

  describe('Scenario D: dirty working tree (uncommitted changes)', () => {
    it('exits 0 with dirty_tree when files are modified but not committed', () => {
      writeFileSync(join(worktreeDir, 'feature.ts'), 'uncommitted work\n');
      // Not staged, not committed — dirty tree

      const result = bash(BACKSTOP_SCRIPT, worktreeDir, { BRANCH: 'feature-test' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('BACKSTOP_RESULT=dirty_tree');
    });
  });
});
