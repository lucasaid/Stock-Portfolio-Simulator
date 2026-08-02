#!/usr/bin/env bash
# First-run setup: Claude auth, build and start the stack, create the dashboard login.
set -euo pipefail

cd "$(dirname "$0")/.."

AUTH_SCRIPT=backend/scripts/setup-claude-auth.sh

echo "==> 1/3  Claude subscription auth (OneCLI gateway)"
if [ -x "$AUTH_SCRIPT" ]; then
  "$AUTH_SCRIPT"
else
  echo "$AUTH_SCRIPT missing — skipping"
fi

echo
echo "==> 2/3  Build and start the stack"
docker compose up -d --build

echo
echo "==> 3/3  Create the dashboard login"
echo "The CLI prompts for a password (minimum 8 characters, echoed to the terminal)."
read -r -p "Username (blank to skip): " USERNAME
if [ -n "$USERNAME" ]; then
  # Attached to a TTY on purpose: cli.ts reads the password from stdin via readline.
  # If the user already exists this fails on the UNIQUE constraint, which is a safe
  # no-op — the existing login still works.
  docker compose exec backend node dist/cli.js create-user "$USERNAME" \
    || echo "could not create '$USERNAME' (it may already exist) — continuing"
fi

echo
echo "Dashboard: http://localhost:8088"
