# Taskmaster (M-133 Slice 1) -- Architecture and Operations

<!--
Generated: 2026-08-12 by the bdc-audit-claude lane (Cauldron major-build), from a
read-only reading of the Taskmaster source on bdc-harness.
Derived-from commit (bdc-harness): e84ccf658ff8e11901f6fbad2c1dff76f2d91a9c
WO: WO-HARNESS-DOCS-BACKFILL-TASKMASTER-01 (docs-backfill proof run).
Behavior source of truth: the code itself (files cited below). The M-133 Slice 1
ratification WO (WO-HARNESS-TASKMASTER-SLICE1-01, bdc-xo) is cited only as DESIGN
INTENT, never as current behavior. Every file:line citation was re-derived by
reading the file at the commit above; line numbers drift, re-verify before trusting.
-->

> Provenance: this document was Generated on 2026-08-12 from bdc-harness commit
> `e84ccf658ff8e11901f6fbad2c1dff76f2d91a9c` by the `bdc-audit-claude` lane. If the
> cited line numbers no longer match, the doc is stale -- regenerate it.

## 1. What the Taskmaster is

The Taskmaster is an always-on, deterministic, model-free tick loop that lives in
`packages/server/src/taskmaster/` and runs inside the `archon-app-1` container. Its
job is to move stalled work forward by sending dispatch messages -- and nothing
else. It delivers undelivered ratified rulings, nudges idle threads, and escalates
unclaimed P0s (`packages/server/src/taskmaster/loop.ts:1`-`15`).

It is deliberately NOT an agent. There is no model call anywhere in the loop; every
decision is a pure function of observed state (`packages/server/src/taskmaster/rules.ts:1`-`16`).
Its ONLY authorized effect is a dispatch message of an allowlisted action type to
an allowlisted named seat, and that constraint is enforced in code, not merely
stated in design (`packages/server/src/taskmaster/guard.ts:1`-`13`).

The four modules:

| Module | File | Responsibility |
|--------|------|----------------|
| Loop / scheduler | `loop.ts` | Tick orchestration, GitHub reads, journal writes, dispatch sends, scheduler singleton |
| Rules | `rules.ts` | Pure classification + next-action computation (no I/O, no clock) |
| Ledger | `ledger.ts` | Own usage-headroom reading; OK / LOW / UNKNOWN, never zero-on-error |
| Deadman | `deadman.ts` | Observed tick-heartbeat health (`healthy` / `degraded` / `not_running`) |
| Guard | `guard.ts` | Outbound allowlist + spend/send/deploy content guard |

(`guard.ts` is not named in the WO's Section 7 file list but is a first-class part
of the subsystem -- the tick calls it before every effect. Documented here.)

## 2. The tick

`tick(state, deps)` (`packages/server/src/taskmaster/loop.ts:524`) runs once per
scheduler interval. Its ordered stages (comment at `loop.ts:9`-`11`):

1. **Pause state + epoch** captured from the singleton control row
   (`loop.ts:537`-`545`). Confirmations from a previous epoch are dropped.
2. **Headroom** read from the ledger; a failed read is `UNKNOWN`, never capacity
   (`loop.ts:547`-`562`). In Slice 1 headroom is recorded and surfaced only -- all
   Slice 1 verbs are dispatch messages with no model spend, so headroom never
   suppresses messaging (`loop.ts:547`-`549`).
3. **Restart reconciliation** runs once per process, before any new effect
   (`loop.ts:564`-`573`, `reconcilePendingActions` at `loop.ts:399`).
4. **Journal lookback** builds the dedupe set and the per-item 24h intervention
   counts, then grades previously sent actions against the external source of
   truth (`loop.ts:575`-`600`).
5. **Reads -> classify -> propose**: undelivered rulings and GitHub threads are
   read, each classified and turned into at most one typed proposal, then a daily
   digest proposal is appended (`loop.ts:602`-`649`).
6. Each proposal runs the pipeline: two-tick confirm (ordinary nudges only) ->
   guard -> pause/mode check -> budget check -> **journal row FIRST** -> epoch
   re-check -> `createMessage` -> journal outcome (`loop.ts:653`-`808`).

Row-first discipline is absolute: the journal row is written before the dispatch
effect is attempted (`loop.ts:753`-`770`), and the pause epoch is re-checked
immediately before the send so a resume mid-tick expires rather than replays the
proposal (`loop.ts:773`-`779`).

### Budgets (ratified Q1)

- Max **10** effects per tick: `MAX_EFFECTS_PER_TICK = 10` (`loop.ts:47`),
  enforced at `loop.ts:735`.
- **1** effect per item per tick: `touchedThisTick` set (`loop.ts:735`,
  `loop.ts:792`).
- Max **3** automated interventions per item per 24h:
  `MAX_INTERVENTIONS_PER_ITEM_24H = 3` (`rules.ts:64`), enforced at `rules.ts:103`.

Overflow is journaled as `deferred`, never dropped (`loop.ts:735`-`751`).

## 3. The rules engine (deterministic, model-free)

`rules.ts` exports pure functions only -- no I/O, no clock reads; the caller injects
`now` (`rules.ts:3`-`4`). This is what makes the Taskmaster deterministic.

**Classification** -- `classifyThread(thread, nowMs)` (`rules.ts:74`) returns one of
`ready | stale | blocked | healthy` (`rules.ts:19`). Blocked threads are watched,
never nudged; a thread with an undelivered ruling or an unclaimed P0 is `ready`; a
thread idle past its nudge clock is `stale` (`rules.ts:74`-`85`).

**Next action** -- `computeNextAction(thread, classification, context)`
(`rules.ts:97`) emits at most ONE typed proposal, in priority order ruling delivery
> P0 escalation > nudge (`rules.ts:97`-`151`). The four verbs (`TmActionType`,
`rules.ts:20`):

| Verb | Trigger | Recipient | Acts immediately? |
|------|---------|-----------|-------------------|
| `deliver_ruling` | undelivered ratified ruling for the seat | thread recipient | yes (`rules.ts:105`-`116`) |
| `escalate_p0` | unclaimed P0 issue | `operator` | yes (`rules.ts:119`-`131`) |
| `nudge` | thread idle past its clock | thread recipient | no -- needs two consecutive ticks (`rules.ts:133`-`148`) |
| `digest` | one summary per UTC day | `operator` | yes (`loop.ts:369`-`390`, `loop.ts:644`) |

**Nudge clocks** (ratified Q1, `NUDGE_CLOCK_MS` at `rules.ts:54`-`59`): P0 = 30 min,
P1 = 4 h, P2/P3 = 24 h. Customer-facing threads use the 30-minute P0 clock
regardless of priority (`CUSTOMER_CLOCK_MS`, `rules.ts:61`; `nudgeClockMs` at
`rules.ts:66`-`71`).

Ordinary nudges require the same proposal to be eligible on TWO consecutive ticks
before acting; the exception classes act on the confirming tick
(`loop.ts:678`-`690`).

## 4. GitHub reads (the Work source of truth)

`defaultListThreads` (`loop.ts:211`) reads open GitHub issues labeled with any of
the work labels across the configured repos. The work labels are
`['wo', 'project', 'arc']` (`WORK_LABELS`, `loop.ts:189`). The GitHub issues API
treats `labels=a,b` as AND, so each label is queried separately and results are
deduped by issue number to get OR semantics (`loop.ts:183`-`188`, `loop.ts:220`-`242`).

> DISCREPANCY (Rule 17): the WO Section 7 prose says "label wo/arc" (two labels),
> but the code queries THREE labels -- `wo`, `project`, `arc` (`loop.ts:189`). The
> code is ground truth. Even the in-file comment at `loop.ts:183` says "Both work
> labels" while the array has three entries. Flagged for a follow-up cleanup of the
> stale comment; not fixed here (docs-only lane).

Rate-limit awareness: `assertGithubRateLimit` (`loop.ts:194`) reads the
`x-ratelimit-remaining` response header and throws a backoff error when it drops
below the floor `GITHUB_RATE_LIMIT_FLOOR = 5` (`loop.ts:190`, `loop.ts:196`-`199`).
A failed or incomplete read throws so the tick cannot advance its success heartbeat
on a partial snapshot (`loop.ts:202`-`209`, `loop.ts:262`-`265`).

Configured repos default to `bluedevilcollectibles/bdc-xo` and are overridable via
`TASKMASTER_GH_REPOS` (`loop.ts:214`). The GitHub token is read from
`GITHUB_TOKEN` or `GH_TOKEN` (`loop.ts:218`).

Priority is inferred from labels via `priorityFromLabels` (`loop.ts:162`), which
accepts `p0`..`p3` with optional `prio:`/`priority:` prefixes and defaults to P2
(`loop.ts:162`-`173`).

## 5. Effect grading (was the message useful?)

The outbound dispatch row alone never proves usefulness. `gradeSentActions`
(`loop.ts:430`) grades each `sent` action against action-specific external SOR
evidence recorded AFTER the send, via `defaultGetGithubIssueEvidence`
(`loop.ts:296`) which reads the issue, its comments, and its events. A nudge is
`useful` if the source issue closes or records a post-send `[PROGRESS]`/`[BLOCKED]`
comment by a non-bot; a P0 escalation is `useful` on close, assignment, active
status, or progress; a ruling is `useful` when the original ruling row is addressed
by its resolved recipient (`proofPredicate` at `loop.ts:511`-`522`, grading logic
`loop.ts:457`-`501`). Grades are `useful | noise | harmful`
(`migrations/041_taskmaster_slice1.sql:24`).

## 6. The ledger (usage headroom)

`currentHeadroom(deps)` (`ledger.ts:154`) computes the Taskmaster's OWN reading and
represents failure as `UNKNOWN`. Precedence: fresh local artifact, then the CLI
anchor probe; between due samples the cached anchor observation is served
(`ledger.ts:141`-`153`, `ledger.ts:162`-`207`).

**Hard contract:** `currentHeadroom()` never returns numeric 0 as available
capacity on an error path. When both readers fail the reading is
`state: 'UNKNOWN', tokensRemaining: null`, persisted with `is_unknown=1`
(file header `ledger.ts:11`-`15`; implemented at `ledger.ts:209`-`227`). Below
`DEFAULT_LOW_WATERMARK = 50000` (`ledger.ts:47`) the state is `LOW`, otherwise `OK`
(`ledger.ts:244`).

The CLI anchor is sampled at startup, every 30 minutes
(`ANCHOR_SAMPLE_INTERVAL_MS`, `ledger.ts:55`), and after a typed-limit transition
(`ledger.ts:80`-`85`, `ledger.ts:184`-`188`). The anchor probe command comes from
`TASKMASTER_CLI_ANCHOR_CMD` and the local artifact path from
`TASKMASTER_USAGE_ARTIFACT` (`ledger.ts:110`, `ledger.ts:127`). Fresh observations
are persisted to `tm_usage_sample` via `recordUsageSample`
(`packages/core/src/db/taskmaster.ts:359`).

## 7. Deadman (tick health) and escalation

`deadman.ts` is the OBSERVED side only -- it records whether the tick heartbeat is
fresh and exposes `tickHealth` (`deadman.ts:50`). It degrades after 3 missed
intervals: `DEADMAN_MISSED_INTERVALS = 3` (`deadman.ts:22`), test at
`deadman.ts:43`-`48`. Two missed intervals are still `healthy`; three are
`degraded`.

> DISCREPANCY (Rule 17): the WO Section 7 asks to document the deadman "delivery
> path" from `deadman.ts`, but `deadman.ts` has NO delivery path -- its own header
> states the external checker "lives in the Overseer package" because a health
> value the Taskmaster observes about itself does not satisfy the Q4 binding
> condition (`deadman.ts:5`-`11`). The actual escalation delivery lives in
> `packages/overseer/src/taskmaster-deadman-check.ts`.

The external checker `pollTaskmasterDeadman`
(`packages/overseer/src/taskmaster-deadman-check.ts:64`) polls
`GET /api/taskmaster/status` over HTTP and, when `tick_health` flips to `degraded`,
emits exactly ONE escalation per degradation episode through the dispatch channel
(`createMessage`, sender `overseer`, recipient `operator`) -- a second poll while
still degraded emits nothing, and recovery re-arms it
(`taskmaster-deadman-check.ts:92`-`131`). It is started alongside the Taskmaster in
`registerApiRoutes` (`packages/server/src/routes/api.ts:3069`) and disabled with
`TASKMASTER_DEADMAN_INTERVAL_MS=0` (`taskmaster-deadman-check.ts:157`-`161`,
`taskmaster-deadman-check.ts:186`-`190`).

## 8. The outbound guard

`validateProposal(proposal)` (`guard.ts:65`) is called in code before the dispatch
DAL, and enforces:

- **Action-type allowlist**: `TM_ALLOWED_ACTION_TYPES = ['deliver_ruling', 'nudge',
  'escalate_p0', 'digest']` (`guard.ts:17`-`22`). Anything else is a forbidden
  effect.
- **Recipient allowlist**: `TM_ALLOWED_RECIPIENTS = ['xo', 'major-build',
  'captain-ci', 'operator']` (`guard.ts:30`). No broadcast, no `board`, no
  customers.
- **Non-empty idempotency key** and non-empty body (`guard.ts:82`-`92`).
- **Spend/send/deploy verb rejection**: `SPEND_SEND_DEPLOY_RE` (`guard.ts:38`-`39`)
  blocks bodies that instruct charge/refund/deploy/merge-to-main/send-the-email and
  similar -- the Taskmaster has zero spend/send/deploy authority (M-15 tier wall,
  `guard.ts:94`-`100`).

A forbidden-effect rejection (bad action type or recipient) additionally
HARD-PAUSES effects via the auto-circuit -- it tightens into pause, never KILL
(`loop.ts:694`-`714`; `forbiddenEffect` flag at `guard.ts:44`-`49`).

## 9. Pause / resume mode matrix

The singleton control row `tm_control` holds `pause_state` in
`RUNNING | PAUSED | HARD_PAUSE` plus an `epoch`
(`migrations/041_taskmaster_slice1.sql:35`-`45`). While paused, sends stop but
watching never does: P0 escalation and the digest stay alive
(`pauseExempt`, `loop.ts:717`-`731`). KILL is not a pause state -- it is
`TASKMASTER_INTERVAL_MS=0`, operator-set only
(`migrations/041_taskmaster_slice1.sql:31`-`34`).

Resume is John-authorized: it increments the epoch and EXPIRES stale parked/pending
proposals rather than replaying them (`api.ts:3125`-`3151`, `expireParkedActions`
at `packages/core/src/db/taskmaster.ts:239`).

## 10. Database schema (tm_* tables)

All tables are additive; no existing table is altered
(`migrations/041_taskmaster_slice1.sql:1`-`4`).

- **`tm_journal`** (`migrations/041_taskmaster_slice1.sql:8`-`25`): one row per
  proposed/sent/parked/deferred/rejected effect, written BEFORE the effect.
  `action_type` is CHECK-constrained to the four verbs
  (`migrations/041_taskmaster_slice1.sql:12`-`14`); `outcome` to
  `pending | sent | parked | deferred | rejected | expired | failed`
  (`migrations/041_taskmaster_slice1.sql:20`-`22`); `grade` to
  `useful | noise | harmful` (`migrations/041_taskmaster_slice1.sql:24`). Carries
  `idempotency_key`, `before_hash`, `proof_predicate`, `proof_deadline_at`.
- **`tm_control`** (`migrations/041_taskmaster_slice1.sql:35`-`49`): singleton
  (`CHECK (id = 1)`), seeded `RUNNING` epoch 0.
- **`tm_health`** (`migrations/041_taskmaster_slice1.sql:54`-`60`): provider health
  samples with `sampled_at` / `expires_at` expiry; the process-scoped
  `darkEngines` map is deliberately NOT durable truth.
- **`tm_usage_sample`** (`migrations/041_taskmaster_slice1.sql:65`-`74`): one row =
  one observation (not a running ledger). `is_unknown INTEGER CHECK (is_unknown IN
  (0,1))` -- a failed meter is recorded as `is_unknown=1`, never as
  zero-available-capacity.

## 11. Data / content flow

```
solicitation of work
  GitHub issue reads (defaultListThreads, loop.ts:211)
  + undelivered rulings (defaultListUndeliveredRulings, loop.ts:149)
        |
        v
rules evaluation (classifyThread -> computeNextAction, rules.ts:74 / rules.ts:97)
        |
        v
guard (validateProposal, guard.ts:65)  --reject--> journal row only (+ maybe HARD_PAUSE)
        |
        v
budget + two-tick confirm (loop.ts:678 / loop.ts:735)
        |
        v
journal ROW FIRST (recordAction, loop.ts:760) --> epoch re-check (loop.ts:774)
        |
        v
action: dispatch message with idempotency key (createMessage, loop.ts:782)
        |
        v
journal outcome 'sent' + proof deadline (loop.ts:790)
        |
        v
later ticks: grade against external SOR (gradeSentActions, loop.ts:430)
        |
        v
health/status surface: GET /api/taskmaster/status (api.ts:3080)
```

## 12. How to operate it

### Status

`GET /api/taskmaster/status` (route `packages/server/src/routes/api.ts:2163`-`2176`,
handler `api.ts:3080`-`3103`) returns `pause_state`, `pause_scope`, `pause_reason`,
`pause_actor`, `epoch`, `tick_health`, `interval_ms`, `last_tick_at`,
`headroom_state`, and `effects_last_24h`
(`packages/server/src/routes/schemas/taskmaster.schemas.ts:12`-`25`).

All `/api/*` routes are gated by the global operator-token middleware
(`api.ts:2476`-`2503`): when `ARCHON_OPERATOR_TOKEN` is set (always in production),
requests must present the token as a `Bearer` header or `x-archon-operator-token`
(`api.ts:2489`-`2502`, `api.ts:2297`-`2303`). `/api/taskmaster/status` is NOT a
public path (public paths are only `/api/health`, `/api/openapi.json`,
`/api/public/*`, `api.ts:2289`-`2295`).

Example (operator token required):

```
curl -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
     http://localhost:3090/api/taskmaster/status
```

### Pause / resume

- `POST /api/taskmaster/pause` -- operator/John pauses effects; monitoring, P0
  escalation, and digest keep running (`api.ts:2178`-`2197`, handler
  `api.ts:3105`-`3123`).
- `POST /api/taskmaster/resume` -- John-authorized; epoch increments and stale
  proposals expire (`api.ts:2199`-`2218`, handler `api.ts:3127`-`3151`).

### Enable / disable and interval

`TASKMASTER_INTERVAL_MS` controls the loop: an integer > 0 enables the loop at that
interval, `0` is KILLED (no tick), anything else falls back to 60000 (60s)
(`resolveTaskmasterIntervalMs`, `loop.ts:850`-`854`). The scheduler is a module-scope
singleton started by `startTaskmaster` (`loop.ts:860`), which installs a
`setInterval` at that cadence with an `inFlight` guard (`loop.ts:874`-`892`) and is
wired up in `registerApiRoutes` outside test mode (`api.ts:3059`-`3060`).

### "Is it alive?"

- `tick_health` from the status endpoint: `healthy` while heartbeats are fresh,
  `degraded` after 3 missed intervals, `not_running` when no interval is configured
  (`deadman.ts:50`-`53`, surfaced via `getTickHealth`, `loop.ts:841`-`844`).
- `last_tick_at` on the status endpoint shows the last successful heartbeat time.
- Read `tm_journal` directly for recent activity, e.g. the last day of sends:
  ```sql
  SELECT created_at, action_type, thread_ref, outcome, grade
  FROM tm_journal
  WHERE created_at >= NOW() - INTERVAL '24 hours'
  ORDER BY created_at DESC;
  ```
  (`effects_last_24h` on the status endpoint is exactly the count of `outcome =
  'sent'` rows in that window, `api.ts:3084`-`3097`.)

### Relevant environment variables

| Var | Effect | Cite |
|-----|--------|------|
| `TASKMASTER_INTERVAL_MS` | loop cadence; `0` = KILLED, default 60000 | `loop.ts:850`, `loop.ts:862` |
| `TASKMASTER_GH_REPOS` | comma list of repos to read; default `bluedevilcollectibles/bdc-xo` | `loop.ts:214` |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub auth for issue reads | `loop.ts:218`, `loop.ts:289` |
| `TASKMASTER_USAGE_ARTIFACT` | local usage-anchor JSON path | `ledger.ts:110` |
| `TASKMASTER_CLI_ANCHOR_CMD` | CLI probe emitting tokens-remaining | `ledger.ts:127` |
| `TASKMASTER_DEADMAN_INTERVAL_MS` | external deadman poll cadence; `0` = off | `taskmaster-deadman-check.ts:186` |
| `TASKMASTER_STATUS_URL` | status URL the deadman checker polls | `taskmaster-deadman-check.ts:55` |
| `ARCHON_OPERATOR_TOKEN` | gates `/api/*`, incl. all taskmaster routes | `api.ts:2489` |

## 13. Discrepancies found vs the WO spec (for follow-up)

These are documentation/comment drifts only; no code was changed by this audit.

1. **Work labels count.** WO Section 7 prose says "label wo/arc"; the code queries
   three labels `['wo', 'project', 'arc']` (`loop.ts:189`). The in-file comment at
   `loop.ts:183` also says "Both work labels" but lists three. Recommend a
   comment/prose fix under a follow-up `bdc-feature-development` WO.
2. **Deadman delivery path location.** WO Section 7 attributes the deadman
   "delivery path" to `deadman.ts`; in reality `deadman.ts` is observe-only and the
   escalation delivery lives in
   `packages/overseer/src/taskmaster-deadman-check.ts:110` (`deadman.ts:5`-`11`).
3. **`operator` vs `john` recipient.** The guard allows `operator` (not `john`) as
   the John-facing drain; the `john` dispatch principal is seeded inactive
   (`guard.ts:26`-`31`). Escalations and digests target `operator`
   (`rules.ts:124`, `loop.ts:384`).

## 14. Verified-fact summary

- The loop is genuinely model-free: no SDK/model call exists in `loop.ts`,
  `rules.ts`, `guard.ts`, `ledger.ts`, or `deadman.ts` (verified by reading all
  five files at the pinned commit).
- Every effect is a dispatch `createMessage` with an idempotency key; there is no
  second messaging path (`loop.ts:5`-`7`, `loop.ts:782`).
- Row-first journaling and epoch re-check make the loop safe to resume mid-tick
  (`loop.ts:753`-`779`).
- Headroom never reports zero-as-capacity on error (`ledger.ts:209`-`227`).
- The status/pause/resume surface exists and is operator-token gated
  (`api.ts:2163`-`2218`, `api.ts:2476`-`2503`).
