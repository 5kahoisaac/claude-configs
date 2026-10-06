#!/usr/bin/env python3
"""Read-only drift report: live Claude Code config vs this repo's claude/ dir.

Prints what changed on this machine that may belong in the repo. Never writes.
Usage: python3 -I .claude/skills/sync-claude-config/scripts/drift.py
"""
import difflib
import filecmp
import json
import os
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[4]
TRACKED = REPO / "claude"
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
USER_JSON = CLAUDE_DIR / ".claude.json" if os.environ.get("CLAUDE_CONFIG_DIR") else Path.home() / ".claude.json"
ECC = CLAUDE_DIR / "plugins" / "marketplaces" / "ecc"
SKILL_LOCK = Path.home() / ".agents" / ".skill-lock.json"

# settings.json keys written by other tools, never tracked.
IGNORED_SETTINGS_KEYS = {"hooks": "Orca/RTK", "statusLine": "Orca"}
# modelSettings entries the user chose not to track.
IGNORED_MODEL_PREFIXES = ("cx/",)
# skills/ subdirs that are generated, not hand-written.
GENERATED_SKILL_DIRS = {"synced", "learned"}

# Top-level ~/.claude entries that are tool-generated or runtime state.
GENERATED_TOP_LEVEL = {
    # Claude Code runtime state
    ".DS_Store", ".claude.json", ".credentials.json", ".last-cleanup", ".last-update-result.json",
    ".mcp.json", ".oauth-refresh", "backups", "cache", "daemon", "debug", "dev-mods", "downloads",
    "feedback", "file-history", "history.jsonl", "ide", "jobs", "mcp-health-cache.json",
    "mcp-needs-auth-cache.json", "metrics", "paste-cache", "plans", "plugins", "projects",
    "session-data", "session-env", "sessions", "shell-snapshots", "state", "stats-cache.json",
    "statsig", "telemetry", "todos", "transcripts", "settings.local.json",
    # ECC legacy manual-install copies (plugin provides these)
    ".agents", "AGENTS.md", "PLUGIN_SCHEMA_NOTES.md", "README.md", "hooks", "marketplace.json",
    "mcp-configs", "plugin.json", "rules", "scripts", "the-security-guide.md",
    # RTK
    "RTK.md",
    # Inspected per-file below
    "CLAUDE.md", "settings.json", "skills", "agents", "commands",
}

findings = 0


def load(path: Path) -> dict[str, Any]:
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return {}


def short(value: Any, limit: int = 160) -> str:
    text = json.dumps(value, sort_keys=True)
    return text if len(text) <= limit else text[:limit] + "…"


def report(title: str, lines: list[str]) -> None:
    global findings
    if not lines:
        return
    findings += len(lines)
    print(f"\n## {title}")
    for line in lines:
        print(f"- {line}")


def portable(settings: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in settings.items() if k not in IGNORED_SETTINGS_KEYS}
    if isinstance(out.get("modelSettings"), dict):
        out["modelSettings"] = {
            k: v for k, v in out["modelSettings"].items() if not k.startswith(IGNORED_MODEL_PREFIXES)
        }
    return out


def diff_dict(live: dict[str, Any], repo: dict[str, Any], prefix: str = "") -> list[str]:
    lines = []
    for key in sorted(set(live) | set(repo)):
        name = f"{prefix}{key}"
        if key not in repo:
            lines.append(f"NEW `{name}` = {short(live[key])}")
        elif key not in live:
            lines.append(f"only in repo `{name}` = {short(repo[key])} (removed locally?)")
        elif live[key] != repo[key]:
            if isinstance(live[key], dict) and isinstance(repo[key], dict):
                lines += diff_dict(live[key], repo[key], f"{name}.")
            else:
                lines.append(f"CHANGED `{name}`: repo {short(repo[key])} -> live {short(live[key])}")
    return lines


def check_settings() -> None:
    repo = load(TRACKED / "settings.json")
    live = portable(load(CLAUDE_DIR / "settings.json"))
    # A repo marketplace registered via known_marketplaces.json counts as present.
    known = load(CLAUDE_DIR / "plugins" / "known_marketplaces.json")
    repo_markets = repo.get("extraKnownMarketplaces", {})
    live["extraKnownMarketplaces"] = {
        **{k: v for k, v in repo_markets.items() if k in known},
        **live.get("extraKnownMarketplaces", {}),
    }
    report("settings.json (portable keys)", diff_dict(live, repo))


def check_marketplaces() -> None:
    # `/plugin marketplace add` records into known_marketplaces.json, not settings.
    settings = load(TRACKED / "settings.json")
    repo = settings.get("extraKnownMarketplaces", {})
    known = load(CLAUDE_DIR / "plugins" / "known_marketplaces.json")
    lines = [
        f"marketplace `{name}` installed but not in extraKnownMarketplaces: source {short(m.get('source'))}"
        for name, m in sorted(known.items()) if name not in repo
    ]
    enabled = settings.get("enabledPlugins", {})
    installed = load(CLAUDE_DIR / "plugins" / "installed_plugins.json").get("plugins", {})
    lines += [f"plugin `{pid}` installed but not in enabledPlugins" for pid in sorted(installed) if pid not in enabled]
    report("Marketplaces / plugins", lines)


def check_mcp() -> None:
    repo = load(TRACKED / "mcp.json")
    live = load(USER_JSON).get("mcpServers", {})
    secret_fields = ("env", "headers")
    # Redact env/headers values so secrets never reach the report.
    redacted = {
        name: {k: ({sk: "<redacted>" for sk in v} if k in secret_fields else v) for k, v in cfg.items()}
        for name, cfg in live.items()
    }
    lines = diff_dict(redacted, repo)
    if any(field in cfg for cfg in live.values() for field in secret_fields):
        lines.append("WARNING: a live MCP server has env/headers — keep secrets out of mcp.json")
    report("User-scope MCP servers (mcp.json)", lines)


def check_claude_md() -> None:
    live, repo = CLAUDE_DIR / "CLAUDE.md", TRACKED / "CLAUDE.md"
    if not live.exists() or filecmp.cmp(live, repo, shallow=False):
        return
    diff = difflib.unified_diff(
        repo.read_text().splitlines(), live.read_text().splitlines(), "repo/CLAUDE.md", "live/CLAUDE.md", lineterm=""
    )
    report("CLAUDE.md", ["differs:\n```diff\n" + "\n".join(diff) + "\n```"])


def dirs_differ(a: Path, b: Path) -> bool:
    cmp = filecmp.dircmp(a, b, ignore=[".DS_Store"])
    if cmp.left_only or cmp.right_only or cmp.diff_files or cmp.funny_files:
        return True
    return any(dirs_differ(a / d, b / d) for d in cmp.common_dirs)


def check_mods() -> None:
    skills = CLAUDE_DIR / "skills"
    skip = GENERATED_SKILL_DIRS | set(load(SKILL_LOCK).get("skills", {}))
    lines = []
    for entry in sorted(skills.iterdir()) if skills.is_dir() else []:
        if entry.is_symlink() or not entry.is_dir() or entry.name in skip:
            continue
        tracked = TRACKED / "skills" / entry.name
        if not tracked.exists():
            lines.append(f"NEW hand-written skill/mod `skills/{entry.name}`")
        elif dirs_differ(entry, tracked):
            lines.append(f"CHANGED mod `skills/{entry.name}`")
    for tracked in sorted((TRACKED / "skills").glob("*/")):
        if not (skills / tracked.name).exists():
            lines.append(f"only in repo `skills/{tracked.name}` (removed locally?)")
    report("Mods / hand-written skills", lines)


def check_agents_commands() -> None:
    # ECC's legacy installer copied its agents/commands here; only non-ECC names are user-authored.
    lines = []
    for kind in ("agents", "commands"):
        for f in sorted((CLAUDE_DIR / kind).glob("*.md")):
            if not (ECC / kind / f.name).exists():
                lines.append(f"user-authored `{kind}/{f.name}` (install.sh does not install {kind}/ yet)")
    report("Custom agents / commands", lines)


def check_unclassified() -> None:
    lines = [
        f"`{p.name}` — classify: hand-authored (track) or generated (add to GENERATED_TOP_LEVEL)"
        for p in sorted(CLAUDE_DIR.iterdir())
        if p.name not in GENERATED_TOP_LEVEL and not p.name.endswith((".log", ".bak")) and ".bak." not in p.name
    ]
    report("Unclassified ~/.claude entries", lines)


def main() -> None:
    print(f"# Drift: {CLAUDE_DIR} vs {TRACKED}")
    check_settings()
    check_marketplaces()
    check_mcp()
    check_claude_md()
    check_mods()
    check_agents_commands()
    check_unclassified()
    print("\nNo drift." if findings == 0 else f"\n{findings} finding(s).")


if __name__ == "__main__":
    main()
