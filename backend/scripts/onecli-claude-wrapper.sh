#!/bin/sh
set -e

# The Agent SDK spawns its own bundled `claude` binary as a child process
# (@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude) rather than making
# raw API calls itself. OneCLI's CLAUDE_CODE_OAUTH_TOKEN injection is keyed off
# the DIRECTLY-wrapped binary's name being literally `claude` — wrapping the
# whole backend Node process does NOT propagate it to this grandchild spawn,
# and `claude` refuses to run at all ("Not logged in") before ever attempting
# a network call, so proxy-only injection cannot substitute for a missing
# token here. Confirmed empirically via `onecli run --dry-run -- <binary>`.
#
# So: this script IS the thing `pathToClaudeCodeExecutable` points the SDK at,
# and it re-execs the real bundled binary through `onecli run --` itself.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKEND_ROOT="$SCRIPT_DIR/.."

CLAUDE_BIN=$(find "$BACKEND_ROOT/node_modules/@anthropic-ai" -maxdepth 2 -type f -name claude -perm -u+x 2>/dev/null | head -1)
if [ -z "$CLAUDE_BIN" ]; then
  echo "onecli-claude-wrapper: could not find the bundled claude binary under $BACKEND_ROOT/node_modules/@anthropic-ai" >&2
  exit 1
fi

onecli config set api-host "${ONECLI_API_HOST:-http://onecli:10254}" >/dev/null 2>&1 || true
exec onecli run --agent "${ONECLI_AGENT:-default}" -- "$CLAUDE_BIN" "$@"
