# opencode-tasks-panel

A task list panel for the **OpenCode v2** sidebar: a `tasks` tool the agent
calls, plus a live, nestable todo list rendered in the TUI sidebar.

```
▼ Tasks +1
[x] T1 Diagnóstico do plugin
[~] T2 Implementar o painel
[ ] T2.1 Seed síncrono
▸ general
  [x] S1 Subagente: investigar o cache
  [~] S2 Subagente: validar o render
```

## Install

The plugin is a local package. Clone it wherever you like and register it in
both the server config and the terminal client config.

```sh
git clone https://github.com/GBShadow/opencode-tasks-panel.git
```

`~/.config/opencode/opencode.jsonc` (server: the tool and the skill):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-tasks-panel"]
}
```

`~/.config/opencode/cli.json` (client: the sidebar panel):

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-tasks-panel"]
}
```

Then reload:

```sh
opencode reload
```

Check that it is loaded:

```sh
opencode plugin list
# ID                    VERSION  SOURCE
# opencode.tasks.panel  local    /absolute/path/to/opencode-tasks-panel/index.ts
```

## Configuration

`~/.config/opencode/tasks-panel.json`:

```jsonc
{
  // Also show the task lists of the current session's subagents, grouped
  // under the agent that owns them.
  "showSubagentTasks": true
}
```

The file is re-read on every refresh tick, so a change takes effect without
restarting OpenCode. The lookup checks `$XDG_CONFIG_HOME/opencode/` first and
then `~/.config/opencode/`, because the XDG base directory is not guaranteed to
agree between the server, the TUI, and a desktop launcher.

## How it works

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  OpenCode server (agent)     │        │  OpenCode TUI (sidebar)      │
│                              │        │                              │
│  tasks tool ──► normalize ───┼──┐  ┌──┼──► flatten ──► <Tasks />     │
└──────────────────────────────┘  │  │  └──────────────────────────────┘
                                  ▼  ▼
                    $XDG_STATE_HOME/opencode-tasks/<session>.json
```

Two entrypoints, one model:

- `index.ts` — server: registers the `tasks` tool and the bundled
  `task-planning` skill.
- `tui.tsx` — client: renders the panel into `sidebar.content`.
- `src/tasks.ts` — the shared model and the on-disk format. It has **no**
  OpenCode import, so the two runtimes can never disagree about it.

### The `tasks` tool

The tool takes the **complete** list on every call; one call replaces the
previous one, so the model never has to diff, patch, or delete entries.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `tasks` | array | yes | The complete list. Replaces what was there. |
| `tasks[].id` | string | yes | Short unique id, e.g. `T1` or `T1.1`. |
| `tasks[].status` | string | yes | `pending`, `in_progress`, `blocked`, `done`, `cancelled`. |
| `tasks[].summary` | string | yes | One-line description. |
| `tasks[].parent_id` | string | no | Parent id, for nesting. |
| `new_plan` | boolean | no | This list starts a new phase: every subagent list is cleared, unfinished ones included. |

### Status markers

| Status | Marker | Color |
| --- | --- | --- |
| `pending` | `[ ]` | muted |
| `in_progress` | `[~]` | warning |
| `blocked` | `[!]` | error |
| `done` | `[x]` | success |
| `cancelled` | `[-]` | muted |

### Storage

```
$XDG_STATE_HOME/opencode-tasks/<url-encoded-session-id>.json
# or, when XDG_STATE_HOME is unset:
~/.local/state/opencode-tasks/<url-encoded-session-id>.json
```

One file per session. A session with no file has no tasks, and no other
session's tasks can leak into it. A file that is missing, unreadable, or
half-written is skipped rather than blanking the panel.

The directory name is shared with the `opencode2-tasks` plugin on purpose: the
on-disk format is identical, so lists written by either one stay readable by
both.

## Subagent tasks

With `showSubagentTasks` enabled, the panel also lists the task lists of the
current session's subagents, each under a `▸ <agent>` header. The session tree
comes from `context.data.session.family()`, and a session counts as a
subagent when its `parentID` chain leads back to the current session — so
nested subagents are grouped at their own depth.

### When a subagent list is cleared

A subagent's list belongs to the work it did, not to the panel forever. The
session tree never forgets a child, so without an explicit rule a finished
subagent's checklist would sit next to the parent's current plan for the rest
of the session.

Every `tasks` call replaces the session's own list, and that is also the
moment the parent declares where the work stands. So:

- A subagent list where **every entry is terminal** (`done` or `cancelled`) is
  history: it is cleared as soon as the parent writes its list again.
- A subagent that is **still working** keeps its list.
- `new_plan: true` clears **every** subagent list, unfinished ones included.
  Use it on the single call that starts a different phase of work.

The clearing happens in the server, on the session tree resolved with
`session.get`: the parent of every session that keeps a list is read, and the
chain of parents is walked up to the session that wrote the list. The TUI only
reads the files it finds, so a cleared list simply stops being rendered.

OpenCode 2.0.32 does not expose `session.list` to plugins, so the tree is
resolved from the sessions that actually have a list — which is the set the
panel can show anyway.

## Development

```sh
bun test          # unit tests for the pure model, the parser, and the config
```

Set `TASKS_PANEL_DEBUG=1` to have the panel write a diagnostic snapshot of the
session family, the resolved configuration, and the known sessions to
`/tmp/opencode/tasks-panel-debug.log`.

## Credits and differences

This is a derivative work of **[opencode2-tasks]**
(https://github.com/smallnest/opencode2-tasks) by smallnest, MIT licensed.
The task model, the on-disk format, the status markers, and the structure of
the TUI panel come from there. See [LICENSE](LICENSE) for the full notice.

What this version changes:

- **Synchronous seed.** The store is filled during `setup`, so the panel is
  present on the first frame. The original read the task files asynchronously,
  which left the panel empty at mount time and made its appearance depend on a
  reactive update reaching the host's renderer.
- **Subagent task lists.** `showSubagentTasks` aggregates the lists the
  subagents keep, grouped under the agent that owns them.
- **A finished subagent list does not outlive its phase.** A subagent list
  where every entry is terminal is cleared when the parent writes its list
  again, and `new_plan` clears every subagent list at once. The session tree
  never forgets a child, so without this rule the old checklist would sit next
  to the parent's current plan for the rest of the session.
- **A configuration file** that is re-read on every tick, so behaviour changes
  without restarting OpenCode.
- **Resilient lookups.** The configuration is searched in both the XDG and the
  home location, because `XDG_CONFIG_HOME` is not guaranteed to agree between
  the server, the TUI, and a desktop launcher.
- **Diagnostics.** `TASKS_PANEL_DEBUG=1` writes a snapshot of the session
  family to a file, which is how the session-tree integration was debugged.

The on-disk format is unchanged on purpose: lists written by either plugin
stay readable by both.

[opencode2-tasks]: https://github.com/smallnest/opencode2-tasks
