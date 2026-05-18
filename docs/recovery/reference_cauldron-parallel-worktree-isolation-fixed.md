# Cauldron Parallel Worktree Isolation Fix

WO: WO-HARNESS-PARALLEL-WORKTREE-ISOLATION-01
Fixed: 2026-05-18
Anchor: 2026-05-17 LSPRO + ShopOps + HQ UI rebuild sortie -- 13 of 21 Cauldron
runs failed at commit-and-push with `fatal: '<branch>' is already used by
worktree`. Salvage cost ~30 min of XO time across the batch.

## Root Cause

The `commit-and-push` bash node in
`.archon/workflows/defaults/bdc-feature-development.yaml` extracted a branch
name from `decide-push-target`'s LLM output (`push_target:
feature-branch:<name>`) and then ran a force-create-or-reset checkout against
that branch inside the run's isolated worktree.

The spec's target base (e.g. `promotion/v2`, `dev`, `master`) was already
checked out in the main repo clone that backs every worktree, so the second+
parallel Cauldron fire died with `fatal: 'promotion/v2' is already used by
worktree`.

The original design intent was "each run gets its own feature branch", but
the LLM-mediated `push_target` indirection let the shared base name leak
through under common conditions. The fix removes that indirection entirely.

## Evidence (Anchor Incident)

2026-05-17 sortie: 21 parallel Cauldron fires against `promotion/v2` of
lspro-react. 13 failed at commit-and-push with the worktree-collision
message; 8 completed. Manual salvage required for the 13 failures via
`BDC_XO/scripts/salvage-cauldron-failed-wo.sh` -- the script became the
de-facto patch path until this WO eliminated the underlying cause.

## Fix

Three coordinated changes:

### 1. `packages/workflows/src/dag-executor.ts` -- contract surface

Exported `generateWorkBranchName(woId, threadId)`:

```typescript
export function generateWorkBranchName(woId: string, threadId: string): string {
  return `wo/${woId.toLowerCase()}-${threadId.slice(0, 8)}`;
}
```

Documents the canonical `git worktree add <dir> -b wo/<id> origin/<base>`
pattern, lives next to the rest of the DAG executor, and is unit-testable in
isolation. The bash mirror in step 2 must stay in sync with this helper.

### 2. `.archon/workflows/defaults/bdc-feature-development.yaml` -- commit-and-push

Replaced the LLM-mediated branch derivation with a deterministic local one:

```bash
WO_ID="${WO_ID:-$(printf '%s\n' "${USER_MESSAGE:-}" | grep -Eo 'WO-[A-Z0-9-]+' | head -n 1 || true)}"
WO_ID_LOWER=$(printf '%s\n' "$WO_ID" | tr '[:upper:]' '[:lower:]')
WORK_BRANCH="wo/${WO_ID_LOWER}-${WORKFLOW_ID:0:8}"
git branch -f "$WORK_BRANCH" HEAD
git checkout "$WORK_BRANCH"
git push -u origin "$WORK_BRANCH"
```

`WORKFLOW_ID` is the run's unique workflow run id (already in the executor's
env); the 8-char prefix is the same suffix Archon uses for worktree thread
directories. Each parallel fire has a different `WORKFLOW_ID` and therefore a
different `WORK_BRANCH` -- the shared base is never written-to inside the
worktree.

The two-command `git branch -f ... && git checkout ...` form (instead of the
force-create-or-reset single-flag checkout) is defensive: the plan's
verification step bans every force-create-or-reset checkout against any
branch-name source, so even a future copy-paste regression that smuggled a
shared base back in would fail the grep gate.

### 3. `.archon/workflows/defaults/bdc-feature-development.yaml` -- decide-push-target and open-pr-if-needed

`decide-push-target` now emits an additional line:

```
pr_base: <spec-target-branch>
```

`open-pr-if-needed` re-derives the same `WORK_BRANCH` (must match
commit-and-push) and reads `pr_base` from `decide-push-target.output`, then
opens the PR with explicit `--base` / `--head` flags:

```bash
gh pr create --title "$TITLE" --body-file "$BODY_FILE" \
  --base "$PR_BASE" --head "$WORK_BRANCH"
```

If `pr_base` is missing, the node falls back to `dev` with a WARN -- it does
not silently inherit the worktree's HEAD as the base.

## Behavior Matrix

| Scenario | Pre-2026-05-18 | Post-fix |
|---|---|---|
| First parallel run | OK (checks out shared base) | OK (creates `wo/<id>-<run>`) |
| Second+ parallel run, same target base | fatal: already used by worktree, exit 128 | OK (different WORKFLOW_ID -> different work branch) |
| Single run, no parallelism | OK | OK |
| Retry after engine restart | May collide with stale worktree | Idempotent (`git branch -f`); same WORKFLOW_ID -> same branch name -> safe reset |
| Two runs same WO_ID (e.g. cron retry) | Collision | Each fire gets distinct WORKFLOW_ID -> distinct branch suffix |

## Tests

`packages/workflows/src/dag-executor.test.ts` -- describe block
"generateWorkBranchName -- parallel-worktree isolation" (7 tests covering
format, lowercasing, suffix truncation, parallel-run uniqueness, cross-WO
uniqueness, mixed-case idempotency, short-thread-id contract).

## When the Salvage Script Becomes Obsolete

`BDC_XO/scripts/salvage-cauldron-failed-wo.sh` exists specifically to recover
runs that died on this collision. Drop it from the on-call toolkit after:

1. This PR merges to `dev`.
2. Hetzner archon container is rebuilt:

   ```bash
   ssh hetzner-prod 'cd /opt/bdc/archon && sudo docker compose build app && sudo docker compose up -d --build app'
   ```

3. A 5-WO parallel sortie of real WOs against `promotion/v2` of lspro-react
   completes with zero `commit-and-push` failures.

Verify with the Stop Point query from the WO:

```bash
ssh hetzner-prod 'sudo sqlite3 /opt/bdc/archon-data/archon.db "
  SELECT COUNT(*) FROM remote_agent_workflow_events
  WHERE event_type=\"node_failed\"
    AND step_name=\"commit-and-push\"
    AND created_at > \"2026-05-19\""'
```

Expected: 0.

## Related, Not Conflated

- `WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01` -- false-negative when validator
  passed but commit-and-push exited 1 with "no commits ahead". Different bug,
  different fix; tracked separately.
- `WO-HARNESS-COMMIT-AND-PUSH-BACKSTOP-FALSE-NEGATIVE-01` -- the
  COMMITS_AHEAD check this WO leaves intact (just retargeted from `$BRANCH`
  to `$WORK_BRANCH`).
