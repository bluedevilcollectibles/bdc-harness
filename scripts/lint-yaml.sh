#!/usr/bin/env bash
# lint-yaml.sh — Rule 29 lint gate
#
# Fails if any bdc-*.yaml file contains a bare `gh pr create` without --repo or -R
# in an actual bash command position (not echo strings, not comments, not multi-line
# continuation lines where --repo appears on the next line).
#
# Scoped to bdc-*.yaml only; archon-* prompt text is intentionally excluded.
#
# Usage:
#   bash scripts/lint-yaml.sh                              # scans default dir
#   bash scripts/lint-yaml.sh .archon/workflows/defaults/  # explicit dir
#   bash scripts/lint-yaml.sh --check                      # alias for default

set -euo pipefail

TARGET_DIR=".archon/workflows/defaults"
if [ "${1:-}" = "--check" ]; then
  shift
fi
if [ -n "${1:-}" ]; then
  TARGET_DIR="$1"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "ERROR: directory not found: $TARGET_DIR" >&2
  exit 1
fi

# Find bare gh pr create calls, filtering false positives:
#   :[0-9]+:\s*#     — comment lines in the YAML (grep output format includes filename:linenum:)
#   :[0-9]+:\s*(echo|printf) — echo/printf strings that mention the command as text
#   \\$              — continuation lines (--repo appears on the NEXT line)
VIOLATIONS=$(
  grep -rn 'gh pr create' "$TARGET_DIR"/bdc-*.yaml 2>/dev/null \
  | grep -Ev ':[0-9]+:[[:space:]]*#' \
  | grep -Ev ':[0-9]+:[[:space:]]*(echo|printf)[[:space:]]' \
  | grep -Ev '[\\]$' \
  | grep -Ev '(--repo |-R )' \
  || true
)

if [ -n "$VIOLATIONS" ]; then
  echo "Rule 29 FAIL: bare 'gh pr create' without --repo or -R found in bdc-*.yaml:"
  echo "$VIOLATIONS"
  echo ""
  echo "Every gh pr create in a bash node must include --repo <owner>/<repo>."
  echo "See docs/architecture/2026-05-16-cauldron-working-directories.md for context."
  exit 1
fi

echo "Rule 29 PASS: all bdc-*.yaml gh pr create calls include --repo or -R."
