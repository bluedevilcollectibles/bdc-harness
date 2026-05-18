# Cauldron Working Directories — Cross-Repo Incident Anchor

**Date:** 2026-05-16
**Status:** Implemented (guard live as of WO-HARNESS-WORKFLOW-CWD-TARGET-REPO-01)

## Incident Summary

During the 2026-05-16 engine sortie, the `bdc-author-wo-batch` workflow fired against the
`bdc-harness` codebase. The operator selected the wrong dropdown. The workflow authored
26 files of `bdc-xo` spec content, committed locally, and pushed to
`bdc-harness/wo/author-wo-batch-run-20260516170933`. PR creation failed (wrong repo).
The worktree was later pruned. Work was considered lost for hours before being found on
the wrong remote.

Root cause: no guard prevented a workflow whose deliverables belong in `bdc-xo` from
running inside a `bdc-harness` worktree.

## Rule 28 — Target Repo Guard (Implemented)

Workflows that author deliverables for a specific target repo MUST declare that repo in
their YAML. The executor enforces the match before any nodes run.

### YAML syntax

```yaml
target_repo: bluedevilcollectibles/bdc-xo
```

Add at workflow root, alongside `model:` and `policyFile:`. Value is `owner/repo` format.

### Enforcement

When `target_repo` is declared, `executeWorkflow()` in `packages/workflows/src/executor.ts`
runs a pre-flight check:

1. Calls `getRemoteUrl(toRepoPath(cwd))` to get the worktree's `origin` URL.
2. Normalizes both URLs to `owner/repo` (lowercase, strips `.git`, handles SSH and HTTPS).
3. If they differ: emits `dag_workflow_failed` event (reason: `target_repo_mismatch`),
   calls `failWorkflowRun`, sends an actionable error message to the user, and returns
   `{ success: false }` — no nodes run.
4. If they match: execution proceeds normally.

### Event written on mismatch

```json
{
  "event_type": "dag_workflow_failed",
  "data": {
    "reason": "target_repo_mismatch",
    "expected": "bluedevilcollectibles/bdc-xo",
    "actual": "bluedevilcollectibles/bdc-harness"
  }
}
```

### User message on mismatch

```
**Workflow blocked**: `bdc-author-wo-batch` declares `target_repo: bluedevilcollectibles/bdc-xo`
but this worktree's origin points at `https://github.com/bluedevilcollectibles/bdc-harness.git`.

Select the correct codebase (`bluedevilcollectibles/bdc-xo`) and retry.
```

### First YAML to declare target_repo

`.archon/workflows/defaults/bdc-author-wo-batch.yaml` — declares
`target_repo: bluedevilcollectibles/bdc-xo`.

## Out of Scope

- Auto-correction (clone the right repo): fail-fast is correct; operator picks codebase.
- Multi-repo workflows (target_repo dynamic per-node): separate WO if needed.

## Related

- WO-HARNESS-WORKFLOW-CWD-TARGET-REPO-01 — implementation WO
- `packages/workflows/src/executor.ts` — `normalizeRemoteToOwnerRepo()` + pre-flight block
- `packages/workflows/src/store.ts` — `dag_workflow_failed` event type
- `packages/workflows/src/schemas/workflow.ts` — `target_repo` field on `workflowBaseSchema`
- `xo-wiki/wiki/doctrine/archon-yaml-authoring/_index.md` — Rule 28 doctrine entry
