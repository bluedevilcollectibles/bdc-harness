#!/usr/bin/env python3
"""
WO-HARNESS-YAML-QUOTE-FIX-SWEEP-01 sweep tool.

Applies the bdc-harness#65 quote-fix pattern to 7 sibling YAMLs.

For each bash block in each YAML that contains "$<node-id>.output" patterns:
  1. Find all unique $node-id.output (and $node-id.output.field) references inside that bash block
  2. Emit a comment header explaining the workaround
  3. Emit VAR=$node-id.output assignments at top of bash block
  4. Replace "$node-id.output" -> "$VAR" and bare $node-id.output -> $VAR throughout the block

The fix is engine-side; tracked in WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01 (bdc-xo#153).
This sweep is the workaround until that lands.

Usage:
  python3 scripts/wo154-quote-fix-sweep.py [--check]

  --check: dry-run (print diffs, do not write)
"""
import re
import sys
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULTS_DIR = REPO_ROOT / ".archon" / "workflows" / "defaults"

TARGET_YAMLS = [
    "bdc-bug-fix.yaml",
    "bdc-ce-branch-model.yaml",
    "bdc-cleanup-sweep.yaml",
    "bdc-doctrine-update.yaml",
    "bdc-infra-deploy.yaml",
    "bdc-shopops-channel-admin-ui.yaml",
    "bdc-wo-grader.yaml",
]

COMMENT_HEADER = (
    "# 2026-05-16 quote-fix: substituteNodeOutputRefs(escapedForBash=true) wraps\n"
    "# output in single quotes. Wrapping in additional double quotes mis-tokenizes\n"
    "# multi-line content. Engine fix: WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01."
)

# Match "$node-id.output" or "$node-id.output.field" or bare $node-id.output
# Node IDs are lowercase + hyphens + digits; field after .output is optional dotted segments.
OUTPUT_REF_RE = re.compile(r'\$([a-z][a-z0-9-]*)\.output(\.[a-zA-Z_][\w.]*)?')


def node_to_var(node_id: str, field: str | None) -> str:
    """decide-push-target -> DECIDE_PUSH_TARGET_OUTPUT.
       node-id + field 'x.y' -> NODE_ID_OUTPUT_X_Y"""
    base = node_id.upper().replace('-', '_') + '_OUTPUT'
    if field:
        # field looks like '.foo.bar' -> '_FOO_BAR'
        suffix = field.replace('.', '_').upper()
        base += suffix
    return base


def find_bash_blocks(yaml_text: str):
    """Yield (block_start_idx, block_end_idx, content_indent_str, content_str) for each bash: | block.

    A bash block starts at `bash: |` (or `bash: |-`, etc) and extends until a line at <= the
    `bash:` key indent level introduces a new key, or end-of-file.
    """
    lines = yaml_text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = re.match(r'^(\s*)bash:\s*\|', lines[i])
        if not m:
            i += 1
            continue
        bash_key_indent = len(m.group(1))
        # block body starts on next line
        body_start_line = i + 1
        # determine indent of body (first non-empty line)
        body_indent = None
        j = body_start_line
        while j < len(lines):
            line = lines[j]
            stripped = line.lstrip(' ')
            line_indent = len(line) - len(stripped)
            if stripped.strip() == '':
                # empty / blank line — still part of block, keep going
                j += 1
                continue
            if body_indent is None:
                # first content line sets the body indent
                body_indent = line_indent
                if body_indent <= bash_key_indent:
                    # body should be indented MORE than the bash: key — malformed
                    break
                j += 1
                continue
            # any subsequent content line must keep indent >= body_indent OR be blank
            if line_indent < body_indent and stripped.strip() != '':
                # We've left the block
                break
            j += 1
        body_end_line = j  # exclusive
        if body_indent is not None and body_end_line > body_start_line:
            body_str = ''.join(lines[body_start_line:body_end_line])
            yield (body_start_line, body_end_line, ' ' * body_indent, body_str)
        i = body_end_line if body_end_line > i else i + 1


def already_patched(body_str: str) -> bool:
    """Skip blocks that already have the 2026-05-16 quote-fix comment header."""
    return "2026-05-16 quote-fix" in body_str


def transform_bash_block(body_str: str, indent: str) -> tuple[str, int]:
    """Return (new_body, num_refs_substituted). If no refs found, returns (body_str, 0) unchanged."""
    refs = OUTPUT_REF_RE.findall(body_str)
    if not refs:
        return body_str, 0

    # Build the unique list of (node_id, field) pairs, preserving order of first appearance
    seen = {}
    for node_id, field in refs:
        key = (node_id, field)
        if key not in seen:
            seen[key] = node_to_var(node_id, field)

    # Build header + assignments
    comment_lines = [indent + line for line in COMMENT_HEADER.splitlines()]
    assign_lines = []
    for (node_id, field), var in seen.items():
        # If field is non-empty we still assign the base .output; usage will read fields via grep/sed
        # because bash can't natively access dotted JSON keys. But upstream we typically only use .output.
        # For simplicity: always assign $node.output to VAR. Field-suffix vars use the base assignment too,
        # but the substitution in body replaces the FULL `$node.output.field` with `$VAR_FIELD`,
        # which assumes downstream usage extracts the field — keep consistent with how PR #65 did it
        # (PR #65 didn't have field-suffix cases; all were bare .output).
        assign_lines.append(indent + f"{var}=$" + node_id + ".output")
    # Dedup assign_lines while preserving order (multiple field-suffixes for same node_id would
    # otherwise produce dup `NODE_OUTPUT=$node.output` lines)
    dedup_assigns = []
    seen_assigns = set()
    for line in assign_lines:
        if line not in seen_assigns:
            seen_assigns.add(line)
            dedup_assigns.append(line)
    assign_lines = dedup_assigns

    header = '\n'.join(comment_lines + assign_lines) + '\n'

    # Substitute each `$node.output[.field]` reference in body with the corresponding var
    # We sort by length desc to substitute longer (with-field) patterns before shorter ones.
    def replace(match):
        node_id, field = match.group(1), match.group(2) or ''
        return '$' + node_to_var(node_id, field if field else None)

    new_body = OUTPUT_REF_RE.sub(replace, body_str)

    # Place header AFTER any leading `set -euo pipefail` / `set -e` / shebang-like line.
    # Simple rule: if body starts with set -*, keep that as line 1; otherwise prepend header at top.
    body_lines = new_body.splitlines(keepends=True)
    insert_at = 0
    if body_lines and re.match(r'^\s*set\s+-[a-z]+', body_lines[0]):
        insert_at = 1
    body_lines.insert(insert_at, header)
    return ''.join(body_lines), len(refs)


def process_file(path: Path, check_only: bool) -> dict:
    original = path.read_text(encoding='utf-8')
    new_text = original
    total_subs = 0
    blocks_patched = 0
    blocks_skipped_already = 0
    blocks_no_match = 0

    # Process blocks in REVERSE order so index offsets in `lines` stay valid as we mutate.
    blocks = list(find_bash_blocks(original))
    lines = original.splitlines(keepends=True)
    for body_start, body_end, indent, body_str in reversed(blocks):
        if already_patched(body_str):
            blocks_skipped_already += 1
            continue
        new_body, n_subs = transform_bash_block(body_str, indent)
        if n_subs == 0:
            blocks_no_match += 1
            continue
        lines[body_start:body_end] = [new_body]
        blocks_patched += 1
        total_subs += n_subs

    new_text = ''.join(lines)

    changed = new_text != original
    if changed and not check_only:
        # Write UTF-8 no BOM (Python default). LF preserved.
        path.write_text(new_text, encoding='utf-8', newline='')

    return {
        'path': path.name,
        'changed': changed,
        'blocks_patched': blocks_patched,
        'blocks_skipped_already': blocks_skipped_already,
        'blocks_no_match': blocks_no_match,
        'refs_substituted': total_subs,
    }


def main():
    check_only = '--check' in sys.argv

    results = []
    for fname in TARGET_YAMLS:
        path = DEFAULTS_DIR / fname
        if not path.exists():
            print(f"MISSING: {fname}", file=sys.stderr)
            continue
        r = process_file(path, check_only)
        results.append(r)

    # Summary
    print("\n=== Sweep summary ===")
    print(f"{'file':<40} {'changed':<8} {'patched':<8} {'subs':<6} {'skipped':<8} {'no-match':<8}")
    for r in results:
        print(f"{r['path']:<40} {str(r['changed']):<8} {r['blocks_patched']:<8} {r['refs_substituted']:<6} {r['blocks_skipped_already']:<8} {r['blocks_no_match']:<8}")
    total_changed = sum(1 for r in results if r['changed'])
    total_subs = sum(r['refs_substituted'] for r in results)
    print(f"\nTotal YAMLs changed: {total_changed}/{len(results)}")
    print(f"Total refs substituted: {total_subs}")
    if check_only:
        print("(check-only: no files written)")


if __name__ == '__main__':
    main()
