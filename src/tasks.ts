/**
 * Shared task model, on-disk storage, and pure helpers.
 *
 * This module is deliberately free of any OpenCode import: the server
 * entrypoint (`index.ts`) and the TUI entrypoint (`tui.tsx`) are loaded into two
 * different runtimes and each imports this file independently. Keeping the
 * model here means the two processes can never disagree about the on-disk
 * format, and the pure functions stay unit-testable without booting a runtime.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** All statuses a task may have. Anything else is normalized to `pending`. */
export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled"] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

/** A single task as stored on disk and rendered in the sidebar. */
export interface Task {
  /** Short, unique, human-readable id, e.g. `T1` or `T1.1`. */
  id: string
  /** Parent task id for nesting, or `null` for a top-level task. */
  parent_id: string | null
  /** Current status. */
  status: TaskStatus
  /** One-line description of the task. */
  summary: string
}

/** A task with its computed indentation depth, ready to be rendered. */
export type FlatTask = Task & { depth: number }

/** Single-character status markers used by the sidebar. */
export const STATUS_MARK: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  blocked: "[!]",
  done: "[x]",
  cancelled: "[-]",
}

/** Type guard for {@link TaskStatus}. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

/**
 * Directory where task files live.
 *
 * Follows the XDG base directory spec, falling back to `~/.local/state` when
 * `XDG_STATE_HOME` is unset. The directory name is shared with the
 * `opencode2-tasks` plugin on purpose: the on-disk format is identical, so
 * task lists written by either plugin stay readable by both.
 */
export function tasksDir(): string {
  // `HOME` is read directly rather than through `os.homedir()`: some runtimes
  // resolve the home directory from the passwd database and ignore the
  // environment, which would make the storage location depend on the machine
  // instead of the process.
  const home = process.env.HOME || homedir()
  const base = process.env.XDG_STATE_HOME || join(home, ".local", "state")
  return join(base, "opencode-tasks")
}

/** Path of the JSON file that holds one session's task list. */
export function tasksFile(sessionID: string): string {
  return join(tasksDir(), `${encodeURIComponent(sessionID)}.json`)
}

/**
 * Coerce arbitrary tool input into a well-formed, de-duplicated task list.
 *
 * The tool schema is advisory: a model can send numbers for ids, unknown
 * statuses, or an empty parent. Everything is normalized here so the sidebar
 * never has to defend itself.
 */
export function normalizeTasks(tasks: unknown): Task[] {
  if (!Array.isArray(tasks)) return []

  const seen = new Set<string>()
  const out: Task[] = []
  tasks.forEach((raw, index) => {
    const value = (raw ?? {}) as Record<string, unknown>
    const id = String(value.id ?? index + 1)
    if (seen.has(id)) return
    seen.add(id)
    out.push({
      id,
      parent_id: value.parent_id == null || value.parent_id === "" ? null : String(value.parent_id),
      status: isTaskStatus(value.status) ? value.status : "pending",
      summary: String(value.summary ?? ""),
    })
  })
  return out
}

/**
 * Order tasks depth-first by `parent_id` and compute each task's indentation.
 *
 * Children are rendered directly under their parent. Tasks whose parent is
 * missing (or that form a parent cycle) are appended at depth 0 so nothing is
 * ever hidden. The input order is preserved for siblings.
 */
export function flattenTasks(tasks: readonly Task[]): FlatTask[] {
  const children = new Map<string, Task[]>()
  for (const task of tasks) {
    const key = task.parent_id ?? ""
    const bucket = children.get(key)
    if (bucket) bucket.push(task)
    else children.set(key, [task])
  }

  const out: FlatTask[] = []
  const visited = new Set<string>()
  const walk = (parent: string, depth: number): void => {
    for (const task of children.get(parent) ?? []) {
      // Guards against self-parents and longer cycles.
      if (visited.has(task.id)) continue
      visited.add(task.id)
      out.push({ ...task, depth })
      walk(task.id, depth + 1)
    }
  }
  walk("", 0)

  // Orphans (and the tail of any cycle) are shown at the top level.
  for (const task of tasks) {
    if (visited.has(task.id)) continue
    visited.add(task.id)
    out.push({ ...task, depth: 0 })
  }
  return out
}

/** Persist a session's task list. */
export function saveTasks(sessionID: string, tasks: readonly Task[]): void {
  mkdirSync(tasksDir(), { recursive: true })
  writeFileSync(tasksFile(sessionID), `${JSON.stringify(tasks, null, 2)}\n`, "utf8")
}

/**
 * Select the rows to render for one session.
 *
 * The sidebar shows exactly the current session's list: a session with no
 * stored tasks reads as empty, and no other session's tasks can leak in.
 */
export function tasksForSession(bySession: Record<string, readonly Task[]>, sessionID: string): FlatTask[] {
  return flattenTasks(bySession[sessionID] ?? [])
}

/** Order statuses appear in {@link summarizeTasks}, most interesting first. */
const SUMMARY_ORDER: readonly TaskStatus[] = ["done", "in_progress", "blocked", "pending", "cancelled"]

/**
 * One-line, human-readable summary of a task list.
 *
 * The `tasks` tool deliberately declares no structured `output` schema, so this
 * string is what the model reads back. Only statuses that actually occur are
 * mentioned.
 */
export function summarizeTasks(tasks: readonly Task[]): string {
  if (tasks.length === 0) return "Task list cleared."

  const counts = new Map<TaskStatus, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)

  const parts = SUMMARY_ORDER.filter((status) => counts.has(status)).map(
    (status) => `${counts.get(status)} ${status.replace("_", " ")}`,
  )
  return `${tasks.length} task(s): ${parts.join(", ")}.`
}

/**
 * Read every session's stored task list, keyed by session id.
 *
 * A file that is missing, unreadable, or only half-written is skipped rather
 * than failing the whole read: one bad file must not blank the panel.
 */
export function readAllTasks(): Record<string, Task[]> {
  const sessions: Record<string, Task[]> = {}

  let files: string[]
  try {
    files = readdirSync(tasksDir())
  } catch {
    return sessions
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue
    try {
      const sessionID = decodeURIComponent(file.slice(0, -5))
      sessions[sessionID] = normalizeTasks(JSON.parse(readFileSync(join(tasksDir(), file), "utf8")))
    } catch {
      // Skip files that are missing or only half-written.
    }
  }

  return sessions
}
