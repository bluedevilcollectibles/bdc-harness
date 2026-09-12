# Who may register a Taskmaster expectation

Status: shipped with bdc-xo#2007. Supersedes nothing; this authority did not
previously exist because the capability did not previously exist.

## What an expectation is

A row in `tm_expectations` saying: *I expect PROOF X to exist by DEADLINE T; if
it is absent, do ON_ABSENCE, bounded by MAX_RETRIES.* A background tick inside
`archon-app-1` checks the proof and fires the absence action. It is the only
mechanism in the harness that notices work going quiet without a human watching.

## The gap this closes

Before #2007, the ONLY caller of `registerExpectation` was the Taskmaster loop,
registering expectations for its own dispatches. Every live row was
`recipient: operator`, `kind: dispatch_reply_exists`. Work assigned any other
way -- a Cursor seat, a Codex desktop thread, a Claude subagent, John handing it
to someone in chat -- was invisible to the supervisor. That is most of how work
is actually assigned here.

On 2026-09-11, supervising ONE such handoff (FUELGLASS to a Fable seat) required
an `scp` to the production host, the discovery that the database is readonly to
the ssh user, the discovery that `sqlite3` is not in the container, and finally a
`sudo sqlite3` INSERT as root. Three failed methods and a raw SQL write to
register a supervision record. A hand step in the harness is a gap.

## The ruling

**1. Registration is authorized by the operator token, and ATTRIBUTED by
`registered_by`.**

`POST /api/taskmaster/expectations` sits behind the same global operator-token
middleware as every other `/api/*` route. There is no separate per-seat
credential for this surface today, so authorization and attribution are
deliberately separated: the token says the caller is allowed in, and
`registered_by` says who it claims to be. Attribution is self-declared and NOT a
security boundary -- a caller holding the token could name any registrant. It
is an audit and budgeting field, and it is honest enough for both, because
everything that holds the token is something we run.

The end state, when per-seat API credentials exist, is that `registered_by` is
derived from the presented credential rather than from the body. The field is
introduced now so that change is a tightening, not a schema migration.

**2. Any session that can reach the API may register. The right to register is
not the scarce thing; the right to CONSUME an absence action is.**

An expectation is not itself one of Taskmaster's budgeted effects. Its
`on_absence` action IS one. So the bound is placed there rather than on who may
ask: `TASKMASTER_EXPECTATION_DAILY_CAP` (default 50) limits registrations across
the WHOLE front door per rolling 24 hours.

**Deliberately not per registrant.** A per-registrant cap bounds nothing when the
registrant is a self-declared string: a caller at its limit sends a different
name and carries on. Counting every externally-registered row (they carry the
`ext:` key prefix) makes the cap a property of the operator token, which is the
thing actually authenticated, and no amount of relabelling evades it. Rows the
loop registered for itself are excluded and stay bounded by the loop's own
per-tick budgets -- neither side should be able to exhaust the other's headroom.

**A retry under an existing key is exempt.** It creates nothing, so charging it
would turn the documented idempotent `200` into a `429` the moment a caller got
busy, punishing exactly the safe retry behaviour the caller-supplied key exists
to make possible.

Fifty supervised handoffs in a day across all callers is a loop, not a busy day.

**3. A seat MAY register an expectation on itself, EXCEPT to escalate.**

`registered_by == recipient` is recorded as `self_supervised = 1` and permitted
for `on_absence` of `give_up` or `redispatch`. Both are inert with respect to
the seat's own accountability: `give_up` closes the row, and `redispatch`
re-sends into the mailbox the seat is already reading. A seat binding itself to
a deadline it will be reminded of is useful and costs nobody anything.

`on_absence: escalate` self-registered is REFUSED with a 400. Escalation is the
one action whose whole purpose is to reach PAST the seat to a human. A seat that
can register its own escalation can also decline to act on it, and nothing else
in the system would know -- which is precisely the silent failure #1850 was
written to end, reconstituted one layer up. To supervise a seat's work with a
real escalation, register from the ASSIGNING session, which is the party with an
interest in noticing.

This refusal is enforced in the route, not merely written here. A rule that lives
only in a document is a rule nobody checks.

**But be honest about what it is.** Both sides of the comparison come from the
request body, so the check is a CORRECTNESS guard, not a security control: a
caller holding the operator token can defeat it by naming a registrant other than
itself. It is worth having because the realistic failure is a seat wiring up its
own supervision by mistake and believing the result -- not a seat scheming to
evade oversight it could evade more easily in a dozen other ways. It must simply
never be mistaken for a boundary that holds against a caller trying to get around
it. The only thing that could hold there is a registrant derived from an
authenticated per-seat credential, which is the end state named in ruling 1.

The same caveat is why the CAP is not per registrant: a control built on a
self-declared field must either be evadeable-but-useful (this one) or be rebuilt
on something authenticated (the cap). Both findings were raised by the Overseer
review of PR bdc-harness#810 and are recorded here rather than quietly fixed.

**4. No board motion is required, and here is why.**

M-133 constrains Taskmaster's VERBS -- what it may do to the world. The front
door adds no verb. The same six evidence checks run, the same three absence
actions fire, under the same budgets; the only change is WHO may point them at a
piece of work. The alternative reading -- that letting a session name work to be
supervised is itself a new power -- fails on the fact that the session could
already register by writing SQL as root, which is strictly less governed than a
capped, attributed, audited API call. This change reduces the authority needed to
do the thing, it does not grant new authority to the machine.

What WOULD need a motion: widening the absence actions, raising the effect
budgets, letting an expectation trigger a Cauldron fire, or allowing
self-supervised escalation.

**5. Escalations go to `xo`, never to `operator`.**

Not an authority question, but it belongs with this record because it is the
other half of what #2007 found. Measured on the live database 2026-09-11:

| recipient  | messages | unaddressed | addressed <5s |
|------------|----------|-------------|---------------|
| `operator` | 3,535    | 9           | 258           |
| `xo`       | 1,089    | 153         | 0             |

The `operator` principal is `delivery_mode: drain_on_start` and something
acknowledges and addresses its mail within seconds. Both expectations that have
ever escalated -- `46f94406` (2026-09-10) and `faa69079` (2026-09-11) -- had
their blocker auto-addressed inside two seconds. No human saw either.

`operator` is also structurally ineligible for every out-of-band leg that
exists: `claimDispatchEscalation` gates the Telegram and SMS handoffs on
`COALESCE(resolved_recipient, recipient) = 'xo'`. An escalation addressed to
`operator` is not merely unread; it can never be escalated further.

Escalations therefore address `xo`, which a person drains and which the XO
session-start reflex reads.

## How to register

Do not write SQL. One line:

```
scripts/taskmaster/expect.ps1 -Ref bdc-xo#2006 -Recipient fable-cursor `
  -Evidence pr_opened:thinmansoftware/fuelglass -DueIn 24h -OnAbsence escalate
```

Full invocation reference, including all six evidence forms and the raw API
shape: `~/.claude/skills/Taskmaster-Expect/SKILL.md`.
