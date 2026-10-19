import type { Plugin, Skill } from "@opencode/plugin"
import { appendFileSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseSkillDocument } from "./src/skill.ts"
import {
  TASK_STATUSES,
  clearTasks,
  normalizeTasks,
  readAllTasks,
  saveTasks,
  staleSubagentLists,
  summarizeTasks,
} from "./src/tasks.ts"

/** Where the bundled planning skill lives inside the package. */
const SKILL_FILE = new URL("./skills/task-planning/SKILL.md", import.meta.url)
const SKILL_ID = "task-planning"
const SKILL_NAME = "Task Planning"

/**
 * The session id the OpenCode API expects.
 *
 * The brand is derived from the API's own signature instead of being
 * re-declared, so it cannot drift from the host.
 */
type SessionID = Awaited<ReturnType<Plugin.Context["session"]["get"]>>["id"]

/** Where the diagnostic trace goes. The server's stderr is not readable. */
const DEBUG_LOG = "/tmp/opencode/tasks-panel-debug.log"

/**
 * Append one line to the diagnostic trace.
 *
 * Failures are always traced: the server's stderr is not readable, so a
 * swallowed error would be an invisible bug. The verbose trace is only
 * written when `TASKS_PANEL_DEBUG=1`, like the TUI side.
 */
function debug(...parts: unknown[]): void {
  try {
    const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")
    appendFileSync(DEBUG_LOG, `${line}\n`)
  } catch {
    // The trace is a diagnostic, never a failure.
  }
}

/** Write a failure to the trace, and to the server's stderr as well. */
function debugError(message: string, error: unknown): void {
  const line = `${message}: ${error instanceof Error ? error.message : String(error)}`
  debug(`ERROR ${line}`)
  console.error(`[tasks-panel] ${line}`)
}

/**
 * Every descendant session of `sessionID`, at any depth.
 *
 * The candidates are the sessions that actually keep a task list, so the
 * search never has to enumerate the whole session store: the parent of each
 * candidate is resolved with `session.get`, and the chain of parents is
 * walked up to `sessionID`.
 *
 * Only the sessions that have a list are candidates, but their *parents* are
 * resolved on demand, so a subagent that never kept a list does not hide the
 * subagent below it.
 */
async function descendantSessions(
  ctx: Plugin.Context,
  sessionID: string,
  candidates: readonly string[],
): Promise<string[]> {
  // Parent lookups are cached: a session's parent never changes.
  const parents = new Map<string, string | null>()
  const parentOf = async (id: string): Promise<string | null> => {
    const cached = parents.get(id)
    if (cached !== undefined) return cached
    let parent: string | null = null
    try {
      const info = await ctx.session.get({ sessionID: id as SessionID })
      parent = info?.parentID ?? null
    } catch (error) {
      // A session that cannot be read has no known parent: it is treated as
      // a root, which is the safe answer — it keeps its own list.
      debugError(`session.get failed for ${id}`, error)
      parent = null
    }
    parents.set(id, parent)
    return parent
  }

  const found: string[] = []
  for (const candidate of candidates) {
    if (candidate === sessionID) continue
    let current = await parentOf(candidate)
    const seen = new Set<string>([candidate])
    while (current && !seen.has(current)) {
      seen.add(current)
      if (current === sessionID) {
        found.push(candidate)
        break
      }
      current = await parentOf(current)
    }
  }
  return found
}

/**
 * Drop the task lists of this session's subagents.
 *
 * A subagent's list belongs to the work it did. Once that work is over, the
 * list is history and must not keep sitting in the panel next to the parent's
 * current plan — a parent that starts a new plan would otherwise show the
 * finished subagent's checklist forever, because the session tree never
 * forgets a child.
 *
 * A subagent that is still working keeps its list. `newPlan` clears every
 * descendant, unfinished ones included, because the parent is starting a
 * different phase and none of the old work applies.
 *
 * Returns the ids that were cleared.
 */
async function clearSubagentLists(
  ctx: Plugin.Context,
  sessionID: string,
  newPlan: boolean,
): Promise<string[]> {
  const bySession = readAllTasks()
  const descendants = await descendantSessions(ctx, sessionID, Object.keys(bySession))
  if (descendants.length === 0) return []

  const stale = staleSubagentLists(bySession, descendants, newPlan)
  if (process.env.TASKS_PANEL_DEBUG === "1") {
    debug("session=", sessionID, "descendants=", JSON.stringify(descendants), "stale=", JSON.stringify(stale))
  }
  for (const id of stale) clearTasks(id)
  return stale
}

/**
 * Register the `tasks` tool.
 *
 * The tool takes the **complete** list on every call: one call replaces the
 * previous list, so the model never has to diff, patch, or delete entries.
 */
async function registerTools(ctx: Plugin.Context): Promise<void> {
  await ctx.tool.transform((tools) => {
    tools.add({
      name: "tasks",
      description:
        "Create and maintain the session task list rendered in the right sidebar. " +
        "Pass the COMPLETE list on every call; it replaces the previous one. " +
        "Set parent_id to a task id to nest a sub-task under it. " +
        "Call this whenever the plan or progress changes. " +
        "Subagent task lists that already finished are cleared automatically; " +
        "set new_plan when this list starts a different phase of work.",
      input: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "The full task list",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Short unique id, e.g. T1 or T1.1" },
                parent_id: { type: "string", description: "Parent task id for nesting; empty for top level" },
                status: {
                  type: "string",
                  enum: TASK_STATUSES,
                  description: "pending | in_progress | blocked | done | cancelled",
                },
                summary: { type: "string", description: "One-line task description" },
              },
              required: ["id", "status", "summary"],
            },
          },
          new_plan: {
            type: "boolean",
            description:
              "Set to true when this list starts a NEW phase of work. It clears the task lists of " +
              "every subagent, including ones that are still unfinished. Leave it unset for a " +
              "normal progress update.",
          },
        },
        required: ["tasks"],
      },
      options: { codemode: false },
      execute: async (input, toolCtx) => {
        const raw = (input as { tasks?: unknown; new_plan?: unknown } | undefined) ?? {}
        const tasks = normalizeTasks(raw.tasks)
        const sessionID = String(toolCtx?.sessionID ?? "global")
        saveTasks(sessionID, tasks)

        // A finished subagent list is history: the parent just replaced its
        // own list, so the panel must not keep showing the old subagent work
        // next to the new plan.
        const cleared = await clearSubagentLists(ctx, sessionID, raw.new_plan === true)

        // Only `content` is returned on purpose: this tool declares no
        // structured `output` schema, and returning `output` anyway makes the
        // runtime reject the result with "Tool result declared output without
        // an output schema" — which made every call fail.
        return { content: summarizeTasks(tasks, cleared.length) }
      },
    })
  })
}

/**
 * Register the bundled planning skill so a single install provides both the
 * tool and the behaviour that makes the model use it consistently.
 *
 * `SKILL.md` stays the source of truth; OpenCode strips frontmatter when it
 * loads a skill from disk itself, so the body is passed without it here. A
 * missing or unreadable file degrades to "tool only" rather than failing setup.
 */
async function registerSkill(ctx: Plugin.Context): Promise<void> {
  let markdown: string
  try {
    markdown = readFileSync(SKILL_FILE, "utf8")
  } catch (error) {
    console.error("[tasks-panel] bundled skill could not be read; continuing without it:", error)
    return
  }

  const skill = parseSkillDocument(markdown)
  // Skills without a description are never advertised to the model.
  if (!skill.description) {
    console.error("[tasks-panel] bundled skill has no description; continuing without it")
    return
  }

  await ctx.skill.transform((editor) => {
    editor.add({
      id: SKILL_ID,
      name: skill.name ?? SKILL_NAME,
      description: skill.description,
      path: fileURLToPath(SKILL_FILE),
      content: skill.body,
    } as Skill.Info)
  })
}

/**
 * Server-side entrypoint: registers the `tasks` tool and the planning skill.
 *
 * The TUI renderer lives in `tui.tsx` and is published as the `./tui` export.
 *
 * Runtime note: OpenCode V2 resolves `@opencode/plugin/tui` for TUI
 * entrypoints, but the server-side specifier is provided by the host at load
 * time. To keep this module dependency-free at runtime, `@opencode/plugin` is
 * imported with `import type` only (erased when the file is transpiled). The
 * exported object already has the `{ id, setup }` shape that `Plugin.define`
 * returns — it is an identity function — so no wrapper call is needed.
 */
export default {
  id: "opencode.tasks.panel",
  async setup(ctx: Plugin.Context) {
    await Promise.all([registerTools(ctx), registerSkill(ctx)])
  },
} satisfies Plugin.Plugin

// Re-exported for programmatic use and for tests.
export {
  TASK_STATUSES,
  clearTasks,
  flattenTasks,
  isFinished,
  normalizeTasks,
  readAllTasks,
  saveTasks,
  staleSubagentLists,
  summarizeTasks,
  tasksDir,
  tasksFile,
} from "./src/tasks.ts"

// Exported for tests: the session-tree walk and the clearing it drives.
export { clearSubagentLists, descendantSessions }
