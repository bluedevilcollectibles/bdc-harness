#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash scripts/taskmaster/reset.sh --confirm --reason "operator reason" [--actor "operator"]
# Obtain the token on the host with:
#   docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN

confirm=false
reason=""
actor="operator"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm) confirm=true; shift ;;
    --reason) reason="${2:?--reason requires a value}"; shift 2 ;;
    --actor) actor="${2:?--actor requires a value}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$confirm" != true ]; then
  echo "[dry-run] Would reset Taskmaster via POST http://localhost:3090/api/taskmaster/resume"
  echo "[dry-run] actor=$actor reason=${reason:-unspecified}"
  echo "Re-run with --confirm to mutate state."
  exit 0
fi

if [ -z "$reason" ]; then
  echo "--reason is required with --confirm" >&2
  exit 2
fi
if [ -z "${ARCHON_OPERATOR_TOKEN:-}" ]; then
  echo "ARCHON_OPERATOR_TOKEN is required with --confirm" >&2
  exit 2
fi

json_escape() {
  # Bash arguments cannot contain NUL. Escape every other JSON control byte,
  # including final newlines, before command substitution can trim them.
  local LC_ALL=C value="$1" char code i
  for ((i = 0; i < ${#value}; i++)); do
    char="${value:i:1}"
    case "$char" in
      '"') printf '\\"' ;;
      '\') printf '\\\\' ;;
      *)
        printf -v code '%d' "'$char"
        if ((code < 32)); then
          printf '\\u%04x' "$code"
        else
          printf '%s' "$char"
        fi
        ;;
    esac
  done
}

curl --fail-with-body --silent --show-error \
  -X POST http://localhost:3090/api/taskmaster/resume \
  -H "content-type: application/json" \
  -H "x-archon-operator-token: ${ARCHON_OPERATOR_TOKEN}" \
  --data "{\"actor\":\"$(json_escape "$actor")\",\"reason\":\"$(json_escape "$reason")\"}"
printf '\n'
