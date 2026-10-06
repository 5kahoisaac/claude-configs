---
name: sync-claude-config
description: Pull new hand-authored Claude Code config from this machine (~/.claude settings, CLAUDE.md, marketplaces, plugins, MCP servers, mods) into this repo's claude/ dir so install.sh can restore it elsewhere. Use when the user says they changed their Claude setup, added a plugin/marketplace/MCP server/mod, or asks to sync, update, or capture config into the repo.
---

# Sync Claude config into this repo

The repo tracks only **hand-authored** global config under `claude/`; `install.sh`
restores it. Your job: find what changed on this machine, decide what is
hand-authored, update `claude/` (and `install.sh` if a new kind of thing appears),
and verify.

## 1. Get the drift report (read-only)

```bash
python3 -I .claude/skills/sync-claude-config/scripts/drift.py
```

It compares the live config with `claude/` and already filters known noise
(Orca `hooks`/`statusLine`, `cx/*` model entries, ECC copies, `npx skills`
symlinks, runtime state) and redacts MCP `env`/`headers` values. Sections:

| Section                       | Repo target                                              |
|-------------------------------|----------------------------------------------------------|
| settings.json (portable keys) | `claude/settings.json`                                   |
| Marketplaces / plugins        | `extraKnownMarketplaces` / `enabledPlugins` in settings  |
| User-scope MCP servers        | `claude/mcp.json`                                        |
| CLAUDE.md                     | `claude/CLAUDE.md`                                       |
| Mods / hand-written skills    | `claude/skills/<name>/`                                  |
| Custom agents / commands      | not yet supported — extend `install.sh` first            |
| Unclassified entries          | classify (step 2)                                        |

"No drift." means nothing to do — say so and stop.

## 2. Classify each finding

Track it only if the user wrote or chose it. Test: *would it come back on its
own after plugins install and tools run?* If yes, don't track it.

**Generated — never copy into the repo:**
- ECC output: skills, agents, commands, hooks, `rules/`, `scripts/`, `mcp-configs/`,
  and `AGENTS.md`, `README.md`, `plugin.json`, `marketplace.json`,
  `PLUGIN_SCHEMA_NOTES.md`, `the-security-guide.md` in `~/.claude`. Check against
  `~/.claude/plugins/marketplaces/ecc/` — same filename there means it is ECC's,
  even if the content differs (version drift).
- `~/.claude/skills/*` symlinks into `~/.agents/skills` — owned by `npx skills`
  (`~/.agents/.skill-lock.json`).
- `skills/synced/` (claude.ai sync), `skills/learned/` (ECC continuous learning).
- Orca: the large `hooks` entries and `statusLine` mentioning `ORCA_AGENT_HOOK`.
- RTK: the `rtk hook claude` hook and `RTK.md` (from `rtk init -g`).
- codebase-memory-mcp: `hooks/cbm-*`.
- Plugin caches, sessions, history, logs, `*.bak`, credentials, `settings.local.json`.

**User's call — ask if unsure:** per-model `modelSettings` entries (the user
excluded `cx/*`), and anything machine-specific (absolute paths, local services
that exist on one machine only).

**Never track secrets.** MCP `env`/`headers`, tokens and API keys stay out of
the repo. If a server needs one, track it without the secret and tell the user
to set it per machine.

When you newly classify something as generated, add it to `GENERATED_TOP_LEVEL`
(or the matching ignore constant) in `scripts/drift.py` so it stops showing up.

## 3. Update the repo

- **settings.json**: copy only the hand-authored keys from the live file into
  `claude/settings.json` (use `jq`).
- **Marketplace added via `/plugin marketplace add`**: it lands in
  `plugins/known_marketplaces.json`, not settings. Add it to
  `extraKnownMarketplaces` as `{"source": {"source": "github", "repo": "o/r"}}`
  or `{"source": {"source": "git", "url": "…"}}`.
- **Plugin**: add `"name@marketplace": true` to `enabledPlugins`; its
  marketplace must be in `extraKnownMarketplaces`.
- **MCP**: copy the server object from `~/.claude.json` `.mcpServers` into
  `claude/mcp.json`, secrets removed.
- **Mod**: `cp -R ~/.claude/skills/<name> claude/skills/` then
  `find claude -name .DS_Store -delete`.
- **"only in repo"** means it was removed locally. Confirm with the user before
  deleting it from the repo. `install.sh` deep-merges settings, so removing a
  key here never deletes it on other machines — say so.
- **New kind of config** (`keybindings.json`, `output-styles/`, custom agents or
  commands): add a small `install_*` function to `install.sh` like the existing
  ones (backup → copy, idempotent, `</dev/null` on `claude` calls), call it from
  `main`, and add a row to the README table.

Keep the README's "What is tracked" / "Deliberately not tracked" lists in sync.

## 4. Verify

```bash
bash -n install.sh
python3 -I .claude/skills/sync-claude-config/scripts/drift.py   # expect "No drift."
```

If `install.sh` changed, run it twice against a throwaway config dir — never
the real `~/.claude`:

```bash
SB="$(mktemp -d)"; CLAUDE_CONFIG_DIR="$SB" ./install.sh && CLAUDE_CONFIG_DIR="$SB" ./install.sh
```

The second run must report everything "present"/"unchanged" and create no backups.

## 5. Finish

Show `git diff --stat`, then summarize what was added, removed, and skipped as
generated. Do not commit or push unless the user asks; when they do, use a
conventional message (`feat:` / `chore:`).

## Gotchas

- `install.sh` runs under `curl | bash`: keep all logic inside `main`, and give
  every `claude` subcommand `</dev/null` so it can't swallow the piped script.
- Backups go to `~/.claude/backups/`, never beside the original in `skills/`
  (a backup there would load as a plugin).
- Running sessions rewrite `~/.claude.json` constantly; a checksum change there
  is not evidence that a script touched it.
- The ECC GateGuard hook demands "facts" before the first Bash call,
  destructive commands, and new files — state them and retry.
