# Lifecycle Canary Scratch Path

This directory is the ONLY path the lifecycle canary
(`WO-HARNESS-LIFECYCLE-CANARY-01`) is permitted to touch during a live run. It
is the shared scratch convention referenced by:

- `packages/canary-suite/src/lifecycle-canary.ts`
  (`LIFECYCLE_SCRATCH_DIR = ".archon/canaries/lifecycle-scratch"`)
- the live-run tooling that opens the throwaway PR
- the operator running `archon-canary lifecycle`

## Scratch file convention

Each live run creates a single throwaway marker file under this directory whose
content is a run-id-scoped constant, for example:

```
.archon/canaries/lifecycle-scratch/canary-marker-<run-id>.ts
```

The correct (post-remediation) content echoes the run id:

```ts
export const CANARY_RUN_ID_ECHO = "<run-id>";
```

## Planted defect convention

The canary branch first commits the marker with an intentional, unambiguous,
greppable wrong-constant instead of the run id:

```ts
export const CANARY_RUN_ID_ECHO = "WRONG_VALUE";
```

The literal `WRONG_VALUE`
(`LIFECYCLE_PLANTED_DEFECT_LITERAL` in `lifecycle-canary.ts`) is what:

- Leg 3 asserts the Overseer review names, and
- Leg 4 asserts remediation removes (`countDiffMatches(...) === 0`).

The defect is deliberately trivial: the point is proving the WHEEL connects
(propose -> build -> review -> remediate -> merge -> reconcile -> reply ->
report -> revert), NOT testing the depth of Overseer's review judgement.

## Invariants (enforced by the probe, see Section 7 of the WO)

1. The canary never touches production -- only `dev` and the canary's own
   throwaway branch/issue/PR.
2. The merged PR diff touches ONLY files under this directory. Any file outside
   it fails the run closed with `canary_diff_scope_violation`
   (`checkInvariantDiffScope`).
3. The canary reverts itself (Leg 10) on an independent timeout, regardless of
   any upstream leg failing, so `dev` is left clean.

## Important

Do NOT commit an actual planted-defect marker file (the `WRONG_VALUE` content)
to `dev`. That content exists only transiently on the canary's own throwaway
branch during a live run. Only this README is tracked here on `dev`.
