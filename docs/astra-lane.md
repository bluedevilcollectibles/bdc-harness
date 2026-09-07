# Astra build / Fable review lane

WO: https://github.com/thinmansoftware/bdc-xo/issues/1922

`bdc-feature-development-astra` is a separate model-binding variant of the existing
Codex feature-development DAG. It preserves its gates, dependencies, prompts and
loop limits, except accurate model attribution. Existing lane files are unchanged.

| Seats | Provider | Model |
| --- | --- | --- |
| Planning, build, repair and push-target decision | codex-native-strict | gpt-6-astra |
| Plan review, validator, diff reviews and findings consolidation | claude | claude-fable-5 |

The original Sonnet/Opus persona files are unchanged. Four role-identical Fable
variants prevent those existing persona pins from overriding the new review model.
Separate contexts and the existing independent review/merge gates remain intact.

Strict Codex reuses PR655 head20847cd4e6a59b6c2b61060c348ff58d3e9fdab3's
no-failback registration, with related focused tests only. No Cursor, Dispatch,
worker, migration or reciprocal-lane changes are extracted. Reconcile the same
provider identity if PR655 later lands. Ordinary Codex fallback/default behavior
remains unchanged. Strict personas must be model-free; explicit node pins survive.
Availability uses existing Codex health mapping. No ladder/default-routing change.

## Source verification

From the repository root:

```text
bun install --frozen-lockfile
bun run cli validate workflows bdc-feature-development-astra
bun test packages/workflows/src/astra-lane.test.ts packages/workflows/src/lane-registration.test.ts packages/workflows/src/lane-cross-model.test.ts
bun test packages/workflows/src/dag-executor.test.ts -t "Astra lane binds"
bun run validate
```

Dispatch tests use synthetic workflows and mocked providers without push/GitHub or
customer write nodes. They prove actual prompt/loop options, not live model service.

## Invocation after separate environment authorization

On an authorized nonproduction harness with this reviewed source and normal frozen
WO authority, explicit selection uses the existing CLI:

```text
bun run cli workflow run bdc-feature-development-astra "<authorized WO-ID>"
```

This starts real work; the ordinary DAG can push and write GitHub. Never use it as
a generic canary. Production registration/rebuild/restart and activation need
current environment/commit-scoped authority. No account-default changes, API keys
or M-157 resource reuse.

## Evidence limits

See astra-sdk-preflight-evidence.md for local SDK0.153.3 Astra request/catalog and
Fable probe. Requested and returned identity are separate. These do not establish
a Linux container upgrade, full Cauldron run or production-active receipt.
Unavailable models must remain honest failures/waits, never silent substitutions.
