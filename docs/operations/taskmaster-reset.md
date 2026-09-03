# Taskmaster reset

From the `bdc-harness` checkout on the Archon host, preview the reset safely:

```bash
bash scripts/taskmaster/reset.sh --reason "why the reset is needed"
```

After the rebuilt image is verified live and the required deploy motion is recorded, run:

```bash
ARCHON_OPERATOR_TOKEN="$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)" bash scripts/taskmaster/reset.sh --confirm --reason "why the reset is needed"
```

The command expires parked and pending proposals, changes a paused Taskmaster to `RUNNING`, increments the epoch only for that transition, and writes one audit journal row per invocation. Repeating it while already running is safe: it does not increment the epoch again, but it does write another audit row.

RETIREMENT: The daily canary retires when the Taskmaster has run 30 consecutive days with at least one `outcome='sent'` row per day and zero self-pause events in that window. Retirement is a board decision, not an automatic expiry -- the code MUST NOT self-disable.
