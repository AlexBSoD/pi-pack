# pi-pack

Four extensions for the [pi coding agent](https://pi.dev).

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

No runtime dependencies — the extensions only use node builtins plus the packages pi
bundles: `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `pi-agent-core` and `typebox`.

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

While a blocking extension dialog is open — a guardrails confirmation, say — the line
carries a "waiting for input" marker, so a stalled session does not look like a working one.
Driven by the `ui_prompt_start` / `ui_prompt_end` events (pi 0.84.4+).

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

Each set can define its own spinner frames. In `all` mode the animation follows the message:
a line from `fallout` also brings the Geiger-counter frames. Until the first message the
frames come from a set picked at random per launch. A set with no frames of its own falls
back to pi's default spinner.

While a blocking dialog is open pi is waiting on a human, not working, so the animation
stops and the line switches to one tagged `ask`; the previous message comes back when the
dialog closes. Driven by the `ui_prompt_start` / `ui_prompt_end` events (pi 0.84.4+).

`/vibes [all|<set>|off]`, `ctrl+alt+v` to cycle. The choice persists in
`~/.pi/agent/vibes-state.json`.

### obspack

Stops large tool results from being replayed on every request. A text result over 10 KiB is
sent in full only for the first two provider requests — while the model is still reacting to
it. From the third request on, the context carries a short placeholder instead: id, size,
the first and last lines. The original is archived on disk and the model pulls back exactly
what it needs with the `obs_recall` tool — a page of lines (`{"id","line","lines"}`) or a
case-insensitive regex search (`{"id","grep"}`) that returns matching lines with numbers.

Derived from ObservationPack in [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) (MIT).
Differences: line-based paging and grep instead of byte offsets, no ledger, automatic
cleanup of archives whose session file is gone, a tmpdir fallback for non-persistent
sessions.

The session file is never modified — the swap happens in the `context` projection, so
history stays complete and recall keeps working after a resume or native compaction. The
send counter is derived from the history itself (assistant messages after the result), not
kept in memory, so the same request always projects the same way and prompt caching is not
disturbed. Any error fails open: the result goes out as it was.

Archives live in `<session dir>/obspack/<session id>/` and are removed on startup once the
matching session `.jsonl` no longer exists.

`/obspack [on|off|status]` — turn off, or see how much was archived and saved.

## License

MIT
