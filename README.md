# pi-pack

Three extensions for the [pi coding agent](https://pi.dev).

> **Note:** all user-facing strings (command descriptions, dialogs, notifications) are in
> Russian. The code and this README are in English.

## Install

```bash
pi install git:github.com/AlexBSoD/pi-pack
```

To try without installing:

```bash
pi -e git:github.com/AlexBSoD/pi-pack
```

No runtime dependencies — the extensions only use node builtins plus
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, both of which pi bundles.

## Extensions

### guardrails

Rules that hang off `tool_call`, so they apply whether or not the model read them in the
system prompt.

Blocked outright:

- writes to protected paths — `/run/agenix`, `*.age`, `~/.ssh`, `disko.nix`, `/nix/store`,
  `.git` internals
- `find` and `grep -r` — use `fd` and `rg` instead
- fish syntax inside the `bash` tool (`; and`, `set -gx VAR value`, `string match`), which
  runs under bash and would just fail
- `rm -rf /`, `nix-store --delete`

Confirmation dialog:

- `rm`, `rmdir`, `shred`, `truncate`, and `rm` arriving via `xargs` / `-exec` / `fd -x`
- `git reset --hard`, force push, `git clean -f`, forced rebase
- `podman`/`docker` `rm`, `rmi`, `prune`, `volume rm`
- `DROP`/`TRUNCATE`, `DELETE FROM` without a `WHERE`
- `mkfs`, `dd of=/dev/…`, `nix-collect-garbage`
- `>` redirects that overwrite an existing file

Answering "don't ask again" marks that one rule allowed for the rest of the session.

There is also a set of rules for the [graphiti](https://github.com/getzep/graphiti) MCP
server, which are worth keeping only if you run one: `episode_body` over 900 characters and
`add_triplet` facts over 200 characters are rejected (the former is silently dropped by
graphiti, the latter pollutes unrelated searches), `clear_graph` is blocked, and Cyrillic
search queries are rejected because the graph is stored in English.

Without an interactive UI (RPC, `--print`, cron) there is nobody to confirm, so anything
that would prompt is blocked instead.

`/guardrails [on|off|status]` — turn off while debugging.

### statusline

Replaces the pi footer with a single line: host, cwd, git branch, model, thinking level,
context usage, clock. Built on `ctx.ui.setFooter()`, so the git branch comes from
`footerData` rather than shelling out from the UI thread.

Requires a Nerd Font — the icons come from the private use area.

### vibes

Themed working messages in the spinner, replacing pi's default.

Sets are `*.txt` files loaded from the extension directory and from
`$PI_CODING_AGENT_DIR/vibes` (default `~/.pi/agent/vibes`); a user file overrides a built-in
one of the same name. Five sets ship with the package — `cyber`, `fallout`, `mechanicus`,
`eldritch` and `noir` — 170–220 lines each, in Russian.

File format:

```
[read,grep] Считываю дамп чужой памяти...   # shown for these tools
Корректирую настройку деки...               # general pool
# comment
```

Tool tags match the tool name, with prefix rules mapping `mcp__memory_*` to `memory`,
`mcp__*` to `mcp`, and so on.

Each set can define its own spinner frames. In `all` mode the messages are drawn from every
set, but the animation is not: one themed set is picked at random per launch and its frames
stay for the whole session, because frames changing on every tool call read as a glitch.

`/vibes [all|<set>|off]`, `ctrl+alt+v` to cycle. The choice persists in
`~/.pi/agent/vibes-state.json`.

## License

MIT
