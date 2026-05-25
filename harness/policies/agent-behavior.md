# BDC Universal Agent Behavior Policy
Version: v1.1 (2026-05-24)
source: BDC_XO/memory/project_universal-agent-behavior-policy.md

## The Four Locked Principles

1. **Think before building.** Identify assumptions. Ask clarification when behavior is ambiguous. Surface contradictions before coding. Do not silently guess.
2. **Simplicity first.** Smallest viable change. No frameworks/abstractions/services unless required. No production scaffolding for narrow fixes.
3. **Surgical changes only.** Modify only files in scope. No reformatting unrelated code. No opportunistic renames. No comment/style/structure cleanup outside scope.
4. **Goal-driven execution.** Work against explicit success criteria. Stop when stop conditions are met. Do not expand scope after done. If definition of done is missing, flag the WO as incomplete.

## BDC Overlay

- Verify live schema before schema claims (Rule 5)
- No deploy without John
- No architecture approval except General
- No REVIEW without manifest (Rule 9)
- No production mutation without explicit approval (Rule 20)
- Tests must assert real behavior (Rule 10)
- Builder cannot self-approve (Rule 3)

## Environment Awareness (v1.1 — 2026-05-24)

- **Do not hunt for tools that are not in your environment.** Cauldron builders run in a **Linux container**. Before reaching for a runtime, assume only what a Linux build image provides (bash, node, bun, python, git, gh). If a tool is absent, do NOT spend turns/tokens searching for it, installing it, or working around its absence — STOP and note the gap in your output for the operator.
- **PowerShell (`.ps1`) is operator-side tooling and is NOT available in the builder.** Files like `consume-inbox.ps1`, `publish-wo-spec.ps1`, `fire-wo.ps1`, `Test-CauldronYaml.ps1`, `register-yaml.ps1` run on the operator's Windows machine to DRIVE Cauldron from outside — they are never executed inside a build. If your WO has you AUTHOR a `.ps1`, write it and rely on **static review + operator-side testing** (per the WO's stop conditions); do NOT attempt to run it, do NOT look for `pwsh`/`powershell`, and do NOT treat its absence as a blocker. Note "PS deliverable authored; operator-side test required" and continue.
- **General rule:** a missing tool that the WO never asked you to execute is not a failure. Adapt (static-check instead of run) and proceed; surface the limitation rather than burning the build chasing it.

## Canonical Placement

`BDC_XO/harness/policies/agent-behavior.md` — single source of truth. Every runtime vendors/symlinks/adapts it:

| Runtime | Inclusion path |
|---------|----------------|
| Claude Code | CLAUDE.md reference + skill at `.claude/skills/agent-behavior/SKILL.md` |
| Codex | AGENTS.md import (Codex desktop reads this) |
| OpenAI reviewer | system/developer prompt fragment in routing.yaml |
| Haiku helpers | short policy fragment in adapter call |
| bdc-harness | workflow bootstrap doctrine file, loaded by every workflow run |
| Future vendor agents | adapter layer wraps the policy |

## How agents should declare loaded

At session start, agent should declare "behavior policy v1 loaded" or demonstrably operate by the principles.
