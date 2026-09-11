# Cross-Mechanism Canary Audit

`archon-canary mechanisms` exercises operating-model mechanisms and treats missing evidence as failure. It extends the Smart Cauldron suite: Cauldron routing and the existing Taskmaster checks are adapters, while the registry and absence evaluator generalize their positive-evidence pattern.

## Run it

The safe default runs only level-0, read-only probes:

```bash
bun packages/canary-suite/src/cli.ts mechanisms --output-root ./harness-artifacts/canaries --json
```

The dispatch, `tm_health`, and operator-inbox round trips mutate their target systems and require an explicit opt-in:

```bash
bun packages/canary-suite/src/cli.ts mechanisms --output-root ./harness-artifacts/canaries --level 1 --json
```

Exit codes are 0 for passed, 2 for failed, and 3 for blocked or invalid invocation. Reports are written under `mechanisms-*` directories as `summary.json` and `summary.md`; `mechanisms-heartbeat.json` lets an external checker detect a stopped runner without reading logs.

## Registry

The nine entries are Cauldron lanes, review gate, dispatch transport, XO lease, Taskmaster, ledger writes, operator inbox, knowledge layer, and deploy pipeline. Dispatch transport, ledger writes, and operator inbox are level 1. Add a mechanism by implementing its probe and appending one `MechanismDefinition` to `src/mechanisms/registry.ts`; runner control flow does not change.

The scheduled GitHub Actions workflow runs level 0 every six hours. Its red/absent run history is the schedule-level liveness signal. Manual dispatch exposes a `run_level_1` boolean for deliberate mutation.

Mirroring this invocation guide into the separate `xo-wiki` repository's `tools/` namespace remains an operator-owned cross-repository step.
