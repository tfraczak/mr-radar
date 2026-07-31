#!/usr/bin/env bash
# One-and-done installer for MR Radar: installs missing prerequisites
# (Homebrew, nvm + Node, glab), builds, and registers the menu bar app under
# launchd (starts at login, restarts on crash).
#
#   ./install.sh
#
# Safe to re-run any time — it only installs what's missing, then rebuilds and
# restarts the installed agent.
set -euo pipefail
cd "$(dirname "$0")"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

interactive() { [ -t 0 ]; }

confirm() {
  interactive || return 1
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

# --- Homebrew (needed for glab, and optionally rwx) ---------------------------
ensure_brew() {
  if command -v brew >/dev/null 2>&1; then return 0; fi
  # Homebrew may be installed but not on PATH in this shell.
  for prefix in /opt/homebrew /usr/local; do
    if [ -x "$prefix/bin/brew" ]; then
      eval "$("$prefix/bin/brew" shellenv)"
      return 0
    fi
  done
  warn "Homebrew is not installed — needed to install glab."
  if confirm "Install Homebrew now? (runs the official installer; asks for your password)"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    for prefix in /opt/homebrew /usr/local; do
      [ -x "$prefix/bin/brew" ] && eval "$("$prefix/bin/brew" shellenv)"
    done
    command -v brew >/dev/null 2>&1 || fail "Homebrew install did not complete"
  else
    fail "Install Homebrew from https://brew.sh and re-run ./install.sh"
  fi
}

# --- Node >= 22.5, via nvm (respects .nvmrc) ----------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 && node -e '
    const [maj, min] = process.versions.node.split(".").map(Number);
    process.exit(maj > 22 || (maj === 22 && min >= 5) ? 0 : 1);' 2>/dev/null
}

source_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm.sh does not survive strict mode; relax while sourcing.
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +eu; . "$NVM_DIR/nvm.sh"; set -eu
    return 0
  fi
  if command -v brew >/dev/null 2>&1 && [ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]; then
    set +eu; . "$(brew --prefix nvm)/nvm.sh"; set -eu
    return 0
  fi
  return 1
}

ensure_node() {
  if node_ok; then
    note "node $(node -v)"
    return 0
  fi
  if ! source_nvm; then
    warn "Node >= 22.5 not found — installing nvm (the official installer)."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    source_nvm || fail "nvm installed but could not be loaded — open a new terminal and re-run ./install.sh"
  fi
  note "installing Node $(cat .nvmrc 2>/dev/null || echo '(latest LTS)') via nvm…"
  set +eu; nvm install >/dev/null; nvm use >/dev/null; set -eu
  node_ok || fail "Node install did not produce a usable node >= 22.5"
  note "node $(node -v)"
}

# --- glab (GitLab CLI — the app's only GitLab access path) --------------------
ensure_glab() {
  if ! command -v glab >/dev/null 2>&1; then
    ensure_brew
    note "installing glab…"
    brew install glab
  fi
  if glab auth status >/dev/null 2>&1; then
    note "glab authenticated"
  elif interactive; then
    warn "glab is not authenticated yet — starting 'glab auth login' (interactive):"
    glab auth login || warn "glab auth login did not complete — run it yourself before using the app"
  else
    warn "glab is not authenticated — run: glab auth login"
  fi
}

# --- rwx (optional — only for repos that gate specs on RWX) -------------------
offer_rwx() {
  if command -v rwx >/dev/null 2>&1; then
    note "rwx $(rwx --version 2>/dev/null | head -1)"
    return 0
  fi
  if confirm "Install the rwx CLI? (only needed if some repos run their specs on RWX)"; then
    ensure_brew
    brew install rwx-cloud/tap/rwx
    warn "remember to run: rwx login"
  else
    note "skipping rwx — the app runs GitLab-pipelines-only without it"
  fi
}

step "Checking prerequisites (installing what's missing)"
ensure_node
ensure_glab
offer_rwx

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
