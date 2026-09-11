#!/usr/bin/env bash
# run-stop-greps.sh -- unit tests for the run-stop-greps node core (rsg_*) in
# .archon/workflows/defaults/bdc-feature-development-codex.yaml and its byte-identical
# mirrors in the other 10 bdc-feature-development lanes.
#
# bdc-xo #1940: the manifest "Grep assertions:" line was stamped "N/A (no declared
# mechanical assertions)" for every WO, including specs that declared grep stop
# conditions. run-stop-greps extracts each "Stop N (grep assertion ...)" block, runs
# it under the read-only allowlist, and emits OBSERVED counts.
#
# Cores are EXTRACTED from the canonical YAML (never re-typed). A parity test asserts
# the core is byte-identical across all 11 lanes.
#
# Run: bash .archon/workflows/defaults/__tests__/run-stop-greps.sh
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

RSG_CORE="$(extract_core "$CANONICAL_YAML" rsg)"
if [ -z "$RSG_CORE" ]; then
  echo "FATAL: could not extract rsg core from $CANONICAL_YAML"; exit 1
fi
eval "$RSG_CORE"
for fn in rsg_extract rsg_allow_cmd rsg_observe rsg_compare rsg_run; do
  if ! declare -F "$fn" >/dev/null; then echo "FATAL: $fn not defined after eval"; exit 1; fi
done

echo "--- Parity: rsg core byte-identical across all 11 lanes ---"
for lane in $LANES; do
  assert_eq "parity $lane" "$RSG_CORE" "$(extract_core "$DEFAULTS/$lane" rsg)"
done

TAB="$(printf '\t')"
TMP="$(mktemp -d)"
printf 'alpha\nbeta\nalpha beta\ngamma\n' > "$TMP/fixture.txt"
mkdir -p "$TMP/src"
printf 'export const x = 1;\n' > "$TMP/src/a.ts"

SPEC='# WO-X

WO Class: CODE

## 8. Stop conditions (CI-executable)

Stop 1a (grep assertion, exact):
  grep -c "alpha" fixture.txt
  Expected: 2

Stop 1b (grep assertion, at least):
  grep -c "beta" fixture.txt
  Expected: at least 1 (two lines mention beta)

Stop 1c (grep assertion, absence):
  grep -n "delta" fixture.txt
  Expected: no output

Stop 1d (grep assertion, not executable under the read-only allowlist):
  grep -rciE "password" src 2>/dev/null | awk -F: "{s+=$2} END {print s+0}"
  Expected: 0

Stop 1e (grep assertion, header without an Expected line):
  grep -c "gamma" fixture.txt

Stop 2 (test suite):
  bun test x
  Expected: 3 passing

Stop 3 (ASCII scan):
  LC_ALL=C grep -n "[^ -~]" src/a.ts
  Expected: no output
'

echo "--- rsg_extract ---"
EXTRACTED="$(printf '%s\n' "$SPEC" | rsg_extract)"
assert_contains "eq assertion extracted" "grep -c \"alpha\" fixture.txt${TAB}eq${TAB}2" "$EXTRACTED"
assert_contains "ge assertion extracted" "grep -c \"beta\" fixture.txt${TAB}ge${TAB}1" "$EXTRACTED"
assert_contains "'no output' becomes eq 0" "grep -n \"delta\" fixture.txt${TAB}eq${TAB}0" "$EXTRACTED"
assert_contains "awk assertion still extracted (dropped later, not here)" "| awk -F: \"{s+=\$2} END {print s+0}\"${TAB}eq${TAB}0" "$EXTRACTED"
assert_contains "DECLARED counts every grep header including the one without Expected" "DECLARED${TAB}5" "$EXTRACTED"
assert_eq "test-suite and ASCII stops are not grep assertions" "0" "$(printf '%s\n' "$EXTRACTED" | grep -c 'bun test\|LC_ALL' || true)"
assert_eq "header without Expected: emits no assertion line" "0" "$(printf '%s\n' "$EXTRACTED" | grep -c 'gamma' || true)"
assert_eq "no grep stops -> only DECLARED 0" "DECLARED${TAB}0" "$(printf 'Stop 2 (test suite):\n  bun test\n  Expected: ok\n' | rsg_extract)"
assert_contains "'at most' becomes le" "${TAB}le${TAB}3" "$(printf 'Stop 1 (grep assertion):\n  grep -c a b\n  Expected: at most 3\n' | rsg_extract)"
assert_contains "backslash continuation joins the command" "grep -rn \"a\" src | wc -l${TAB}eq${TAB}4" "$(printf 'Stop 1 (grep assertion):\n  grep -rn "a" src \\\n    | wc -l\n  Expected: 4\n' | rsg_extract)"

echo "--- rsg_allow_cmd ---"
for c in 'grep -c "alpha" fixture.txt' 'grep -rn "x" src | wc -l' 'LC_ALL=C grep -n "[^ -~]" src/a.ts' 'find src -name "*.ts" | wc -l' 'test -f src/a.ts'; do
  if rsg_allow_cmd "$c"; then PASS=$((PASS+1)); echo "PASS: allowed: $c"; else FAIL=$((FAIL+1)); echo "FAIL: allowed expected: $c"; fi
done
for c in 'grep -c a b; rm -rf /' 'grep a b | awk "{print}"' 'grep a b > out' 'cat $(ls)' 'find . -delete' 'sed -n 1p a' 'FOO=1 grep a b'; do
  if rsg_allow_cmd "$c"; then FAIL=$((FAIL+1)); echo "FAIL: forbidden expected: $c"; else PASS=$((PASS+1)); echo "PASS: forbidden: $c"; fi
done

echo "--- rsg_observe / rsg_compare ---"
cd "$TMP"
assert_eq "grep -c prints an integer" "2" "$(rsg_observe 'grep -c "alpha" fixture.txt')"
assert_eq "grep -n line output is counted" "2" "$(rsg_observe 'grep -n "beta" fixture.txt')"
assert_eq "clean no-match is 0" "0" "$(rsg_observe 'grep -n "delta" fixture.txt')"
assert_eq "missing path is ERR" "ERR" "$(rsg_observe 'grep -n "x" no-such-file.txt')"
if rsg_compare ge 1 2; then PASS=$((PASS+1)); echo "PASS: ge holds"; else FAIL=$((FAIL+1)); echo "FAIL: ge holds"; fi
if rsg_compare eq 2 3; then FAIL=$((FAIL+1)); echo "FAIL: eq mismatch detected"; else PASS=$((PASS+1)); echo "PASS: eq mismatch detected"; fi
if rsg_compare le 3 3; then PASS=$((PASS+1)); echo "PASS: le holds"; else FAIL=$((FAIL+1)); echo "FAIL: le holds"; fi

echo "--- rsg_run: end to end in the fixture worktree ---"
OUT="$(printf '%s\n' "$SPEC" | rsg_extract | rsg_run)"
assert_contains "GREP_DECLARED=5" "GREP_DECLARED=5" "$OUT"
assert_contains "GREP_EXECUTED=3" "GREP_EXECUTED=3" "$OUT"
assert_contains "GREP_DROPPED=1 (the awk one)" "GREP_DROPPED=1" "$OUT"
assert_contains "GREP_MISMATCH=0" "GREP_MISMATCH=0" "$OUT"
assert_contains "GREP_STATUS=passed" "GREP_STATUS=passed" "$OUT"
assert_contains "GREP_LINE carries observed counts in manifest v2 form" 'GREP_LINE=grep -c "alpha" fixture.txt => 2; grep -c "beta" fixture.txt => 2; grep -n "delta" fixture.txt => 0' "$OUT"
assert_contains "dropped assertion is named in detail" 'DROPPED (not on read-only allowlist; not executed): grep -rciE "password" src 2>/dev/null | awk' "$OUT"

printf 'alpha\n' > "$TMP/fixture.txt"
OUT="$(printf '%s\n' "$SPEC" | rsg_extract | rsg_run)"
assert_contains "mismatch detected when the file changes (alpha eq 2 and beta ge 1 both fail)" "GREP_MISMATCH=2" "$OUT"
assert_contains "GREP_STATUS=mismatch" "GREP_STATUS=mismatch" "$OUT"
assert_contains "MISMATCH detail names expected and observed" 'MISMATCH: grep -c "alpha" fixture.txt => 1 (expected eq 2)' "$OUT"
assert_contains "GREP_LINE still carries the OBSERVED (not expected) count" 'grep -c "alpha" fixture.txt => 1;' "$OUT"

OUT="$(printf 'Stop 2 (test suite):\n  bun test\n  Expected: ok\n' | rsg_extract | rsg_run)"
assert_contains "none declared -> none_declared" "GREP_STATUS=none_declared" "$OUT"
assert_contains "none declared -> N/A line" "GREP_LINE=N/A (spec declares no grep stop conditions)" "$OUT"

OUT="$(printf 'Stop 1 (grep assertion):\n  grep a b | awk "{print}"\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "all dropped -> all_dropped" "GREP_STATUS=all_dropped" "$OUT"
assert_contains "all dropped -> N/A line names the count" "GREP_LINE=N/A (1 declared grep stop condition(s) but none executable under the read-only allowlist)" "$OUT"

OUT="$(printf 'Stop 1 (grep assertion):\n  LC_ALL=C grep -c "alpha" fixture.txt\n  Expected: 1\n' | rsg_extract | rsg_run)"
assert_contains "LC_ALL prefix passes the gate and executes" "GREP_EXECUTED=1" "$OUT"
assert_contains "LC_ALL prefixed command kept verbatim in GREP_LINE" 'GREP_LINE=LC_ALL=C grep -c "alpha" fixture.txt => 1' "$OUT"

cd "$HERE"
rm -rf "$TMP"

echo "--- rsg_extract: bullet-style Stop conditions section (real shape on bdc-xo main) ---"
SPEC_GCD='# WO-SHOPOPS-GCD-METADATA-TO-LISTING-01

WO Class: CODE

## 9. Stop conditions (CI-executable)

- `node tests/test_cover_resolver.js` exits 0 if that suite exists.
- `grep -c "gcd" shopops-api/routes/store.js` returns 1 or greater.
- `grep -c "skip_gcd_enrichment" shopops-api/services/coverResolver.js` returns
  2 or greater (the guard survives the move).
- `LC_ALL=C grep -n "[^ -~]" shopops-api/routes/store.js` returns nothing.
- `rg -c "gcd" shopops-api/routes/store.js` => 3
- `grep -c "x" y.js` (no expectation on this line)

## 10. Manifest requirements

- `grep -c "not in a stop section" z.js` returns 1
'
OUT="$(printf '%s\n' "$SPEC_GCD" | rsg_extract)"
assert_contains "'returns 1 or greater' -> ge 1" "grep -c \"gcd\" shopops-api/routes/store.js${TAB}ge${TAB}1" "$OUT"
assert_eq "wrapped expectation (number on the next line) is not emitted" "0" "$(printf '%s\n' "$OUT" | grep -c 'skip_gcd_enrichment' || true)"
assert_contains "'returns nothing' -> eq 0 with LC_ALL prefix kept" "LC_ALL=C grep -n \"[^ -~]\" shopops-api/routes/store.js${TAB}eq${TAB}0" "$OUT"
assert_contains "'=> 3' -> eq 3 (rg)" "rg -c \"gcd\" shopops-api/routes/store.js${TAB}eq${TAB}3" "$OUT"
assert_eq "no-expectation bullet not emitted" "0" "$(printf '%s\n' "$OUT" | grep -c '"x" y.js' || true)"
assert_eq "bullets outside a Stop conditions section ignored" "0" "$(printf '%s\n' "$OUT" | grep -c 'not in a stop section' || true)"
assert_eq "runner commands are not grep assertions" "0" "$(printf '%s\n' "$OUT" | grep -c 'node tests' || true)"
assert_contains "DECLARED counts every backticked read-only command in the section (5), not the runner" "DECLARED${TAB}5" "$OUT"

echo "--- baseline statements are not stop conditions (live false mismatch, run 3b8aea39, WO-HARNESS-AUTO-REREVIEW-REPEAT-REASON-01) ---"
SPEC_BASELINE='# WO-HARNESS-AUTO-REREVIEW-REPEAT-REASON-01

WO Class: CODE

## Stop conditions
Baseline on untouched tree: scenario 1 FAILS (enqueue blocked with
`repeat_reason_required`) -- the test must demonstrate the live defect before
the fix. `grep -rn "buildRereviewReason"` returns nothing.
1. Given PR head, greps show the reason builder and its call site, before/after
   counts in the PR body.
2. Test command exits 0 with scenarios 1-8 asserting values.
3. `grep -c "buildRereviewReason" packages/overseer/src/pr-review-ingest.ts` returns 1 or greater.

## Manifest requirements
Manifest v2: greps (stop 1), tests (stop 2).
'
OUT="$(printf '%s\n' "$SPEC_BASELINE" | rsg_extract)"
assert_eq "the baseline paragraph grep is skipped" "0" "$(printf '%s\n' "$OUT" | grep -c 'grep -rn "buildRereviewReason"' || true)"
assert_contains "the numbered post-fix assertion is kept (ge 1)" "grep -c \"buildRereviewReason\" packages/overseer/src/pr-review-ingest.ts${TAB}ge${TAB}1" "$OUT"
assert_contains "DECLARED counts only the real stop condition" "DECLARED${TAB}1" "$OUT"
OUT="$(printf '## Stop conditions\n- Baseline: `grep -c x y` returns 0 before this WO.\n- `grep -c x y` returns 2 or greater\n' | rsg_extract)"
assert_contains "single-line baseline bullet skipped, real bullet kept" "grep -c x y${TAB}ge${TAB}2" "$OUT"
assert_contains "single-line baseline bullet not counted" "DECLARED${TAB}1" "$OUT"

echo "--- rsg_run on bullet-style spec in a fixture worktree ---"
TMP2="$(mktemp -d)"
mkdir -p "$TMP2/shopops-api/routes" "$TMP2/shopops-api/services"
printf 'gcd\ngcd\ngcd\n' > "$TMP2/shopops-api/routes/store.js"
printf 'skip_gcd_enrichment\nskip_gcd_enrichment\n' > "$TMP2/shopops-api/services/coverResolver.js"
( cd "$TMP2" && OUT="$(printf '%s\n' "$SPEC_GCD" | rsg_extract | rsg_run)" && assert_contains "ge 1 holds with observed 3" 'OK: grep -c "gcd" shopops-api/routes/store.js => 3 (expected ge 1)' "$OUT" && assert_contains "ASCII absence holds" 'OK: LC_ALL=C grep -n "[^ -~]" shopops-api/routes/store.js => 0 (expected eq 0)' "$OUT" && assert_contains "GREP_STATUS=passed" "GREP_STATUS=passed" "$OUT" )
rm -rf "$TMP2"

echo
echo "run-stop-greps.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
