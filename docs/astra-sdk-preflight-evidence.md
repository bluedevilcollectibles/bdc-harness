# WO1922 scratch SDK availability evidence

Date: 2026-09-05. Platform: local Windows desktop, existing subscription auth.
Repository source base: d277f8c3c1596ea091b22d971fd18eafa30fea45.
Scratch dependency: @openai/codex-sdk@0.153.3, installed with --ignore-scripts.
Repository dependency before preflight: 0.144.5. No production upgrade performed.

CLI --version: codex-cli 0.153.3.
Invocation (scratch binary resolved from the installed SDK):

```text
codex.exe exec --ignore-user-config --skip-git-repo-check --ephemeral --sandbox read-only -m gpt-6-astra --json "Reply with exactly: ASTRA ONLINE. Do not use tools or read files."
```

Sanitized stdout transcript, exit0, 2026-09-05 13:30Z:

```json
{"type":"thread.started","thread_id":"01a071c3-b6d9-7f52-afb7-f22a053ca936"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ASTRA ONLINE"}}
{"type":"turn.completed","usage":{"input_tokens":20769,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}
```

CLI stderr reported unrelated existing skills with missing YAML frontmatter; those
did not prevent the response. No tool-call events were emitted. This was a local
provider availability probe, not a Cauldron workflow run or all-seat test.

Before: existing local catalog client_version0.153.4 already included gpt-6-astra.
After: fresh catalog client_version0.153.3 included gpt-6-astra, gpt-reserve,
gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4-mini,
gpt-5.3-codex-spark, codex-auto-review.

Requested identity: gpt-6-astra. Independently returned served identity: absent
from JSON event transcript; do not invent that field. The named request succeeded
without the historical newer-client400 failure.

Live event-store read-only check used SQLite URI mode=ro after inspecting schema.
remote_agent_workflow_runs query matched workflow_name containing astra OR
user_message containing WO-HARNESS-ASTRA-LANE-01: zero rows. Stored status counts:
cancelled95, completed538, escalated123, failed156, orphaned1. No running/pending
statuses were present at observation. Do not infer future or external process state.

Live checked bundled/root-global workflow paths had no Astra filename, and the
Codex-only YAML still named Sol. No rebuild, restart, credential change or runtime
activation occurred. Scratch files are local-only and excluded from commits.

Fable probe (local existing subscription, tools disabled, read-only plan mode):

```text
claude -p --model claude-fable-5 --permission-mode plan --tools "" --no-session-persistence --output-format json "Reply exactly FABLE ONLINE. Do not use tools."
```

Exit0, result FABLE ONLINE, is_error false, num_turns1, permission_denials empty.
Returned modelUsage key: claude-fable-5. Session3696dc06-e1ad-4312-81d2-93174c075551.
No tools were invoked. This is a model availability probe, not code review.
