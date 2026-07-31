#!/usr/bin/env bash
# One-and-done installer for MR Radar: verifies prerequisites, builds, and
# installs the menu bar app under launchd (starts at login, restarts on crash).
#
#   ./install.sh
#
# Safe to re-run any time — it rebuilds and restarts the installed agent.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

step "Checking prerequisites"

command -v node >/dev/null 2>&1 \
  || fail "node not found — install Node >= 22.5 (e.g. 'brew install nvm', then 'nvm install' in this directory)"
node -e 'const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 22 || (maj === 22 && min < 5)) process.exit(1);' \
  || fail "Node $(node -v) is too old — MR Radar needs >= 22.5 (node:sqlite)"
echo "  node $(node -v)"

command -v glab >/dev/null 2>&1 \
  || fail "glab not found — 'brew install glab', then 'glab auth login'"
if glab auth status >/dev/null 2>&1; then
  echo "  glab authenticated"
else
  warn "glab is installed but not authenticated — run: glab auth login"
fi

if command -v rwx >/dev/null 2>&1; then
  echo "  rwx $(rwx --version 2>/dev/null | head -1)"
else
  echo "  rwx not found — fine unless your repos gate specs on RWX"
fi

step "Installing dependencies"
corepack enable >/dev/null 2>&1 || warn "corepack enable failed — trying yarn anyway"
yarn install

step "Building"
yarn build

step "Installing the menu bar app under launchd"
node scripts/install-tray.mjs

step "Done"
cat <<'NEXT'
Look for the radar icon in your menu bar, then open Settings from its menu:

  1. Jira tab    — set your Atlassian URL + email, Save, then paste an API
                   token into the popover's Connect field
                   (create one: https://id.atlassian.com/manage-profile/security/api-tokens)
  2. General tab — set a local checkout path for any repo whose specs run
                   on RWX with a manual start (enables the Start run button)

Useful commands:
  yarn tray:logs        follow the app's log
  yarn tray:restart     restart after a rebuild
  yarn tray:uninstall   stop and remove the agent
NEXT
