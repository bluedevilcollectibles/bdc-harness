# Cauldron Working Directories and Repo Targeting

**WO**: WO-HARNESS-GH-PR-EXPLICIT-R-FLAG-01 (bdc-xo#191)
**Date**: 2026-05-16

## Incident Summary

2026-05-16 engine sortie. `bdc-author-wo-batch.yaml`'s `commit-and-push` node ran
`gh pr create` without `-R`. It defaulted to the worktree's `origin` (`bdc-harness`),
not the spec content's actual target (`bdc-xo`). Auth failure masked the bug that day
(fixed in PR #82), but had auth succeeded the PR would have opened on the wrong repo
against the wrong base branch.

## Root Cause

When Archon executes a workflow, each node runs in a git worktree cloned from the source
repo (`bdc-harness`). The worktree's `origin` is always `bdc-harness` — regardless of
which repo the WO spec targets.

`gh pr create` without `--repo` defaults to the current directory's `origin`. Any workflow
that shells out to `gh pr create` without an explicit `--repo` silently targets
`bdc-harness` even when the spec says "open this PR on `bdc-xo`" or `lspro-react`.

## Defense in Depth: Rule 28 + Rule 29

These two rules close the wrong-repo class from both ends.

### Rule 28 — Overlord Dispatch Validation
Overlord (the workflow dispatcher) validates `target_repo` at dispatch time before the
workflow starts. Prevents wrong-repo work from beginning at all.

### Rule 29 — Explicit `--repo` on Every `gh pr create`
Every `gh pr create` call in a bash node MUST include `--repo <owner>/<repo>`. Never
let `gh` default to the worktree's origin. The target repo is always derived from:
1. Spec-extracted `target_repo:` field
2. Spec-extracted `**Target repo:**` Markdown pattern
3. Hard-coded constant (for workflows with a fixed known target)

Either rule alone closes most cases. Both together close the class.

## Fix Inventory (this WO)

| File | Change |
|------|--------|
| `.archon/workflows/defaults/bdc-feature-development.yaml` | `decide-push-target` now extracts `target_repo` from spec and emits `repo: <owner>/<repo>`; `open-pr-if-needed` reads REPO and passes `--repo "$REPO"` |
| `.archon/workflows/defaults/bdc-cleanup-sweep.yaml` | Same pattern |
| `.archon/workflows/defaults/bdc-bug-fix.yaml` | Same pattern |
| `.archon/workflows/defaults/bdc-infra-deploy.yaml` | Hard-coded `--repo bluedevilcollectibles/bdc-harness` (infra PRs always target harness) |
| `scripts/lint-yaml.sh` | New lint gate that fails on bare `gh pr create` in `bdc-*.yaml` bash nodes |

## Lint Command

```bash
bash scripts/lint-yaml.sh
# or with explicit directory:
bash scripts/lint-yaml.sh .archon/workflows/defaults/
```

Exits non-zero and prints all violations if any bare `gh pr create` is found in
`bdc-*.yaml` files. Accepts both `--repo` and `-R` as compliant forms.

## spec-derived target_repo Extraction Pattern

`decide-push-target` prompt nodes now look for the target repo via these patterns
(in priority order):

1. `target_repo: <owner>/<repo>` — YAML field
2. `` **Target repo:** `<owner>/<repo>` `` — Markdown bold with backticks
3. `Target repo: <owner>/<repo>` — plain header line
4. `` **Target Repo:** `<owner>/<repo>` `` — Markdown bold, capital R variant

If none match, the agent emits `repo: unknown` and the `open-pr-if-needed` node
fails closed with a clear error message rather than defaulting to the worktree origin.
