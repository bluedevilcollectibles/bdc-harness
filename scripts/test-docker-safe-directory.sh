#!/usr/bin/env bash
# Smoke test: verify git safe.directory wildcard baked into image for both root and appuser.
# Usage: ./scripts/test-docker-safe-directory.sh [image-tag]
set -euo pipefail

IMAGE="${1:-bdc-harness:latest}"
PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if echo "${result}" | grep -qxF '*'; then
    echo "PASS [${label}]: safe.directory '*' present"
    PASS=$((PASS + 1))
  else
    echo "FAIL [${label}]: safe.directory '*' NOT found. Got: ${result}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Image: ${IMAGE}"

ROOT_RESULT=$(docker run --rm "${IMAGE}" git config --global --get-all safe.directory 2>&1 || true)
check "root" "${ROOT_RESULT}"

APPUSER_RESULT=$(docker run --rm "${IMAGE}" gosu appuser git config --global --get-all safe.directory 2>&1 || true)
check "appuser" "${APPUSER_RESULT}"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
