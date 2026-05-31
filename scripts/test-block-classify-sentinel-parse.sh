#!/usr/bin/env bash
# Test harness for WO-FEATURE-DEV-BLOCK-CLASSIFY-SENTINEL-PARSE-01.
#
# Verifies that the new anchor-free, last-occurrence parse of the
# DIFF_REVIEW_FINAL sentinel correctly handles four scenarios:
#   1. satisfied verdict appearing inline in prose
#   2. needs_revision verdict appearing inline in prose
#   3. token appearing twice (instruction text + final verdict)
#   4. token absent entirely (fail-closed)
#
# IMPORTANT: this script intentionally uses `set -uo pipefail` (no `-e`).
# In Test 4 the `grep -oE ... | tail -n 1` pipeline contains a non-matching
# grep that exits 1; with `-e` the script would abort at that point.
# Without `-e`, the empty stdout is assigned to `final_verdict` and the
# fail-closed assertion runs as designed.
set -uo pipefail

PASS=0
FAIL=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS [${label}]"
    PASS=$((PASS + 1))
  else
    echo "FAIL [${label}]: expected='${expected}' got='${actual}'"
    FAIL=$((FAIL + 1))
  fi
}

# The parse snippet under test -- copied VERBATIM from the new
# block-classify body in .archon/workflows/defaults/bdc-feature-development.yaml
parse() {
  local input="$1"
  final_ok=false
  final_verdict=$(printf '%s\n' "$input" \
    | grep -oE 'DIFF_REVIEW_FINAL=(satisfied|needs_revision)' \
    | tail -n 1)
  if [ "$final_verdict" = "DIFF_REVIEW_FINAL=satisfied" ]; then final_ok=true; fi
}

# -----------------------------------------------------------------------------
# Test 1 -- satisfied verdict in prose (the regression case)
# -----------------------------------------------------------------------------
parse "analysis complete. DIFF_REVIEW_FINAL=satisfied UNRESOLVED: (none)"
check "Test 1 final_verdict satisfied in prose" \
  "DIFF_REVIEW_FINAL=satisfied" "$final_verdict"
check "Test 1 final_ok satisfied in prose" \
  "true" "$final_ok"

# -----------------------------------------------------------------------------
# Test 2 -- needs_revision verdict in prose
# -----------------------------------------------------------------------------
parse "one finding remains. DIFF_REVIEW_FINAL=needs_revision"
check "Test 2 final_verdict needs_revision in prose" \
  "DIFF_REVIEW_FINAL=needs_revision" "$final_verdict"
check "Test 2 final_ok needs_revision in prose" \
  "false" "$final_ok"

# -----------------------------------------------------------------------------
# Test 3 -- token appears twice; LAST occurrence wins
# -----------------------------------------------------------------------------
parse "emit DIFF_REVIEW_FINAL=needs_revision if any finding ... my verdict: DIFF_REVIEW_FINAL=satisfied"
check "Test 3 final_verdict last-occurrence wins" \
  "DIFF_REVIEW_FINAL=satisfied" "$final_verdict"
check "Test 3 final_ok last-occurrence wins" \
  "true" "$final_ok"

# -----------------------------------------------------------------------------
# Test 4 -- no token at all; fail-closed
# -----------------------------------------------------------------------------
parse "the review found no sentinel token here"
check "Test 4 final_verdict no token is empty" \
  "" "$final_verdict"
check "Test 4 final_ok no token is fail-closed" \
  "false" "$final_ok"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
