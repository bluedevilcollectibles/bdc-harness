# Host Artifact Recovery (WO-168 Tier 1)

When a load-bearing Cauldron workflow node fails to push to GitHub, or the
container worktree is pruned before push succeeds, the work is **not** lost —
it has been saved to a host bind mount at `/host-artifacts` inside the
container, which maps to `./harness-artifacts/` on the host (or wherever
`HARNESS_ARTIFACTS` points in `.env`).

## Anchor incident

**2026-05-16 engine sortie**: 26 files authored on a container worktree
branch. The `git push` step appeared to succeed but actually failed silently;
the worktree was then cleaned up by a subsequent step. All 13 spec files
authored in that batch were unrecoverable from the container — there was no
host-side copy.

WO-168 Tier 1 adds two safety nets so this cannot happen again:

1. A new docker-compose volume `${HARNESS_ARTIFACTS:-./harness-artifacts}:/host-artifacts`
2. A `save_bundle_to_host` bash function called by load-bearing commit nodes
   **before** the `git push` is attempted

## What gets saved

For each workflow run, a directory `/host-artifacts/<WORKFLOW_RUN_ID>/` is
created containing:

| File          | Contents                                                       |
|---------------|----------------------------------------------------------------|
| `branch.bundle` | `git bundle create HEAD` — full reachable history of the branch |
| `changes.txt`   | `git diff --stat HEAD~1 HEAD` (or `git log --name-status` fallback) |
| `MANIFEST.txt`  | branch name, sha, saved_at timestamp, run id, recovery command |
| `bundle.err`    | stderr from `git bundle create` (only present on failure)      |

## Recovery procedure

### Step 1: Locate the bundle on the host

```bash
# On the Hetzner host (or wherever bdc-harness runs):
ls -la /opt/bdc-harness/harness-artifacts/
# or wherever HARNESS_ARTIFACTS points
```

Each subdirectory is one workflow run. The most recent failed run is usually
the one you want; check `MANIFEST.txt` to confirm.

### Step 2: Inspect what was saved

```bash
cat harness-artifacts/<RUN_ID>/MANIFEST.txt
cat harness-artifacts/<RUN_ID>/changes.txt
git bundle verify harness-artifacts/<RUN_ID>/branch.bundle
```

`git bundle verify` should report `harness-artifacts/<RUN_ID>/branch.bundle is okay`
plus a list of refs and prerequisite commits.

### Step 3: Fetch the bundle back into a real repo

From inside a clone of the target repo (e.g., bdc-xo or bdc-harness):

```bash
git fetch /absolute/path/to/harness-artifacts/<RUN_ID>/branch.bundle \
  main:rescue-<RUN_ID>
```

This creates a new local branch `rescue-<RUN_ID>` pointing at the saved commit.

The exact command is written into `MANIFEST.txt` as `recovery_cmd=...` so you
can copy-paste it without thinking.

### Step 4: Push the rescued branch to GitHub

```bash
git checkout rescue-<RUN_ID>
git log --oneline -5   # sanity check
git push -u origin rescue-<RUN_ID>
gh pr create --base dev --head rescue-<RUN_ID> \
  --title "rescue: recover WO output from failed cauldron push <RUN_ID>"
```

Or rebase onto current `dev`/`main` and open a normal PR.

## Retention

The host directory `./harness-artifacts/` retains bundles for **30 days**
(operator-managed; no auto-prune yet — file a follow-up WO if accumulation
becomes a problem). Drive-tier preservation (indefinite, human-readable
spec files via Drive API) is **Tier 2** and ships in the follow-up WO; not
implemented in this PR.

## What is NOT covered by Tier 1

- **Untracked / uncommitted files**: `git bundle` only includes committed
  objects reachable from HEAD. If the workflow fails before the commit step,
  the working-tree contents are still lost. Tier 2 (Drive sync of spec MDs)
  will close this gap for human-readable artifacts.
- **Retry logic**: WO-169 covers push retry with exponential backoff. Tier 1
  is the safety net for when retry also fails.
- **Cross-run discovery**: there is no index file listing all bundles. Use
  `ls -lt harness-artifacts/` sorted by mtime to find recent runs.

## Verifying the mount on a running container

```bash
docker exec archon-app-1 ls -la /host-artifacts/ 2>&1 || \
  echo "mount missing — rebuild container with updated docker-compose.yml"
```

If the mount is missing, the `save_bundle_to_host` helper logs a `WARN` and
returns 0 (best-effort, never blocks the push), so older containers without
the mount keep working but get no Tier 1 protection.
