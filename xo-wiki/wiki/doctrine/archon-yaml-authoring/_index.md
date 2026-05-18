# Archon YAML Authoring Doctrine

Hard rules for Devils Cauldron workflow YAML files (`.archon/workflows/`).
Violations are caught at load time (loader) or execution time (executor).

---

## Rule 1 — model: sonnet at workflow root

Every workflow YAML must declare `model: sonnet` at the root level.

```yaml
model: sonnet
```

---

## Rule 2 — policyFile at workflow root

Every BDC harness workflow must declare `policyFile: harness/policies/agent-behavior.md`
at the root level so all AI nodes receive the BDC agent behavior policy.

```yaml
policyFile: harness/policies/agent-behavior.md
```

---

## Rule 3 — All file paths relative to repo root

All paths inside workflow YAML (policyFile, bash node paths, artifact paths) must be
relative to the repo root — no `owner/repo/` prefix, no absolute paths.

---

## Rule 4 — loop: requires all four fields

Every `loop:` node must declare all four fields explicitly:

```yaml
loop:
  prompt: |
    ...
  until: MY_SENTINEL
  max_iterations: 8
  fresh_context: true
```

Omitting any field is a schema validation error (rejected at load).

---

## Rule 5 — flip-notion is the final node

Every workflow that touches Notion state must end with a `flip-notion` node.
Archon does not auto-update Notion on workflow completion.

---

## Rule 6 — No curl to n8n in bash nodes

`curl` calls to `n8n.bluedevilcollectibles.com` hang in executor subprocesses.
Use the Notion MCP tool in prompt nodes instead.

---

## Rule 7 — Use $WORKFLOW_ID, not ${run.id}

Variable substitution happens at YAML-parse time. `$WORKFLOW_ID` is the correct
token. `${run.id}` is not substituted and arrives as a literal string.

Do NOT use `set -u` in bash nodes that reference `$WORKFLOW_ID` — it is not a
runtime environment variable.

---

## Rule 8 — load_bearing: true on push and PR nodes

Nodes that push commits or create PRs must declare `load_bearing: true`.
This prevents the workflow from silently succeeding when these critical steps fail.

---

## Rule 9 — Real retry guards with exit 1

Push and PR creation bash nodes must use explicit retry loops that call `exit 1`
on final failure. Never use `|| echo 'STATUS=*_failed'` as a substitute for proper
error handling — it masks failures and the workflow reports success.

---

## Rule 10 — CWD scope comment block

Every workflow that runs against a specific repo must include a pre-flight comment
block documenting:

1. YAML exists: this file
2. Spec exists: path to spec doc
3. CWD scope: which codebase to select in the Archon UI
4. Codebase registered: owner/repo (verify in Archon DB)

---

## Rule 11 — set -e compatibility

Under `set -euo pipefail`, `[ condition ] && command` exits with code 1 if the
condition is false. This kills the node silently. Use `if [ condition ]; then command; fi`
instead.

---

## Rule 12 — Inputs via INPUT\_ prefix

When using the Cauldron API (not `/workflow run` CLI), the engine injects `inputs`
defaults as `$INPUT_<NAME>` environment variables. Bash nodes must use the dual-path
pattern:

```bash
MY_VAR="${INPUT_MY_VAR:-${MY_VAR:-default}}"
```

---

## Rule 13 — Until sentinel must be namespaced

Loop `until:` values must be unique per workflow to avoid false matches. Use
`WORKFLOW_NAME_SENTINEL` format (e.g. `VALIDATE_PASS_ALL`, not `DONE`).

---

## Rule 28 — target_repo: cross-repo mismatch guard

Workflows that author deliverables for a specific target repository MUST declare
`target_repo` at the workflow root. The executor verifies the worktree's `git remote
get-url origin` matches before any nodes run.

**Anchor:** 2026-05-16 engine sortie. `bdc-author-wo-batch` fired against `bdc-harness`
codebase (operator selected wrong dropdown). 26 files of `bdc-xo` spec content committed,
pushed to wrong remote, worktree pruned, work considered lost for hours.

### Syntax

```yaml
target_repo: bluedevilcollectibles/bdc-xo
```

Value format: `owner/repo` (no `.git` suffix, no `https://github.com/` prefix).
Case-insensitive comparison. Both HTTPS and SSH remote URLs are supported.

### What happens on mismatch

The executor (before any nodes run):

1. Emits `dag_workflow_failed` event with `reason: target_repo_mismatch`.
2. Calls `failWorkflowRun`.
3. Sends actionable message: "Workflow blocked — select the correct codebase and retry."
4. Returns `{ success: false }`.

### What happens on match

Execution proceeds normally. The check adds one `git remote get-url origin` call
(< 50ms) to the pre-flight phase.

### Out of scope

Auto-correction (cloning the right repo) is intentionally excluded. Fail-fast is correct
behavior — the operator must select the correct codebase in the dropdown.

### Reference

- `packages/workflows/src/executor.ts` — `normalizeRemoteToOwnerRepo()` + pre-flight block
- `packages/workflows/src/schemas/workflow.ts` — `target_repo` field definition
- `packages/workflows/src/store.ts` — `dag_workflow_failed` event type
- `docs/architecture/2026-05-16-cauldron-working-directories.md` — full incident anchor
- WO-HARNESS-WORKFLOW-CWD-TARGET-REPO-01 — implementation work order
