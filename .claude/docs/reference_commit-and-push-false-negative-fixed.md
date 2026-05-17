# commit-and-push Backstop False-Negative Fix

WO: WO-HARNESS-COMMIT-AND-PUSH-BACKSTOP-FALSE-NEGATIVE-01
Fixed: 2026-05-17
Anchor: Wave 4 cron fire -- 5 real WO commits destroyed before manual recovery

## Root Cause

The commit-and-push nodes in four BDC workflows used `git status --porcelain` to detect
whether the implement loop had done any work. A clean working tree was incorrectly
interpreted as "no work was done." If the implement loop committed (Patch 2), the tree is
clean BECAUSE work was committed -- not because nothing happened.

Bug: clean tree + commits ahead of origin -> false exit 1 ("no changed files found; cannot commit").

## Evidence

Wave 4 cron fire 2026-05-17: 5 of 10 bdc-feature-development runs failed at commit-and-push
despite having real commits. Salvaged manually as shopops#90-94.

## Fix

Added COMMITS_AHEAD check alongside dirty-tree check. Three-way distinction:
1. DIRTY=empty + origin/BRANCH exists + HEAD==origin/BRANCH -> already synced -> exit 0
2. DIRTY=empty + COMMITS_AHEAD > 0 -> pre-committed, push needed -> exit 0 (THE FIX)
3. DIRTY=empty + COMMITS_AHEAD = 0 -> true no-op -> exit 1 (correct rejection)

COMMITS_AHEAD computation:
- git rev-list --count "origin/BRANCH..HEAD"  (when branch exists on remote)
- git rev-list --count HEAD --not --remotes=origin  (when branch is new/local-only)

## Affected Workflows (all four fixed)

bdc-feature-development.yaml, bdc-bug-fix.yaml, bdc-cleanup-sweep.yaml, bdc-doctrine-update.yaml

bdc-infra-deploy.yaml has a cousin bug (silently exits 0 instead of pushing) -- separate WO.

## Tests Added

packages/workflows/src/bdc-commit-backstop.test.ts -- 5 behavioral bash tests (Scenarios A-D)
packages/workflows/src/defaults/bundled-defaults.test.ts -- 8 regression assertions

## Note on Spec vs Codebase (Rule 17)

Spec said error message was "No changed files AND remote branch missing/behind -- implement loop
did not commit." This string did NOT exist in any YAML. Actual message was "No changed files
found; cannot commit." Codebase is ground truth.
