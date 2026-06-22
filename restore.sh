#!/usr/bin/env bash
#
# restore.sh — Recover Claude Code config from editable data files:
#   config/mcp-servers.txt   -> MCP servers
#   config/marketplaces.txt  -> plugin marketplaces
#   config/plugins.txt       -> plugins to install + enable
#   config/settings.portable.json -> merged into ~/.claude/settings.json
#
# Add a server/marketplace/plugin by editing the data file — not this script.
# Idempotent. Safe to re-run. No secrets.
# Usage: ./restore.sh [check|mcp|plugins|settings|status|all]

set -euo pipefail

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$REPO_DIR/config"

log()  { printf '\033[1;34m[restore]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

require_claude() { command -v claude >/dev/null 2>&1 || { err "claude CLI not found in PATH"; exit 1; }; }

# Strip comments (#...) and blank lines from a data file.
read_lines() { grep -vE '^[[:space:]]*(#|$)' "$1" 2>/dev/null || true; }

# Trim leading/trailing whitespace.
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

check_prereqs() {
  require_claude
  ok "claude -> $(command -v claude)"
  warn "mcp-proxy expects a local HTTP server on http://127.0.0.1:8081/mcp (start it separately)"
}

# --- MCP servers from config/mcp-servers.txt ---------------------------------
restore_mcp() {
  require_claude
  local f="$CONFIG_DIR/mcp-servers.txt"
  [ -f "$f" ] || { warn "no $f"; return; }
  local name transport target
  while IFS='|' read -r name transport target; do
    name="$(trim "$name")"; transport="$(trim "$transport")"; target="$(trim "$target")"
    [ -n "$name" ] || continue
    if claude mcp get "$name" >/dev/null 2>&1; then ok "$name already present"; continue; fi
    case "$transport" in
      http|sse) claude mcp add -s user -t "$transport" "$name" "$target" && ok "added $name ($transport)" ;;
      stdio)    # shellcheck disable=SC2086  # intentional word-split of command args
                claude mcp add -s user "$name" -- $target && ok "added $name (stdio)" ;;
      *)        warn "unknown transport '$transport' for $name — skipped" ;;
    esac
  done < <(read_lines "$f")
}

# --- Marketplaces + plugins from data files ----------------------------------
restore_plugins() {
  require_claude
  local mf="$CONFIG_DIR/marketplaces.txt" pf="$CONFIG_DIR/plugins.txt" src p
  if [ -f "$mf" ]; then
    while read -r src; do
      src="$(trim "$src")"; [ -n "$src" ] || continue
      claude plugin marketplace add "$src" >/dev/null 2>&1 \
        && ok "marketplace: $src" || warn "marketplace already added or failed: $src"
    done < <(read_lines "$mf")
  else warn "no $mf"; fi
  if [ -f "$pf" ]; then
    while read -r p; do
      p="$(trim "$p")"; [ -n "$p" ] || continue
      claude plugin install "$p" >/dev/null 2>&1 && ok "installed $p" || warn "install skipped/failed: $p"
      claude plugin enable  "$p" >/dev/null 2>&1 && ok "enabled $p"   || true
    done < <(read_lines "$pf")
  else warn "no $pf"; fi
}

# --- Portable settings.json (deep-merged, never clobbers other keys) ---------
restore_settings() {
  local src="$CONFIG_DIR/settings.portable.json" dst="$CLAUDE_HOME/settings.json"
  [ -f "$src" ] || { err "missing $src"; exit 1; }
  mkdir -p "$CLAUDE_HOME"
  [ -f "$dst" ] && cp "$dst" "$dst.bak.$(date +%Y%m%d%H%M%S)" && log "backed up existing settings.json"
  python3 - "$src" "$dst" <<'PY'
import json, sys, os
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f: incoming = json.load(f)
existing = {}
if os.path.exists(dst):
    try:
        with open(dst) as f: existing = json.load(f)
    except Exception: existing = {}
def merge(a, b):
    for k, v in b.items():
        a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a
with open(dst, "w") as f:
    json.dump(merge(existing, incoming), f, indent=2); f.write("\n")
print("merged settings ->", dst)
PY
  ok "settings.json updated"
}

status() {
  require_claude
  log "MCP servers:"; claude mcp list 2>/dev/null || true
  echo
  log "Plugins:";     claude plugin list 2>/dev/null || true
}

main() {
  case "${1:-all}" in
    check)    check_prereqs ;;
    mcp)      restore_mcp ;;
    plugins)  restore_plugins ;;
    settings) restore_settings ;;
    status)   status ;;
    all)      check_prereqs; restore_mcp; restore_plugins; restore_settings; status ;;
    *) err "unknown: $1"; echo "usage: $0 [check|mcp|plugins|settings|status|all]"; exit 1 ;;
  esac
  ok "done: ${1:-all}"
}
main "$@"
