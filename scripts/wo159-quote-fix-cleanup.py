#!/usr/bin/env python3
"""
WO-HARNESS-YAML-QUOTE-FIX-CLEANUP-01 (bdc-xo#159).

Reverse of scripts/wo154-quote-fix-sweep.py.

PR #69 (WO-153) landed the engine-side fix for substituteNodeOutputRefs so the
natural pattern `"$node.output"` works directly. The bash-var-assignment
workaround sweep that PR #67 (WO-154) applied to 7 sibling YAMLs is now obsolete
tech debt. This script reverts it.

For each bash block in each target YAML:
  1. Delete the 3-line `# 2026-05-16 quote-fix:` comment header
  2. Delete `VAR=$node-id.output` assignment lines that follow the header
  3. Substitute every `$VAR` (or `"$VAR"`) back to `$node-id.output`
     (or `"$node-id.output"`) throughout the block

Usage:
  python3 scripts/wo159-quote-fix-cleanup.py [--check]

  --check: dry-run, print diffs (changed-or-not), do not write
"""
import re
import sys
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

# Match an assignment line:  <indent>VAR=$node-id.output[.field]
# Var names are uppercase + underscores + digits.
# Node ids are lowercase + hyphens + digits.
ASSIGN_RE = re.compile(
    r'^(?P<indent>\s*)(?P<var>[A-Z][A-Z0-9_]*)=\$(?P<node>[a-z][a-z0-9-]*)\.output(?P<field>(?:\.[a-zA-Z_][\w]*)*)\s*$'
)

# Match the comment-header lines (any of the 3)
HEADER_LINE_RES = [
    re.compile(r'^\s*#\s*2026-05-16 quote-fix:'),
    re.compile(r'^\s*#\s*output in single quotes\. Wrapping in additional double quotes'),
    re.compile(r'^\s*#\s*multi-line content\. Engine fix: WO-HARNESS-NODE-OUTPUT-BASH-QUOTING-01'),
]


def find_bash_blocks(yaml_text: str):
    """Yield (body_start_line, body_end_line, body_indent) for each bash: | block."""
    lines = yaml_text.splitlines(keepends=True)
    i = 0
    while i < len(lines):
        m = re.match(r'^(\s*)bash:\s*\|', lines[i])
        if not m:
            i += 1
            continue
        bash_key_indent = len(m.group(1))
        body_start_line = i + 1
        body_indent = None
        j = body_start_line
        while j < len(lines):
            line = lines[j]
            stripped = line.lstrip(' ')
            line_indent = len(line) - len(stripped)
            if stripped.strip() == '':
                j += 1
                continue
            if body_indent is None:
                body_indent = line_indent
                if body_indent <= bash_key_indent:
                    break
                j += 1
                continue
            if line_indent < body_indent and stripped.strip() != '':
                break
            j += 1
        body_end_line = j
        if body_indent is not None and body_end_line > body_start_line:
            yield (body_start_line, body_end_line, body_indent)
        i = body_end_line if body_end_line > i else i + 1


def revert_block(block_lines: list[str]) -> tuple[list[str], int, int, int]:
    """Return (new_lines, headers_dropped, assigns_dropped, var_subs)."""
    headers_dropped = 0
    assigns_dropped = 0

    # Pass 1: collect var -> $node.output[.field] mapping from any assign lines,
    # and identify lines to drop (comment headers + matching assigns).
    var_map: dict[str, str] = {}
    drop_idx: set[int] = set()

    for idx, line in enumerate(block_lines):
        for hr in HEADER_LINE_RES:
            if hr.match(line):
                drop_idx.add(idx)
                headers_dropped += 1
                break

        am = ASSIGN_RE.match(line)
        if am:
            var = am.group('var')
            node = am.group('node')
            field = am.group('field') or ''
            # Only treat this as a WO-154 sweep assignment when the var name follows
            # the sweep's NODE_ID_OUTPUT[_FIELD] convention. Otherwise leave alone.
            expected_base = node.upper().replace('-', '_') + '_OUTPUT'
            expected_suffix = field.replace('.', '_').upper() if field else ''
            expected_var = expected_base + expected_suffix
            if var == expected_var:
                var_map[var] = '$' + node + '.output' + field
                drop_idx.add(idx)
                assigns_dropped += 1

    if not var_map and headers_dropped == 0:
        return block_lines, 0, 0, 0

    # Pass 2: drop marked lines, substitute $VAR -> $node.output[.field] in the rest.
    kept_lines: list[str] = []
    var_subs = 0
    if var_map:
        # Sort vars by length desc so longer names match before shorter prefixes.
        sorted_vars = sorted(var_map.keys(), key=len, reverse=True)
        # Build a single regex that matches $VAR or ${VAR} for any var in the map,
        # using word-boundary lookahead so $READ_SPEC_OUTPUT_FOO doesn't accidentally
        # match $READ_SPEC_OUTPUT.
        alt = '|'.join(re.escape(v) for v in sorted_vars)
        sub_re = re.compile(r'\$\{(' + alt + r')\}|\$(' + alt + r')(?![A-Z0-9_])')

        def repl(m):
            nonlocal var_subs
            var = m.group(1) or m.group(2)
            var_subs += 1
            return var_map[var]

        for idx, line in enumerate(block_lines):
            if idx in drop_idx:
                continue
            new_line = sub_re.sub(repl, line)
            kept_lines.append(new_line)
    else:
        for idx, line in enumerate(block_lines):
            if idx in drop_idx:
                continue
            kept_lines.append(line)

    return kept_lines, headers_dropped, assigns_dropped, var_subs


def process_file(path: Path, check_only: bool) -> dict:
    original = path.read_text(encoding='utf-8')
    lines = original.splitlines(keepends=True)
    blocks = list(find_bash_blocks(original))

    total_headers_dropped = 0
    total_assigns_dropped = 0
    total_var_subs = 0
    blocks_modified = 0

    # Process in reverse so line indices stay valid.
    for body_start, body_end, _indent in reversed(blocks):
        block_lines = lines[body_start:body_end]
        new_block, hdr, asg, subs = revert_block(block_lines)
        if hdr == 0 and asg == 0 and subs == 0:
            continue
        lines[body_start:body_end] = new_block
        blocks_modified += 1
        total_headers_dropped += hdr
        total_assigns_dropped += asg
        total_var_subs += subs

    new_text = ''.join(lines)
    changed = new_text != original
    if changed and not check_only:
        path.write_text(new_text, encoding='utf-8', newline='')

    return {
        'path': path.name,
        'changed': changed,
        'blocks_modified': blocks_modified,
        'headers_dropped': total_headers_dropped,
        'assigns_dropped': total_assigns_dropped,
        'var_subs': total_var_subs,
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

    print("\n=== Cleanup summary ===")
    print(f"{'file':<40} {'changed':<8} {'blocks':<7} {'hdrs':<6} {'assigns':<8} {'subs':<6}")
    for r in results:
        print(f"{r['path']:<40} {str(r['changed']):<8} {r['blocks_modified']:<7} {r['headers_dropped']:<6} {r['assigns_dropped']:<8} {r['var_subs']:<6}")
    total_changed = sum(1 for r in results if r['changed'])
    total_subs = sum(r['var_subs'] for r in results)
    print(f"\nTotal YAMLs changed: {total_changed}/{len(results)}")
    print(f"Total var subs: {total_subs}")
    if check_only:
        print("(check-only: no files written)")


if __name__ == '__main__':
    main()
