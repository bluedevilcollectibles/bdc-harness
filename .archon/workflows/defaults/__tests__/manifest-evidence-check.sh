#!/usr/bin/env bash
# manifest-evidence-check.sh -- unit tests for the manifest-evidence-check node core
# (mec_*) in .archon/workflows/defaults/bdc-feature-development-codex.yaml and its
# byte-identical mirrors in the other 10 bdc-feature-development lanes.
#
# bdc-xo #1940: manifest-evidence-check fails CLOSED when a CODE or MIXED WO would
# publish "Tests: N/A ..." or when the spec declared grep stop conditions but the
# manifest's "Grep assertions:" line is N/A. patch-pr-body is gated on its "OK".
#
# Run: bash .archon/workflows/defaults/__tests__/manifest-evidence-check.sh
# Exits 0 on all-pass, 1 on any failure. ASCII only.

set -uo pipefail

FAIL=0
PASS=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  expected: [$expected]"; echo "  actual:   [$actual]"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    PASS=$((PASS + 1)); echo "PASS: $label"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  needle:   $needle"; echo "  haystack: $haystack"
  fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULTS="$HERE/.."
CANONICAL_YAML="$DEFAULTS/bdc-feature-development-codex.yaml"
LANES="
bdc-feature-development-codex-only.yaml
bdc-feature-development-codex.yaml
bdc-feature-development-fable.yaml
bdc-feature-development-fusion-cx-kimi.yaml
bdc-feature-development-fusion-cx-qwen.yaml
bdc-feature-development-grok.yaml
bdc-feature-development-kimi-k3.yaml
bdc-feature-development-zero-claude.yaml
bdc-feature-development-zero-open.yaml
bdc-feature-development-zero.yaml
bdc-feature-development.yaml
"

extract_core() {
  tr -d '\r' < "$1" | awk -v m="$2" '
    index($0, "# ---- BEGIN " m " core") { c = 1; next }
    index($0, "# ---- END " m " core") { c = 0 }
    c
  ' | sed 's/^      //'
}

MEC_CORE="$(extract_core "$CANONICAL_YAML" mec)"
if [ -z "$MEC_CORE" ]; then
  echo "FATAL: could not extract mec core from $CANONICAL_YAML"; exit 1
fi
eval "$MEC_CORE"
for fn in mec_field mec_check; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: mec core byte-identical across all 11 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$MEC_CORE" "$(extract_core "$DEFAULTS/$lane" mec)"
done

GOOD='WO: WO-X
Builder: Smart Cauldron (bdc-feature-development-codex)
Files created: a.js
Files modified: b.js
Tests: 27/27 (cd shopops-api && node tests/run_all.js --suite=cgc_dealer)
PRs: https://github.com/thinmansoftware/shopops/pull/674
Merge ancestors: 1c6e...c4f9 (behind_by=0)
Grep assertions: grep -c "a" b.js => 1; grep -c "c" a.js => 2
Runtime verification: N/A
VALIDATION: PASS
Stop conditions: tests=passed; greps=passed'
NA_TESTS="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: N/A (required gates are reported separately)|')"
NA_GREPS="$(printf '%s\n' "$GOOD" | sed 's|^Grep assertions:.*|Grep assertions: N/A (no declared mechanical assertions)|')"
FAILED_TESTS="$(printf '%s\n' "$GOOD" | sed 's|^Tests:.*|Tests: 6/8 (node t.js) -- FAILED, exit 1|; s|^VALIDATION:.*|VALIDATION: FAIL|')"

run_check() {
  # run_check <manifest> <status> <class> <tests_status> <grep_declared> <grep_status>
  # -> "<rc>|<stdout>|<stderr>"
  local out err rc
  err="$(mktemp)"
  out="$(printf '%s\n' "$1" | mec_check "$2" "$3" "$4" "$5" "$6" 2>"$err")"; rc=$?
  printf '%s|%s|%s' "$rc" "$out" "$(cat "$err")"
  rm -f "$err"
}

echo "--- Test 1: PROCEED CODE with real numbers and executed greps -> OK ---"
R="$(run_check "$GOOD" PROCEED CODE passed 9 passed)"
assert_eq "rc 0 / OK" "0|OK|" "$R"

echo "--- Test 2: PROCEED CODE with Tests: N/A -> EVIDENCE_ERROR rc 1 ---"
R="$(run_check "$NA_TESTS" PROCEED CODE no_command_declared 9 passed)"
assert_eq "rc 1, no OK on stdout" "1" "${R%%|*}"
assert_contains "error names the placeholder and the class" 'EVIDENCE_ERROR: Tests: "N/A (required gates are reported separately)" on a CODE WO (tests_status=no_command_declared)' "$R"
assert_contains "error cites the rule" "Rule 10" "$R"

echo "--- Test 3: PROCEED MIXED with Tests: N/A -> error ---"
R="$(run_check "$NA_TESTS" PROCEED MIXED counts_unparsed 0 none_declared)"
assert_eq "rc 1" "1" "${R%%|*}"

echo "--- Test 4: empty class defaults to CODE (doctrine default) -> error on N/A ---"
R="$(run_check "$NA_TESTS" PROCEED "" "" 0 "")"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "reports missing tests_status" "tests_status=missing" "$R"

echo "--- Test 5: INFRA / DOCUMENTATION with Tests: N/A and no greps -> OK ---"
R="$(run_check "$NA_TESTS" PROCEED INFRA not_required 0 none_declared)"
assert_eq "INFRA OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" PROCEED DOCUMENTATION not_required 0 none_declared)"
assert_eq "DOCUMENTATION OK" "0|OK|" "$R"

echo "--- Test 6: declared greps but Grep assertions: N/A -> error (any class) ---"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 9 all_dropped)"
assert_eq "rc 1" "1" "${R%%|*}"
assert_contains "error names the declared count" "the spec declares 9 grep stop condition(s) (grep_status=all_dropped)" "$R"
R="$(run_check "$NA_GREPS" PROCEED INFRA not_required 2 all_dropped)"
assert_eq "INFRA with declared greps and N/A also rc 1" "1" "${R%%|*}"

echo "--- Test 7: no greps declared, Grep assertions: N/A -> OK ---"
R="$(run_check "$NA_GREPS" PROCEED CODE passed 0 none_declared)"
assert_eq "rc 0 / OK" "0|OK|" "$R"

echo "--- Test 8: failing tests are NOT blocked here (stamped honestly, VALIDATION: FAIL) ---"
R="$(run_check "$FAILED_TESTS" PROCEED CODE failed 9 passed)"
assert_eq "rc 0 / OK so the honest FAIL manifest reaches the PR body" "0|OK|" "$R"

echo "--- Test 9: non-PROCEED paths are not gated ---"
R="$(run_check "$NA_TESTS" ALREADY_SATISFIED CODE "" 0 "")"
assert_eq "ALREADY_SATISFIED OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" BLOCKED CODE "" 0 "")"
assert_eq "BLOCKED OK" "0|OK|" "$R"
R="$(run_check "$NA_TESTS" "" CODE "" 0 "")"
assert_eq "empty status OK" "0|OK|" "$R"

echo "--- Test 10: short manifest (no Tests: line) is not gated ---"
R="$(run_check "$(printf 'WO: WO-X\nOUTCOME=ALREADY_SATISFIED\nVALIDATION: PASS')" PROCEED CODE "" 0 "")"
assert_eq "short manifest OK" "0|OK|" "$R"

echo "--- mec_field ---"
assert_eq "TESTS_CLASS" "CODE" "$(mec_field TESTS_CLASS "$(printf 'TESTS_CLASS=CODE\nTESTS_STATUS=passed')")"
assert_eq "GREP_DECLARED" "9" "$(mec_field GREP_DECLARED "$(printf 'GREP_DECLARED=9\nGREP_STATUS=passed')")"
assert_eq "missing -> empty" "" "$(mec_field GREP_DECLARED "")"

echo
echo "manifest-evidence-check.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
