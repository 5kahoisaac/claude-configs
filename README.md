# claude-configs

Minimal, idempotent restore of the Claude Code config that actually needs
reproducing on a new machine: **mcp-proxy** + **plugins** + portable settings.
No secrets stored.

## Data lives in `config/` — edit files, not the script

| File                            | What to put there                                                  |
|---------------------------------|--------------------------------------------------------------------|
| `config/mcp-servers.txt`        | `name \| transport \| target` per line (transport: http/sse/stdio) |
| `config/marketplaces.txt`       | one marketplace source (git URL or `owner/repo`) per line          |
| `config/plugins.txt`            | one `plugin@marketplace` per line                                  |
| `config/settings.portable.json` | settings keys deep-merged into `~/.claude/settings.json`           |

`restore.sh` loads these and applies them. **Adding an MCP server or plugin =
add a line to the relevant file.** `#` comments and blank lines are ignored.

Current defaults: `mcp-proxy` (http) + plugins `ecc@ecc`, `codex@openai-codex`,
`andrej-karpathy-skills@karpathy-skills`; settings carry `model`, `theme`,
`effortLevel`, `skipDangerousModePermissionPrompt`, and the `rtk` PreToolUse hook.

## Deliberately excluded

- **headroom** — triggered by `headroomwrap`, not config.
- **agents / skills** — managed in a separate repo.

## Usage

```bash
make check     # verify claude CLI
make restore   # mcp-proxy + plugins + settings, then status
make status    # show current MCP servers + plugins
```

Or individual steps: `make mcp` / `make plugins` / `make settings`.
Re-running is safe; `settings.json` is backed up to `*.bak.<timestamp>` first.
