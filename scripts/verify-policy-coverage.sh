#!/usr/bin/env bash
#
# verify-policy-coverage.sh — WO-HARNESS-POLICYFILE-NOT-ENFORCED-01 Test 1.
#
# Audits whether every registered Cauldron codebase resolves the canonical
# Universal Agent Behavior Policy declared by workflow YAMLs as:
#   policyFile: harness/policies/agent-behavior.md
#
# Resolution rules (must match executor.ts applyWorkflowPolicyFile):
#   1. Local copy at <repo>/harness/policies/agent-behavior.md (preferred)
#   2. Bundled canonical via this repo's BUNDLED_POLICIES (Approach B)
#
# A repo reports:
#   RESOLVED via local   — file exists at the canonical path on `main`
#   RESOLVED via bundled — local file absent; fallback resolves from this repo
#   UNRESOLVED — neither source resolves (FAIL)
#
# Exits 0 if every repo is RESOLVED. Exits 1 otherwise.
#
# Requires `gh` CLI authenticated for the bluedevilcollectibles org.

set -euo pipefail

CANONICAL_PATH="harness/policies/agent-behavior.md"
HARNESS_REPO_LOCAL_FILE="harness/policies/agent-behavior.md"

# Repos registered for the Devil's Cauldron build queue, per
# bdc-xo:docs/operations/devils-cauldron/README.md.
REPOS=(
  "bluedevilcollectibles/bdc-xo"
  "bluedevilcollectibles/bdc-harness"
  "bluedevilcollectibles/shopops"
  "bluedevilcollectibles/shopops-storefront"
  "bluedevilcollectibles/lspro-react"
  "bluedevilcollectibles/model-tier-advisor"
  "bluedevilcollectibles/scout-service"
)

# Determine whether the bundled fallback is available in THIS repo's checkout.
# The fallback is "available" if the canonical file exists in this worktree at
# the same path that the generator (scripts/generate-bundled-defaults.ts) reads.
# This is a structural proxy for "BUNDLED_POLICIES[harness/policies/agent-behavior.md]
# is populated" — we don't import TypeScript modules from bash.
BUNDLED_AVAILABLE="no"
if [ -s "$HARNESS_REPO_LOCAL_FILE" ]; then
  BUNDLED_AVAILABLE="yes"
fi

echo "Policy coverage audit — WO-HARNESS-POLICYFILE-NOT-ENFORCED-01"
echo "Canonical path: $CANONICAL_PATH"
echo "Bundled fallback available in bdc-harness checkout: $BUNDLED_AVAILABLE"
echo ""

FAILED=0
declare -a SUMMARY=()

for repo in "${REPOS[@]}"; do
  # Check whether the file exists on `main` via the GitHub Contents API.
  # `gh api` exits non-zero on 404 — capture and treat as "absent".
  if gh api "repos/$repo/contents/$CANONICAL_PATH?ref=main" >/dev/null 2>&1; then
    SOURCE="local"
    STATUS="RESOLVED"
  elif [ "$BUNDLED_AVAILABLE" = "yes" ]; then
    SOURCE="bundled"
    STATUS="RESOLVED"
  else
    SOURCE="none"
    STATUS="UNRESOLVED"
    FAILED=1
  fi

  case "$STATUS" in
    RESOLVED)
      printf "  %-48s %s via %s\n" "$repo:" "$STATUS" "$SOURCE"
      SUMMARY+=("$repo: RESOLVED via $SOURCE")
      ;;
    *)
      printf "  %-48s %s (FAIL)\n" "$repo:" "$STATUS"
      SUMMARY+=("$repo: UNRESOLVED — FAIL")
      ;;
  esac
done

echo ""
echo "Summary (for completion manifest):"
for line in "${SUMMARY[@]}"; do
  echo "  $line"
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "FAIL: one or more repos have no resolvable policy source."
  exit 1
fi

echo ""
echo "PASS: all repos resolved."
exit 0
