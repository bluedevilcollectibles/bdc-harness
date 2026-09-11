#!/usr/bin/env bash
# stamp-manifest-evidence.sh -- unit tests for the stamp-manifest-evidence node core
# (sme_*) in .archon/workflows/defaults/bdc-feature-development-codex.yaml and its
# byte-identical mirrors in the other 10 bdc-feature-development lanes.
#
# bdc-xo #1940: the engine-side build-manifest renders placeholder "Tests: N/A
# (required gates are reported separately)" and "Grep assertions: N/A (no declared
# mechanical assertions)" lines. stamp-manifest-evidence overwrites both with the
# observed values from run-stop-tests / run-stop-greps and flips VALIDATION to FAIL
# when a declared stop condition did not hold.
#
# Run: bash .archon/workflows/defaults/__tests__/stamp-manifest-evidence.sh
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

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s\n' "$haystack" | grep -Fq "$needle"; then
    FAIL=$((FAIL + 1)); echo "FAIL: $label"; echo "  unexpected: $needle"
  else
    PASS=$((PASS + 1)); echo "PASS: $label"
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

SME_CORE="$(extract_core "$CANONICAL_YAML" sme)"
if [ -z "$SME_CORE" ]; then
  echo "FATAL: could not extract sme core from $CANONICAL_YAML"; exit 1
fi
eval "$SME_CORE"
for fn in sme_field sme_process; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: sme core byte-identical across all 11 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$SME_CORE" "$(extract_core "$DEFAULTS/$lane" sme)"
done

# The REAL engine manifest from run 69f9d306 (shopops #674), event store, 2026-09-05.
ENGINE_MANIFEST='WO: WO-SHOPOPS-M157-CGC-DEALER-API-01
Builder: Smart Cauldron (bdc-feature-development-codex)
Files created: shopops-api/services/connect/providers/cgc-dealer-api.js, shopops-api/tests/test_cgc_dealer_api.js
Files modified: shopops-api/services/cert-lookup.js, shopops-api/routes/vault.js
Tests: N/A (required gates are reported separately)
PRs: N/A (committed)
Merge ancestors: 1c6e47a227fdc7b808a13734adf79ee43fd92d3f...c4f931587965b487d4caa6516ce9a99876daa1d8 (behind_by=0)
Grep assertions: N/A (no declared mechanical assertions)
Runtime verification: plan-review=PLAN_REVIEW_PASS=true; block-reclassify={"status":"PROCEED"}
VALIDATION: PASS
OUTCOME: execution=running; deliverable=committed; validation=passed; recovery=not_needed; route=current; reason=run_running'

TESTS_OUT='TESTS_CLASS=CODE
TESTS_COMMAND=cd shopops-api && node tests/test_cgc_dealer_api.js
TESTS_EXIT=0
TESTS_PASSED=8
TESTS_TOTAL=8
TESTS_STATUS=passed
TESTS_LINE=8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)
TESTS_LOG=/tmp/x/evidence/stop-tests.log'
GREPS_OUT='GREP_DECLARED=9
GREP_EXECUTED=8
GREP_DROPPED=1
GREP_MISMATCH=0
GREP_STATUS=passed
GREP_LINE=grep -c "cgc-dealer-api" shopops-api/services/cert-lookup.js => 1; grep -c "/comics/certifications" shopops-api/services/connect/providers/cgc-dealer-api.js => 2'

echo "--- sme_field ---"
assert_eq "TESTS_LINE" "8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)" "$(sme_field TESTS_LINE "$TESTS_OUT")"
assert_eq "GREP_STATUS" "passed" "$(sme_field GREP_STATUS "$GREPS_OUT")"
assert_eq "missing key -> empty" "" "$(sme_field NOPE "$TESTS_OUT")"
assert_eq "empty node output -> empty" "" "$(sme_field TESTS_LINE "")"

echo "--- Test 1: real engine manifest, all green ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "$(sme_field TESTS_LINE "$TESTS_OUT")" "$(sme_field TESTS_STATUS "$TESTS_OUT")" "$(sme_field GREP_LINE "$GREPS_OUT")" "$(sme_field GREP_STATUS "$GREPS_OUT")")"
assert_eq "Tests: line stamped with observed numbers" "Tests: 8/8 (cd shopops-api && node tests/test_cgc_dealer_api.js)" "$(printf '%s\n' "$OUT" | grep -E '^Tests:')"
assert_eq "Grep assertions: line stamped with observed counts" 'Grep assertions: grep -c "cgc-dealer-api" shopops-api/services/cert-lookup.js => 1; grep -c "/comics/certifications" shopops-api/services/connect/providers/cgc-dealer-api.js => 2' "$(printf '%s\n' "$OUT" | grep -E '^Grep assertions:')"
assert_not_contains "placeholder Tests text gone" "required gates are reported separately" "$OUT"
assert_not_contains "placeholder Grep text gone" "no declared mechanical assertions" "$OUT"
assert_contains "VALIDATION stays PASS" "VALIDATION: PASS" "$OUT"
assert_eq "Stop conditions audit line follows VALIDATION" "Stop conditions: tests=passed; greps=passed (observed by run-stop-tests / run-stop-greps in the run worktree)" "$(printf '%s\n' "$OUT" | grep -A1 '^VALIDATION:' | tail -1)"
assert_eq "line count = engine + 1 audit line" "12" "$(printf '%s\n' "$OUT" | grep -c .)"
assert_contains "OUTCOME line preserved" "OUTCOME: execution=running" "$OUT"
assert_contains "Merge ancestors preserved verbatim" "Merge ancestors: 1c6e47a227fdc7b808a13734adf79ee43fd92d3f...c4f931587965b487d4caa6516ce9a99876daa1d8 (behind_by=0)" "$OUT"

echo "--- Test 2: failing tests flip VALIDATION to FAIL ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "6/8 (cd shopops-api && node tests/test_cgc_dealer_api.js) -- FAILED, exit 1" failed "$(sme_field GREP_LINE "$GREPS_OUT")" passed)"
assert_contains "Tests line carries the red numbers" "Tests: 6/8 (cd shopops-api && node tests/test_cgc_dealer_api.js) -- FAILED, exit 1" "$OUT"
assert_contains "VALIDATION: FAIL" "VALIDATION: FAIL" "$OUT"
assert_not_contains "VALIDATION: PASS gone" "VALIDATION: PASS" "$OUT"
assert_contains "audit line says tests=failed" "Stop conditions: tests=failed; greps=passed" "$OUT"

echo "--- Test 3: grep mismatch flips VALIDATION to FAIL ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "8/8 (x)" passed 'grep -c "a" b => 0' mismatch)"
assert_contains "VALIDATION: FAIL on grep mismatch" "VALIDATION: FAIL" "$OUT"
assert_contains "audit line says greps=mismatch" "greps=mismatch" "$OUT"

echo "--- Test 4: short ALREADY_SATISFIED manifest passes through untouched ---"
SHORT='WO: WO-X
OUTCOME=ALREADY_SATISFIED
Files created: none
VALIDATION: PASS (verified no-op)'
OUT="$(printf '%s\n' "$SHORT" | sme_process "8/8 (x)" passed "N/A (spec declares no grep stop conditions)" none_declared)"
assert_eq "short manifest unchanged" "$SHORT" "$OUT"

echo "--- Test 5: missing evidence (skipped run-stop-* nodes) is stamped honestly ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "" "" "" "")"
assert_contains "Tests: N/A names the missing node" "Tests: N/A (evidence node run-stop-tests did not run)" "$OUT"
assert_contains "Grep: N/A names the missing node" "Grep assertions: N/A (evidence node run-stop-greps did not run)" "$OUT"
assert_contains "audit line says missing" "Stop conditions: tests=missing; greps=missing" "$OUT"
assert_contains "VALIDATION not flipped by missing evidence (manifest-evidence-check gates it)" "VALIDATION: PASS" "$OUT"

echo "--- Test 6: not_required / none_declared keep PASS and stamp N/A wording ---"
OUT="$(printf '%s\n' "$ENGINE_MANIFEST" | sme_process "N/A (INFRA class, no test command declared)" not_required "N/A (spec declares no grep stop conditions)" none_declared)"
assert_contains "INFRA N/A wording" "Tests: N/A (INFRA class, no test command declared)" "$OUT"
assert_contains "VALIDATION stays PASS" "VALIDATION: PASS" "$OUT"

echo "--- Test 7: manifest with Tests: but no Grep/VALIDATION lines gets both appended ---"
OUT="$(printf 'WO: WO-X\nTests: N/A\nPRs: x\n' | sme_process "3/3 (bun test)" passed "grep -c a b => 1" passed)"
assert_contains "Tests stamped" "Tests: 3/3 (bun test)" "$OUT"
assert_eq "Grep line appended at end, then audit line" "$(printf 'WO: WO-X\nTests: 3/3 (bun test)\nPRs: x\nGrep assertions: grep -c a b => 1\nStop conditions: tests=passed; greps=passed (observed by run-stop-tests / run-stop-greps in the run worktree)')" "$OUT"

echo
echo "stamp-manifest-evidence.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
