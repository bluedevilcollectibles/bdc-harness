# M-131 Phase A seat image (WO-HARNESS-M131-PHASE-A-GROK-SEAT-PROOF-01).
#
# One reusable, non-root dispatch-worker image; per-seat identity, provider
# restriction, and mounts come from the compose service, so the same image
# serves future seats without rebuild-per-provider drift.
#
# This file is source packaging only. Building it on a live host, mounting a
# real credential, and starting a container are separately gated actions and
# never part of a source PR.
FROM oven/bun:1.3-slim

# Build-SHA visibility: the image carries the exact source SHA it was built
# from, surfaced to preflight/health via SEAT_BUILD_SHA.
#
# NO DEFAULT ON PURPOSE (review finding 2026-08-17). A default of "unknown"
# let a seat pass preflight and advertise an identity it did not have. The
# build now fails if BUILD_SHA is not supplied, and seat-preflight
# additionally rejects placeholder values at runtime.
ARG BUILD_SHA
ENV SEAT_BUILD_SHA=${BUILD_SHA}
RUN test -n "${BUILD_SHA}" || (echo "BUILD_SHA build-arg is required (pass --build-arg BUILD_SHA=<sha>)" >&2; exit 1)

# Non-root seat user with a real home for the seat-private vendor profile.
RUN groupadd --gid 10001 seat \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/seat seat \
  && mkdir -p /app /var/lib/bdc-seat /run/m131/secret-ingress \
  && chown -R seat:seat /app /var/lib/bdc-seat /home/seat

WORKDIR /app

# Provider CLI, pinned. Installed BEFORE the source copy so the expensive
# download is not invalidated by every worker-source edit.
#
# WHY 1.0.13 AND NOT WHAT IS RUNNING TODAY (decided 2026-09-08):
#   archon-app-1 carries a hand-placed 162MB ELF at /usr/local/bin/grok
#   (grok 0.2.101, mtime Jul 16) that no script in this repo installs. It has
#   no reproducible provenance, so it is not a pin candidate -- reproducing it
#   would mean copying a mystery binary forward. 1.0.13 is the current stable
#   published by the vendor installer, and is the exact build already proven
#   on the operator desktop. `grok agent stdio` -- the only surface the
#   grok-acp adapter invokes -- is present in 1.0.13, verified against the
#   1.0.13 CLI before pinning, so the 0.2.x -> 1.0.x jump does not move it.
#
# The version is an ARG so a rebuild can move the pin deliberately; it is
# never "latest" implicitly.
#
# NO CREDENTIAL IS INVOLVED. The artifact is fetched anonymously (verified
# HTTP 200 without auth). The vendor installer would additionally read
# ~/.grok/auth.json and write a proxy auth header, so it is deliberately NOT
# piped to a shell here -- we fetch the pinned artifact directly instead.
# Credentials reach the seat only at run time, by bind mount / env.
ARG GROK_VERSION=1.0.13
RUN set -eux;     apt-get update;     apt-get install -y --no-install-recommends ca-certificates curl;     rm -rf /var/lib/apt/lists/*;     arch="$(dpkg --print-architecture)";     case "$arch" in       amd64) grok_arch='x86_64' ;;       arm64) grok_arch='aarch64' ;;       *) echo "unsupported architecture for grok CLI: $arch" >&2; exit 1 ;;     esac;     curl -fsSL --retry 3 --retry-delay 2       -o /tmp/grok.gz       "https://x.ai/cli/grok-${GROK_VERSION}-linux-${grok_arch}.gz";     gzip -dc /tmp/grok.gz > /usr/local/bin/grok;     rm -f /tmp/grok.gz;     chmod 0755 /usr/local/bin/grok;     # Fail the build now if the pin did not land: a seat that starts without a
    # working provider CLI fails closed at seat_provider_command_unavailable,
    # which is a much more expensive place to discover this.
    installed="$(/usr/local/bin/grok --version)";     echo "$installed" | grep -q "${GROK_VERSION}"       || { echo "grok pin mismatch: wanted ${GROK_VERSION}, got ${installed}" >&2; exit 1; };     /usr/local/bin/grok agent stdio --help >/dev/null

# Worker source + the minimal dependency set it imports at runtime.
#
# ALL workspace package.json files must be copied before `bun install`: the
# root package.json declares "workspaces": ["packages/*"] and the monorepo
# lockfile depends on every one of them. Copying only the root pair makes
# `--frozen-lockfile` fail, so the image never built from a clean clone
# (bdc-xo#1813). Same explicit-COPY pattern as the root Dockerfile.
COPY --chown=seat:seat package.json bun.lock ./
COPY --chown=seat:seat packages/adapters/package.json ./packages/adapters/
COPY --chown=seat:seat packages/canary-suite/package.json ./packages/canary-suite/
COPY --chown=seat:seat packages/cli/package.json ./packages/cli/
COPY --chown=seat:seat packages/core/package.json ./packages/core/
COPY --chown=seat:seat packages/docs-web/package.json ./packages/docs-web/
COPY --chown=seat:seat packages/fusion/package.json ./packages/fusion/
COPY --chown=seat:seat packages/git/package.json ./packages/git/
COPY --chown=seat:seat packages/isolation/package.json ./packages/isolation/
COPY --chown=seat:seat packages/overseer/package.json ./packages/overseer/
COPY --chown=seat:seat packages/paths/package.json ./packages/paths/
COPY --chown=seat:seat packages/persona-context-loader/package.json ./packages/persona-context-loader/
COPY --chown=seat:seat packages/providers/package.json ./packages/providers/
COPY --chown=seat:seat packages/security-watchdog/package.json ./packages/security-watchdog/
COPY --chown=seat:seat packages/server/package.json ./packages/server/
COPY --chown=seat:seat packages/smart-cauldron/package.json ./packages/smart-cauldron/
COPY --chown=seat:seat packages/web/package.json ./packages/web/
COPY --chown=seat:seat packages/workflows/package.json ./packages/workflows/
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted
COPY --chown=seat:seat scripts/dispatch-worker ./scripts/dispatch-worker

USER seat

# Health = the same deterministic preflight that gates advertisement.
# Sanitized output only (typed code + field); never paths or credentials.
HEALTHCHECK --interval=60s --timeout=15s --retries=3 CMD \
  bun run scripts/dispatch-worker/seat-preflight.ts --config /app/config/seat.json || exit 1

CMD ["bun", "run", "scripts/dispatch-worker/index.ts", "--config", "/app/config/seat.json"]
