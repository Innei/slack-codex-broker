#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[tailscale-bootstrap] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_command brew

HOSTNAME_OVERRIDE="${TAILSCALE_HOSTNAME:-}"
AUTH_KEY="${TAILSCALE_AUTHKEY:-}"
SERVE_PORT="${TAILSCALE_SERVE_PORT:-3000}"
ENABLE_SSH="${TAILSCALE_ENABLE_SSH:-1}"

BREW_PREFIX="$(brew --prefix)"
TAILSCALE_BIN="${BREW_PREFIX}/opt/tailscale/bin/tailscale"
TAILSCALED_BIN="${BREW_PREFIX}/opt/tailscale/bin/tailscaled"

log "Installing Homebrew tailscale formula"
brew install tailscale

log "Starting tailscaled via brew services"
brew services restart tailscale

if [[ ! -x "${TAILSCALE_BIN}" ]]; then
  printf 'tailscale binary not found at %s\n' "${TAILSCALE_BIN}" >&2
  exit 1
fi

if [[ ! -x "${TAILSCALED_BIN}" ]]; then
  printf 'tailscaled binary not found at %s\n' "${TAILSCALED_BIN}" >&2
  exit 1
fi

log "tailscale version"
"${TAILSCALE_BIN}" version
log "tailscaled binary"
ls -l "${TAILSCALED_BIN}"

UP_ARGS=(up)
if [[ "${ENABLE_SSH}" != "0" ]]; then
  UP_ARGS+=(--ssh)
fi
if [[ -n "${HOSTNAME_OVERRIDE}" ]]; then
  UP_ARGS+=(--hostname="${HOSTNAME_OVERRIDE}")
fi
if [[ -n "${AUTH_KEY}" ]]; then
  UP_ARGS+=(--auth-key="${AUTH_KEY}")
fi

log "Bringing node online in tailnet"
"${TAILSCALE_BIN}" "${UP_ARGS[@]}"

if [[ -n "${SERVE_PORT}" && "${SERVE_PORT}" != "0" ]]; then
  log "Publishing port ${SERVE_PORT} through tailscale serve"
  "${TAILSCALE_BIN}" serve --bg "${SERVE_PORT}"
fi

log "tailscale status"
"${TAILSCALE_BIN}" status

log "tailscale IPv4"
"${TAILSCALE_BIN}" ip -4

log "tailscale IPv6"
"${TAILSCALE_BIN}" ip -6

if [[ -n "${SERVE_PORT}" && "${SERVE_PORT}" != "0" ]]; then
  log "tailscale serve status"
  "${TAILSCALE_BIN}" serve status
fi
