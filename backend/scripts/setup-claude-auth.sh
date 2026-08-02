#!/usr/bin/env bash
set -euo pipefail

# Registers your Claude subscription with the local OneCLI gateway so the
# backend can call Claude without ever holding a real token (spec §4.1).
#
# Flow (mirrors nanoclaw's register-claude-token.sh):
#   1. claude setup-token  → browser OAuth, captures an sk-ant-oat… token
#   2. onecli secrets create --type anthropic --host-pattern api.anthropic.com
#   3. Prints the env values the backend needs.

SECRET_NAME="${SECRET_NAME:-Anthropic}"
HOST_PATTERN="${HOST_PATTERN:-api.anthropic.com}"

command -v onecli >/dev/null || {
  echo "onecli not found. Install the OneCLI gateway first (see https://github.com/nanocoai/nanoclaw setup docs), then re-run." >&2
  exit 1
}
command -v claude >/dev/null || {
  echo "Claude Code CLI not found. Install it first: curl -fsSL https://claude.ai/install.sh | bash" >&2
  exit 1
}
command -v script >/dev/null || { echo "script(1) is required for PTY capture." >&2; exit 1; }

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
onecli secrets create --name "$SECRET_NAME" --type anthropic --value "$token" --host-pattern "$HOST_PATTERN"

gateway=$(onecli config get api-host 2>/dev/null | grep -oE 'https?://[^" ]+' | head -1 || true)
echo
echo "Done. Set these in backend/.env (see .env.example):"
echo "  ANTHROPIC_BASE_URL=${gateway:-<your onecli gateway url>}"
echo "  ANTHROPIC_AUTH_TOKEN=placeholder"
