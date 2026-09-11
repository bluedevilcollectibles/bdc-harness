# Smart Cauldron Canary Suite

For the data-driven audit that folds this lane check into review, dispatch, lease, Taskmaster, ledger, inbox, knowledge, and deploy checks, see [Cross-Mechanism Canary Audit](./mechanism-canary-audit.md).

## Plan 1 scope

Plan 1 implements read-only Levels 0 and 1. It validates the reviewed eight-lane
manifest, reads one authenticated runtime snapshot, plans direct and conductor
routes locally, reduces a mechanical verdict, and writes deterministic JSON and
Markdown evidence.

It does not fire a workflow or provider, create a conversation, mutate a database,
touch Git or GitHub, open a pull request, deploy, restart, schedule work, or execute
Levels 2 through 5.

## Local verification

```powershell
bun --filter @archon/canary-suite test
if (-not $env:CANARY_CODEBASE_ID) { throw 'Set CANARY_CODEBASE_ID from the authenticated GET /api/codebases response.' }
bun packages/canary-suite/src/cli.ts check --manifest .archon/canaries/smart-cauldron.yaml --api-base http://127.0.0.1:3090 --codebase-id $env:CANARY_CODEBASE_ID --output-root ./harness-artifacts/canaries
bun packages/canary-suite/src/cli.ts plan --manifest .archon/canaries/smart-cauldron.yaml --api-base http://127.0.0.1:3090 --codebase-id $env:CANARY_CODEBASE_ID --output-root ./harness-artifacts/canaries
```

`ARCHON_OPERATOR_TOKEN` must be present in the environment, or its value must be
stored in a local file passed through `--token-file`. Never put the token directly
on the command line.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | passed |
| 2 | failed |
| 3 | blocked or missing prerequisite |
| 4 | aborted or unexpected execution error |

## Evidence

Each invocation writes one immutable directory beneath the requested output root:

```text
canary-YYYYMMDDHHMMSS-identity/
  plan.json
  summary.json
  summary.md
```

Re-running the same suite identity is idempotent only when every artifact byte is
identical. Any difference fails with `canary_artifact_conflict`.

## Activation boundary

Production invocation and scheduling remain disabled. Level 2 draft-PR canaries,
Levels 3 through 5, fault injection, retention cleanup, and Duty Officer ingestion
require their later implementation plans and named approvals. This document does
not authorize any of those actions.
