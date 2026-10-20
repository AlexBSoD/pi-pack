# pi-pack

Six extensions for the [pi coding agent](https://pi.dev).

> **Note:** user-facing strings (command descriptions, dialogs, notifications) are in Russian,
> except statusline segments and statuses, which are in English. The code and this README
> are in English.

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

Rules for the [graphiti](https://github.com/getzep/graphiti) MCP server, served as `memory`
through Pi's built-in MCP (tools named `mcp__memory__<tool>`). They hang off `tool_call`, so
they apply whether or not the model read them in the system prompt — calls from `codemode`
scripts included.

Blocked outright:

- `episode_body` over 900 characters — graphiti drops it silently
- `custom_extraction_instructions` in `add_memory` — with a small local extractor model they
  cause runaway generation up to `max_tokens`, and the episode is lost after retries
- `add_triplet` facts over 200 characters — one edge is one embedding, a paragraph pollutes
  unrelated searches
- `clear_graph`

Confirmation dialog: `delete_episode`, `delete_entity_edge`. Answering "don't ask again"
marks that rule allowed for the rest of the session. Without an interactive UI (RPC,
`--print`, cron) there is nobody to confirm, so it is blocked instead.

`/guardrails [on|off|status]` — turn off while debugging.

### statusline

Replaces the pi footer with a single line: host, cwd, git branch, model, thinking level,
context usage, clock. Built on `ctx.ui.setFooter()`, so the git branch comes from
`footerData` rather than shelling out from the UI thread. Statuses other extensions set with
`ctx.ui.setStatus()` — incognito, "guardrails off" — are shown too.

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

Tool tags match the tool name, with prefix rules mapping `mcp__memory__*` to `memory`,
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

### copy-plain

Copies the last assistant reply to the clipboard as plain text.

The built-in `ctrl+x` (`app.message.copy`) copies raw Markdown. `ctrl+shift+x` copies the
same reply stripped: code fences removed (the code itself is kept, fence-aware so `#`, `>`
and `---` inside code blocks survive), links become `text (url)`, emphasis, headings,
table separator rows and horizontal rules go away. Pasting into a chat, ticket or doc
stays clean.

`/copy-plain` does the same thing as a command.

The copy path mirrors pi's own `copyToClipboard`: `wl-copy` on Wayland, `xclip`/`xsel`
on X11, OSC 52 as the fallback for SSH sessions without a local display.

### incognito

A conversation that leaves no trace: nothing goes to memory unless you say so, and the
session is deleted from disk when it ends.

The mode is process-wide, like a private browser window. Turn it on with `--incognito`,
`PI_INCOGNITO=1` or `/incognito on`; `/new` and `/fork` stay incognito. The environment
variable is inherited by child pi processes, so subagents run incognito too.

Memory:

- writes to graphiti (any `mcp__memory__*` tool except `search_*` / `get_*`), running
  `memory-digest` / `memory-import` from bash, and edits under `<agent dir>/memory` need
  confirmation; without an interactive UI they are blocked. Your answer in that dialog is the
  explicit go-ahead;
- the system prompt gets an `<incognito>` section, so the model does not try in the first
  place.

Disk: on `session_shutdown` (quit, `/new`, `/resume`, `/fork` — not reload, the session
stays) the extension deletes the `.jsonl`, the subagent child sessions in `<ts>_<id>/` and
the obspack archive `obspack/<id>/`. Pi does not create the file until the first message,
so starting and quitting leaves nothing at all.

The session carries an `incognito` custom entry; memory-digest skips marked transcripts.
If pi dies without a shutdown, a registry in `<agent dir>/incognito/<id>.json` (`{file, pid}`)
lets the next start remove whatever belonged to a dead pid. An `exit` hook does the same
on the way out as a backstop.

Opening an ordinary session (`--continue`, `/resume`) while incognito would mean either
deleting its whole history on exit or quietly saving the rest of the talk, so the mode
switches off with a warning instead. `/incognito on` in a session that already has messages
asks first — the whole session, earlier messages included, will be deleted.

`/incognito [on|off|status]`.

Pi's flag parser takes the word after a boolean extension flag as its value, so
`pi -p --incognito "prompt"` swallows the prompt. Put the prompt first or use
`PI_INCOGNITO=1`.

## License

MIT
