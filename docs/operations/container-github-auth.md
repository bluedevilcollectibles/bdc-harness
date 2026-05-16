# Container GitHub Auth Boundary

**WO**: WO-HARNESS-CONTAINER-GITHUB-AUTH-BOUNDARY-01 (bdc-xo#171)
**Anchor incidents**: 2026-05-15 persona schema #132 close call (recovered via manual git bundle + scp), 2026-05-16 engine sortie loss (13 specs).

## Problem

Cauldron workflows that author branches and PRs (`bdc-sync-workflows`, `bdc-author-wo-batch`, persona schema, engine sortie) run inside the `archon-app-1` container and shell out to `git push` / `gh pr create`. When the container does not have a usable GitHub token visible to those subprocesses, the push fails silently — the workflow node returns `exit 0` because the push command itself wrote its error to stderr and exited 1, but downstream nodes never check and proceed assuming work landed on GitHub.

Symptom seen in the wild: work appears to complete inside the container, but no branch exists on GitHub, no PR was opened, and recovery requires manually `docker exec`-ing in, creating a `git bundle`, `scp`-ing it to the host, and pushing from there.

## Root cause

Two name collisions, both pre-existing in this fork:

1. `docker-entrypoint.sh` (line 59 before this WO) only installed the git credential helper if `$GH_TOKEN` was set. Operations have been populating `.env` with `GITHUB_TOKEN` (the name the GitHub CLI and most CI conventions use). Result: the credential helper was never registered, and `git push` to HTTPS remotes had no way to authenticate.

2. `docker-compose.yml` relied on `env_file: .env` to carry the token into the container. That works for the value already present in `.env`, but offers no explicit declaration that the container REQUIRES it, no fallback to host shell env, and no signal in `docker compose config` that the variable is part of the contract.

The token itself (in `.env` and on Hetzner) has correct scopes: `gist`, `read:org`, `repo`, `workflow`. The failure was never about scope — it was about whether the running git process could see the credential.

## Fix (this WO)

### docker-compose.yml

Explicit `environment:` mapping for both `GITHUB_TOKEN` and `GH_TOKEN`, sourced from the host shell with `${GITHUB_TOKEN:-}` substitution. Either name on the host populates both names inside the container:

```yaml
environment:
  GITHUB_TOKEN: ${GITHUB_TOKEN:-}
  GH_TOKEN: ${GH_TOKEN:-${GITHUB_TOKEN:-}}
```

The token VALUE still comes from `.env` (or the host shell). The compose file never contains the literal value. Compose still honors `env_file: .env`, so existing `.env` files keep working.

### docker-entrypoint.sh

1. Accept either `GH_TOKEN` or `GITHUB_TOKEN` and re-export both, so any subprocess (gh CLI, bun workflow nodes, raw git) finds whichever name it looks for.
2. Install the git credential helper unconditionally when either token is present, reading from a stable internal env var `GH_AUTH_TOKEN_INTERNAL` so the helper is decoupled from which upstream name was used.
3. Pre-flight check at startup: run `gh auth status` and log loudly if it fails. The result is written to `/tmp/github-auth-preflight.status` so future healthcheck wiring can pick it up. Failure is non-fatal — a stale token must not block container startup — but the error is visible in `docker logs archon-app-1` immediately.

## Token model

| Field | Value |
|-------|-------|
| Token type | Classic personal access token (GitHub UI: Settings → Developer settings → Personal access tokens → Tokens (classic)) |
| Owner | `bluedevilcollectibles` org account |
| Required scopes | `repo`, `workflow`, `read:org` (current production token also carries `gist` — harmless) |
| Storage location (host) | Hetzner `/opt/archon/.env`, var name `GITHUB_TOKEN` |
| Storage location (container) | Read from `.env` via `env_file`, re-exported as `GH_TOKEN` and `GH_AUTH_TOKEN_INTERNAL` by entrypoint |
| Refresh cadence | Classic PATs expire on the date set at creation. Recommend 90-day rotation; current token has no expiration (legacy). |
| What expiry breaks | Every workflow that pushes a branch or opens a PR. Read-only operations (clone of public repos, ls-remote HEAD) keep working — that's why expiry is silent without the pre-flight. |

## Rotation procedure

1. Generate a new classic PAT on github.com under the `bluedevilcollectibles` account with scopes `repo`, `workflow`, `read:org`. Set expiration (recommend 90 days).
2. SSH to Hetzner: `ssh hetzner-prod`.
3. Edit `/opt/archon/.env`, replace the `GITHUB_TOKEN=...` line with the new value.
4. `cd /opt/archon && sudo docker compose up -d` (recreates the app container with the new env).
5. Verify: `sudo docker logs archon-app-1 2>&1 | grep "GitHub auth pre-flight"` — should print `OK`.
6. Smoke test: fire `bdc-sync-workflows` from the web UI and confirm the PR opens.
7. Revoke the old token on github.com.

## Pre-flight check semantics

The entrypoint runs `gh auth status` after configuring the credential helper. Possible states written to `/tmp/github-auth-preflight.status`:

| Status | Meaning | Action |
|--------|---------|--------|
| `ok` | Token authenticates to github.com with at least one logged-in account | Continue normally |
| `fail` | Token present but `gh auth status` rejected it (expired, revoked, wrong type) | Rotate the token, restart the container |
| `missing` | Neither `GITHUB_TOKEN` nor `GH_TOKEN` set in container env | Add `GITHUB_TOKEN=...` to `.env`, restart |

Pre-flight does NOT block startup. A failing token must surface in logs but must not turn the container into a crashloop — the harness should still be reachable for inspection.

## Why not a write-test pre-flight?

The WO suggested `git ls-remote origin HEAD`. Against a public repo (bdc-xo is public-from-org-readable), unauthenticated ls-remote succeeds and proves nothing about the token. `gh auth status` is the cheapest call that ACTUALLY exercises the token. A true write-test would require an authenticated push to a throwaway ref, which we avoid because:

- It would pollute the repo with churn on every container restart.
- It would require a known-writable test repo, adding setup overhead.
- The scope (`repo`) implied by a passing `gh auth status` with `workflow` and `repo` scopes is sufficient evidence — there is no class of token that passes `gh auth status` but fails `git push`.

## Related WOs

- bdc-xo#132 (persona schema): same root cause, recovered manually. This WO closes the prevention loop.
- bdc-xo#168 (Tier 1 host-artifacts volume): a complementary fallback — when push fails for any reason, workflow bundles still land on the host via the bind-mount path. Defense in depth.
- Cauldron-Fire skill: banned SSH-to-Hetzner-bun-CLI fire path because that path had no `GITHUB_TOKEN` either. With this WO, the canonical web/API fire path is the only path that needs to work — and it does.
