#!/usr/bin/env bash
# Test harness: WO-FEATURE-DEV-BLOCK-CLASSIFY-SENTINEL-PARSE-01
# Asserts the anchor-free DIFF_REVIEW_FINAL parse logic used in
# .archon/workflows/defaults/bdc-feature-development.yaml at the block-classify
# and commit-and-push nodes. The parse must:
#   - match the token anywhere in Codex prose (no ^ anchor),
#   - take the LAST occurrence as authoritative (tail -n 1),
#   - fail-closed when no token is present.
set -uo pipefail
PASS=0; FAIL=0

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "PASS: $label"; PASS=$((PASS+1))
  else
    echo "FAIL: $label -- got='$got' want='$want'"; FAIL=$((FAIL+1))
  fi
}

parse_verdict() {
  printf '%s\n' "$1" \
    | grep -oE 'DIFF_REVIEW_FINAL=(satisfied|needs_revision)' \
    | tail -n 1
}
final_ok_for() {
  local v; v=$(parse_verdict "$1")
  [ "$v" = "DIFF_REVIEW_FINAL=satisfied" ] && echo "true" || echo "false"
}

# Test 1 -- satisfied verdict in prose (the regression case)
T1="analysis complete. DIFF_REVIEW_FINAL=satisfied UNRESOLVED: (none)"
assert_eq "T1 verdict"   "$(parse_verdict "$T1")"  "DIFF_REVIEW_FINAL=satisfied"
assert_eq "T1 final_ok"  "$(final_ok_for  "$T1")"  "true"

# Test 2 -- needs_revision verdict in prose
T2="one finding remains. DIFF_REVIEW_FINAL=needs_revision"
assert_eq "T2 verdict"   "$(parse_verdict "$T2")"  "DIFF_REVIEW_FINAL=needs_revision"
assert_eq "T2 final_ok"  "$(final_ok_for  "$T2")"  "false"

# Test 3 -- token appears twice (instruction text then final verdict); LAST wins
T3="emit DIFF_REVIEW_FINAL=needs_revision if any finding ... my verdict: DIFF_REVIEW_FINAL=satisfied"
assert_eq "T3 verdict"   "$(parse_verdict "$T3")"  "DIFF_REVIEW_FINAL=satisfied"
assert_eq "T3 final_ok"  "$(final_ok_for  "$T3")"  "true"

# Test 4 -- no verdict token at all (malformed reviewer output -- fail-closed)
T4="all looks fine, nothing to report here"
assert_eq "T4 verdict"   "$(parse_verdict "$T4")"  ""
assert_eq "T4 final_ok"  "$(final_ok_for  "$T4")"  "false"

echo "---"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
