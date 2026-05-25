/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Bundled canonical BDC Universal Agent Behavior Policy.
 *
 * Source of truth: bluedevilcollectibles/bdc-xo:harness/policies/agent-behavior.md
 *
 * Regenerate with: bun run scripts/generate-bundled-policy.ts
 * Verify up-to-date:  bun run scripts/generate-bundled-policy.ts --check
 *
 * Why: Cauldron workflows declare `policyFile: harness/policies/agent-behavior.md`
 * but only `bdc-xo` ships that file at that path. The resolver in
 * `policy-resolver.ts` falls back to this bundled copy for every other repo.
 *
 * Approach B per WO-HARNESS-POLICYFILE-NOT-ENFORCED-01.
 */

/** Canonical workflow-declared policy path. */
export const BUNDLED_AGENT_BEHAVIOR_POLICY_PATH = "harness/policies/agent-behavior.md" as const;

/** SHA256 of the canonical policy text (LF-normalized, UTF-8). */
export const BUNDLED_AGENT_BEHAVIOR_POLICY_SHA256 = "58800abf99efecba01930fc872bffb2fb7c4ddcf1481b646447ac4017f604102" as const;

/** Verbatim canonical policy text. Never hand-edited. */
export const BUNDLED_AGENT_BEHAVIOR_POLICY = "# BDC Universal Agent Behavior Policy\nVersion: v1.1 (2026-05-24)\nsource: BDC_XO/memory/project_universal-agent-behavior-policy.md\n\n## The Four Locked Principles\n\n1. **Think before building.** Identify assumptions. Ask clarification when behavior is ambiguous. Surface contradictions before coding. Do not silently guess.\n2. **Simplicity first.** Smallest viable change. No frameworks/abstractions/services unless required. No production scaffolding for narrow fixes.\n3. **Surgical changes only.** Modify only files in scope. No reformatting unrelated code. No opportunistic renames. No comment/style/structure cleanup outside scope.\n4. **Goal-driven execution.** Work against explicit success criteria. Stop when stop conditions are met. Do not expand scope after done. If definition of done is missing, flag the WO as incomplete.\n\n## BDC Overlay\n\n- Verify live schema before schema claims (Rule 5)\n- No deploy without John\n- No architecture approval except General\n- No REVIEW without manifest (Rule 9)\n- No production mutation without explicit approval (Rule 20)\n- Tests must assert real behavior (Rule 10)\n- Builder cannot self-approve (Rule 3)\n\n## Environment Awareness (v1.1 — 2026-05-24)\n\n- **Do not hunt for tools that are not in your environment.** Cauldron builders run in a **Linux container**. Before reaching for a runtime, assume only what a Linux build image provides (bash, node, bun, python, git, gh). If a tool is absent, do NOT spend turns/tokens searching for it, installing it, or working around its absence — STOP and note the gap in your output for the operator.\n- **PowerShell (`.ps1`) is operator-side tooling and is NOT available in the builder.** Files like `consume-inbox.ps1`, `publish-wo-spec.ps1`, `fire-wo.ps1`, `Test-CauldronYaml.ps1`, `register-yaml.ps1` run on the operator's Windows machine to DRIVE Cauldron from outside — they are never executed inside a build. If your WO has you AUTHOR a `.ps1`, write it and rely on **static review + operator-side testing** (per the WO's stop conditions); do NOT attempt to run it, do NOT look for `pwsh`/`powershell`, and do NOT treat its absence as a blocker. Note \"PS deliverable authored; operator-side test required\" and continue.\n- **General rule:** a missing tool that the WO never asked you to execute is not a failure. Adapt (static-check instead of run) and proceed; surface the limitation rather than burning the build chasing it.\n\n## Canonical Placement\n\n`BDC_XO/harness/policies/agent-behavior.md` — single source of truth. Every runtime vendors/symlinks/adapts it:\n\n| Runtime | Inclusion path |\n|---------|----------------|\n| Claude Code | CLAUDE.md reference + skill at `.claude/skills/agent-behavior/SKILL.md` |\n| Codex | AGENTS.md import (Codex desktop reads this) |\n| OpenAI reviewer | system/developer prompt fragment in routing.yaml |\n| Haiku helpers | short policy fragment in adapter call |\n| bdc-harness | workflow bootstrap doctrine file, loaded by every workflow run |\n| Future vendor agents | adapter layer wraps the policy |\n\n## How agents should declare loaded\n\nAt session start, agent should declare \"behavior policy v1 loaded\" or demonstrably operate by the principles.\n";
