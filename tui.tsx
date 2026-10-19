import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { writeFileSync } from "node:fs"
import { For, Show } from "solid-js"
import { configPath, readConfig } from "./src/config.ts"
import { STATUS_MARK, type FlatTask, type Task, readAllTasks, tasksForSession } from "./src/tasks.ts"

/** How often the sidebar re-reads the task files written by the server plugin. */
const REFRESH_INTERVAL_MS = 1000

/** Where the optional debug trace goes when `TASKS_PANEL_DEBUG=1`. */
const DEBUG_LOG = "/tmp/opencode/tasks-panel-debug.log"

type Store = { bySession: Record<string, Task[]>; showSubagents: boolean }

/** A block of rows in the panel: the current session, or one subagent's list. */
interface Group {
  sessionID: string
  /** Label shown above the rows; empty for the current session. */
  label: string
  /** Indentation level of the group header. */
  depth: number
  rows: FlatTask[]
}

/** Pick the text color for a task row from the active theme. */
function rowColor(context: Plugin.Context, status: string): RGBA | undefined {
  const text = context.theme?.text
  if (!text) return undefined
  if (status === "done") return text.feedback.success.base
  if (status === "blocked") return text.feedback.error.base
  if (status === "in_progress") return text.feedback.warning.base
  return text.muted
}

/**
 * How many levels below `ancestorID` the session `candidateID` sits, or `-1`
 * when `candidateID` is not a descendant of `ancestorID`.
 */
function depthBelow(context: Plugin.Context, candidateID: string, ancestorID: string): number {
  let current: ReturnType<Plugin.Context["session"]["get"]>
  try {
    current = context.data.session.get(candidateID)
  } catch {
    return -1
  }
  let depth = 0
  const seen = new Set<string>()
  while (current?.parentID && !seen.has(current.parentID)) {
    seen.add(current.parentID)
    if (current.parentID === ancestorID) return depth
    depth++
    try {
      current = context.data.session.get(current.parentID)
    } catch {
      return -1
    }
  }
  return -1
}

/** A short, human-readable name for a session: its agent, then its title. */
function sessionLabel(context: Plugin.Context, sessionID: string): string {
  let info: ReturnType<Plugin.Context["session"]["get"]>
  try {
    info = context.data.session.get(sessionID)
  } catch {
    return sessionID.slice(0, 8)
  }
  if (!info) return sessionID.slice(0, 8)
  if (info.agent) return info.agent
  if (info.title) return info.title
  return sessionID.slice(0, 8)
}

/**
 * The task groups to render for the current session.
 *
 * The current session's own list always comes first. When subagent tasks are
 * enabled, every descendant session that has a task list of its own adds a
 * labelled group after it, indented by how deep the subagent sits.
 */
function buildGroups(
  context: Plugin.Context,
  bySession: Record<string, Task[]>,
  sessionID: string,
  showSubagents: boolean,
): Group[] {
  const groups: Group[] = []

  if (process.env.TASKS_PANEL_DEBUG === "1") {
    const lines: string[] = []
    lines.push(`session=${sessionID} showSubagents=${showSubagents} config=${JSON.stringify(readConfig())}`)
    lines.push(`configPath=${configPath()}`)
    let family: string[] = []
    try {
      family = context.data.session.family(sessionID) ?? []
    } catch (error) {
      lines.push(`family() threw: ${error}`)
    }
    lines.push(`family(${family.length})=${JSON.stringify(family)}`)
    for (const id of family) {
      let info: ReturnType<Plugin.Context["session"]["get"]>
      try {
        info = context.data.session.get(id)
      } catch (error) {
        lines.push(`  ${id} get() threw: ${error}`)
        continue
      }
      lines.push(
        `  ${id} -> ${info ? `parent=${info.parentID} agent=${info.agent} title=${info.title}` : "undefined"}`,
      )
    }
    try {
      lines.push(`known=${JSON.stringify(context.data.session.list().map((s) => s.id))}`)
    } catch (error) {
      lines.push(`list() threw: ${error}`)
    }
    try {
      writeFileSync(DEBUG_LOG, lines.join("\n") + "\n")
    } catch (error) {
      lines.push(`write failed: ${error}`)
    }
  }

  const own = tasksForSession(bySession, sessionID)
  if (own.length > 0) groups.push({ sessionID, label: "", depth: 0, rows: own })

  if (!showSubagents) return groups

  let family: string[] = []
  try {
    family = context.data.session.family(sessionID) ?? []
  } catch {
    return groups
  }

  const children: { id: string; depth: number }[] = []
  for (const id of family) {
    if (id === sessionID) continue
    const depth = depthBelow(context, id, sessionID)
    if (depth >= 0) children.push({ id, depth })
  }
  // Stable order: shallow subagents first, then by id.
  children.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  for (const child of children) {
    const rows = tasksForSession(bySession, child.id)
    if (rows.length === 0) continue
    groups.push({
      sessionID: child.id,
      label: sessionLabel(context, child.id),
      depth: child.depth,
      rows,
    })
  }

  return groups
}

/**
 * The sidebar panel: a collapsible, nested task list for the **current**
 * session, optionally extended with the lists its subagents keep.
 *
 * Every session has its own list, so switching sessions switches the rows and a
 * brand-new session starts empty. Both the "is there anything to show" check
 * and the rows themselves have to be reactive: a Solid component body runs
 * once, so an early `return null` would freeze the decision at mount time and
 * the panel would never appear (or never disappear) as sessions change.
 */
function Tasks(props: {
  context: Plugin.Context
  store: Store
  view: { open: boolean }
  /** Toggles the section and re-reads the task files. */
  onToggle: () => void
  sessionID: string
}) {
  const groups = (): Group[] =>
    buildGroups(props.context, props.store.bySession ?? {}, props.sessionID, props.store.showSubagents)

  const subagentCount = (): number => groups().filter((group) => group.label !== "").length

  return (
    <Show when={groups().length > 0}>
      <box flexDirection="column">
        <box flexDirection="row" gap={1} onMouseDown={props.onToggle}>
          <text fg={props.context.theme?.text?.base}>{props.view.open ? "▼" : "▶"}</text>
          <text fg={props.context.theme?.text?.base}>Tasks</text>
          <Show when={subagentCount() > 0}>
            <text fg={props.context.theme?.text?.muted}>+{subagentCount()}</text>
          </Show>
        </box>
        <Show when={props.view.open}>
          <For each={groups()}>
            {(group) => (
              <box flexDirection="column">
                <Show when={group.label !== ""}>
                  <text fg={props.context.theme?.text?.muted}>
                    {"  ".repeat(group.depth) + "▸ " + group.label}
                  </text>
                </Show>
                <For each={group.rows}>
                  {(task) => (
                    <text fg={rowColor(props.context, task.status)}>
                      {"  ".repeat(group.label !== "" ? group.depth + 1 : task.depth) +
                        STATUS_MARK[task.status] +
                        " " +
                        task.id +
                        " " +
                        task.summary}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

/**
 * TUI entrypoint: mirrors the on-disk task list into a reactive store and
 * renders it in `sidebar.content`.
 *
 * The store is seeded **synchronously** during setup so that a session which
 * already has tasks shows its panel on the very first frame. An asynchronous
 * read would leave the store empty at mount time, and the panel would only
 * appear if the subsequent reactive update reached the host's renderer — the
 * one failure mode this entrypoint is written to avoid.
 *
 * Rendering is synchronous while the tasks come from files written by the
 * server process, so the store is refreshed on a short interval. Clicking the
 * section header also re-reads immediately, so expanding always shows the
 * latest state rather than waiting for the next tick. The cleanup function
 * returned by `setup` stops the timer when the plugin unloads.
 */
export default Plugin.define({
  id: "opencode.tasks.panel.tui",
  setup(context) {
    const [store, setStore] = context.storage.memory("opencode-tasks-panel", {
      initial: { bySession: {}, showSubagents: false } satisfies Store,
    })
    // Collapse state, matching the built-in MCP section: persisted in memory
    // storage and toggled by clicking the section header.
    const [view, setView] = context.storage.memory("opencode-tasks-panel-view", {
      initial: { open: true },
    })

    const refresh = (): void => {
      try {
        const next = readAllTasks()
        const config = readConfig()
        setStore((draft) => {
          draft.bySession = next
          draft.showSubagents = config.showSubagentTasks
        })
      } catch (error) {
        console.error("[tasks-panel] could not read the task list:", error)
      }
    }

    // Synchronous seed: the panel is present from the first frame.
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Tasks
          context={context}
          store={store}
          view={view}
          sessionID={input.sessionID}
          onToggle={() => {
            setView((draft) => {
              draft.open = !draft.open
            })
            // Fallback for the polling loop: re-read on click so expanding the
            // section always shows the latest state, even if the interval has
            // not fired yet or a previous refresh failed.
            refresh()
          }}
        />
      ),
    })

    return () => clearInterval(timer)
  },
})
