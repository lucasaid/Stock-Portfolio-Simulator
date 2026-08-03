#!/usr/bin/env bash
set -euo pipefail

# Registers your Claude subscription with a local OneCLI instance so the
# backend can call Claude without ever holding a real token (spec §4.1).
#
# OneCLI (https://onecli.sh) is a separate, standalone tool — not part of
# nanoclaw, despite this flow mirroring nanoclaw's register-claude-token.sh
# pattern. Confirmed against the real CLI (`onecli --help`, and a live
# `onecli run --dry-run` capture) rather than assumed:
#
#   0. Install OneCLI if missing: curl -fsSL onecli.sh/cli/install | sh
#   1. Point the CLI at OUR local instance (docker-compose's `onecli` service).
#      Local single-user mode auto-authenticates as admin@localhost — no
#      `onecli auth login` needed, and it auto-provisions one "default" agent.
#   2. claude setup-token  → browser OAuth, captures an sk-ant-oat… token
#   3. onecli secrets create --type anthropic --host-pattern api.anthropic.com
#   4. onecli agents grants attach-secret  → grants the default agent that secret
#
# There is deliberately no "print a gateway URL + token env var" step: the
# real mechanism is that the whole backend process gets launched wrapped as
# `onecli run -- node dist/index.js` (see docker-entrypoint.sh), which sets
# HTTPS_PROXY + a locally-trusted CA in that process's env so its outbound
# HTTPS traffic is transparently proxied and the real token injected on the
# wire. The token never lands in this codebase's env or config files.

SECRET_NAME="${SECRET_NAME:-Anthropic}"
HOST_PATTERN="${HOST_PATTERN:-api.anthropic.com}"
ONECLI_API_HOST="${ONECLI_API_HOST:-http://localhost:10254}"
ONECLI_AGENT="${ONECLI_AGENT:-default}"

command -v onecli >/dev/null || {
  echo "onecli not found. Installing OneCLI (https://onecli.sh)…"
  curl -fsSL onecli.sh/cli/install | sh
  command -v onecli >/dev/null || {
    echo "OneCLI install did not put 'onecli' on PATH. Open a new shell (or re-source your profile) and re-run this script." >&2
    exit 1
  }
}
command -v claude >/dev/null || {
  echo "Claude Code CLI not found. Install it first: curl -fsSL https://claude.ai/install.sh | bash" >&2
  exit 1
}
command -v script >/dev/null || { echo "script(1) is required for PTY capture." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required to parse onecli's JSON output. Install it first (e.g. brew install jq / apt install jq)." >&2; exit 1; }

echo "Pointing onecli at ${ONECLI_API_HOST} (start it first with: docker compose up -d onecli-postgres onecli)"
onecli config set api-host "$ONECLI_API_HOST" >/dev/null

onecli auth status >/dev/null 2>&1 || {
  echo "Could not reach/authenticate against onecli at ${ONECLI_API_HOST}." >&2
  echo "Is the local instance running? Try: docker compose up -d onecli-postgres onecli" >&2
  exit 1
}

agent_id=$(onecli agents list 2>/dev/null | jq -r --arg id "$ONECLI_AGENT" \
  '.data[] | select(.identifier == $id or .isDefault == true) | .id' | head -1)
if [ -z "$agent_id" ] || [ "$agent_id" = "null" ]; then
  echo "Could not find a OneCLI agent matching '${ONECLI_AGENT}' (or a default agent)." >&2
  exit 1
fi
echo "Using agent: ${ONECLI_AGENT} (${agent_id})"

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

echo "A browser window will open to sign in with your Claude account."
read -r -p "Press Enter to run 'claude setup-token' (Ctrl-C to abort)… " _ </dev/tty

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "claude setup-token" "$tmpfile"
else
  script -q "$tmpfile" claude setup-token
fi

token=$(tr -d '\r' <"$tmpfile" | grep -oE 'sk-ant-oat[A-Za-z0-9_-]+AA' | tail -1 || true)
if [ -z "$token" ]; then
  echo "No sk-ant-oat… token found in the capture. Raw log kept at: $tmpfile" >&2
  trap - EXIT
  exit 1
fi

echo "Got token: ${token:0:16}…${token: -4}"

secret_id=$(onecli secrets create --name "$SECRET_NAME" --type anthropic --value "$token" --host-pattern "$HOST_PATTERN" | jq -r '.id')
if [ -z "$secret_id" ] || [ "$secret_id" = "null" ]; then
  echo "onecli secrets create did not return an id — see output above." >&2
  exit 1
fi

onecli agents grants attach-secret --id "$agent_id" --secret-id "$secret_id" >/dev/null

echo
echo "Done. The '${ONECLI_AGENT}' agent can now use this Anthropic credential."
echo "Nothing further to configure by hand: launch the backend wrapped as"
echo "  onecli run --agent ${ONECLI_AGENT} -- node dist/index.js"
echo "(docker-compose does this automatically via docker-entrypoint.sh)."
