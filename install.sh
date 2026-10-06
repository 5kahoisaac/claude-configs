#!/usr/bin/env bash
#
# install.sh — restore my global Claude Code config on any machine.
#
#   curl -fsSL https://raw.githubusercontent.com/5kahoisaac/claude-configs/main/install.sh | bash
#   # or, from a checkout:
#   ./install.sh
#
# Installs only what is hand-authored (see claude/):
#   CLAUDE.md, portable settings.json keys, marketplaces + plugins,
#   user-scope MCP servers, and custom mods under claude/skills/.
# Everything plugins generate (ECC skills/agents/hooks, plugin caches) and
# skills managed by `npx skills` is left to those tools.
#
# Idempotent. Anything overwritten is backed up to ~/.claude/backups/.
# Env: CLAUDE_CONFIG_DIR (default ~/.claude), CLAUDE_CONFIGS_REF (default main).

set -euo pipefail

REPO="5kahoisaac/claude-configs"
REF="${CLAUDE_CONFIGS_REF:-main}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BACKUP_DIR="$CLAUDE_DIR/backups/claude-configs-$(date +%Y%m%d%H%M%S)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merr\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve the directory holding claude/: the checkout this script lives in,
# or a fresh tarball download when piped from curl.
resolve_src() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/claude/settings.json" ]; then
    SRC="$here/claude"
    return
  fi
  TMP_SRC="$(mktemp -d)"
  trap 'rm -rf "$TMP_SRC"' EXIT
  log "Downloading $REPO@$REF"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$TMP_SRC" --strip-components=1
  SRC="$TMP_SRC/claude"
  [ -f "$SRC/settings.json" ] || die "download did not contain claude/settings.json"
}

ensure_deps() {
  command -v python3 >/dev/null 2>&1 || die "python3 is required (macOS: xcode-select --install)"
  command -v git >/dev/null 2>&1 || die "git is required to clone plugin marketplaces"
  if ! command -v claude >/dev/null 2>&1; then
    log "Installing Claude Code (native installer)"
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null 2>&1 || die "claude still not on PATH after install"
  fi
  ok "claude $(claude --version </dev/null 2>/dev/null | head -1)"
}

# Copy an existing path into this run's backup dir before replacing it.
backup() {
  [ -e "$1" ] || return 0
  mkdir -p "$BACKUP_DIR"
  cp -R "$1" "$BACKUP_DIR/"
}

install_claude_md() {
  local dst="$CLAUDE_DIR/CLAUDE.md"
  if cmp -s "$SRC/CLAUDE.md" "$dst"; then ok "CLAUDE.md unchanged"; return; fi
  backup "$dst"
  cp "$SRC/CLAUDE.md" "$dst"
  ok "CLAUDE.md installed"
}

# Deep-merge claude/settings.json into settings.json; keys not in the repo
# (e.g. hooks/statusLine written by other tools on this machine) are kept.
install_settings() {
  local dst="$CLAUDE_DIR/settings.json" tmp="$CLAUDE_DIR/settings.json.tmp"
  python3 - "$SRC/settings.json" "$dst" "$tmp" <<'PY'
import json, os, sys
src, dst, out_path = sys.argv[1:4]
incoming = json.load(open(src))
existing = json.load(open(dst)) if os.path.exists(dst) else {}

def merge(base, extra):
    out = dict(base)
    for k, v in extra.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out

with open(out_path, "w") as f:
    json.dump(merge(existing, incoming), f, indent=2)
    f.write("\n")
PY
  if [ -f "$dst" ] && python3 -c 'import json, sys; sys.exit(json.load(open(sys.argv[1])) != json.load(open(sys.argv[2])))' "$dst" "$tmp"; then
    rm -f "$tmp"
    ok "settings.json unchanged"
    return
  fi
  backup "$dst"
  mv "$tmp" "$dst"
  ok "settings.json merged"
}

# Marketplaces and plugins are read from claude/settings.json so it stays
# the single source of truth. Prints "name<TAB>source" per marketplace.
list_marketplaces() {
  python3 - "$SRC/settings.json" <<'PY'
import json, sys
for name, m in json.load(open(sys.argv[1])).get("extraKnownMarketplaces", {}).items():
    s = m["source"]
    print(f'{name}\t{s.get("repo") or s.get("url") or s.get("path")}')
PY
}

list_plugins() {
  python3 - "$SRC/settings.json" <<'PY'
import json, sys
for pid, on in json.load(open(sys.argv[1])).get("enabledPlugins", {}).items():
    if on:
        print(pid)
PY
}

# json_has FILE KEY FIELD — true if KEY is in FILE's FIELD object ("." = root).
json_has() {
  python3 - "$@" <<'PY'
import json, os, sys
path, key, field = sys.argv[1:4]
data = json.load(open(path)) if os.path.exists(path) else {}
obj = data if field == "." else data.get(field, {})
sys.exit(0 if key in obj else 1)
PY
}

install_plugins() {
  local known="$CLAUDE_DIR/plugins/known_marketplaces.json"
  local installed="$CLAUDE_DIR/plugins/installed_plugins.json"
  local name src pid
  while IFS=$'\t' read -r name src; do
    if json_has "$known" "$name" .; then ok "marketplace $name present"; continue; fi
    if claude plugin marketplace add "$src" </dev/null >/dev/null; then
      ok "marketplace $name added"
    else
      warn "marketplace $name failed ($src)"
    fi
  done < <(list_marketplaces)

  while read -r pid; do
    if json_has "$installed" "$pid" plugins; then ok "plugin $pid present"; continue; fi
    if claude plugin install "$pid" --scope user </dev/null >/dev/null; then
      ok "plugin $pid installed"
    else
      warn "plugin $pid failed"
    fi
  done < <(list_plugins)
}

install_mcp() {
  local name cfg
  while IFS=$'\t' read -r name cfg; do
    if claude mcp get "$name" </dev/null >/dev/null 2>&1; then ok "mcp $name present"; continue; fi
    if claude mcp add-json -s user "$name" "$cfg" </dev/null >/dev/null; then
      ok "mcp $name added"
    else
      warn "mcp $name failed"
    fi
  done < <(python3 -c 'import json, sys
for n, c in json.load(open(sys.argv[1])).items(): print(n + "\t" + json.dumps(c))' "$SRC/mcp.json")
}

# Claude plugins cannot ship rules, so copy ECC's rule packs out of the
# marketplace clone the plugin step made. The content stays owned by ECC.
install_ecc_rules() {
  local rules="$CLAUDE_DIR/plugins/marketplaces/ecc/rules"
  [ -d "$rules" ] || { warn "ECC marketplace not found; skipping ECC rules"; return 0; }
  mkdir -p "$CLAUDE_DIR/rules/ecc"
  cp -R "$rules"/. "$CLAUDE_DIR/rules/ecc/"
  ok "ECC rules synced to rules/ecc"
}

# Hand-written mods (skills-dir plugins) under claude/skills/.
install_mods() {
  local dir name dst
  for dir in "$SRC"/skills/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    dst="$CLAUDE_DIR/skills/$name"
    if [ -d "$dst" ] && diff -rq "$dir" "$dst" >/dev/null 2>&1; then ok "mod $name unchanged"; continue; fi
    backup "$dst"
    rm -rf "$dst"
    mkdir -p "$CLAUDE_DIR/skills"
    cp -R "$dir" "$dst"
    ok "mod $name installed"
  done
}

main() {
  resolve_src
  ensure_deps
  mkdir -p "$CLAUDE_DIR"
  log "Installing into $CLAUDE_DIR"
  install_claude_md
  install_settings
  install_plugins
  install_mcp
  install_ecc_rules
  install_mods
  if [ -d "$BACKUP_DIR" ]; then log "Backups: $BACKUP_DIR"; fi
  log "Done. Restart Claude Code to load plugins."
}

main "$@"
