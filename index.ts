import type { Plugin, Skill } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseSkillDocument } from "./src/skill.ts"
import { TASK_STATUSES, normalizeTasks, saveTasks, summarizeTasks } from "./src/tasks.ts"

/** Where the bundled planning skill lives inside the package. */
const SKILL_FILE = new URL("./skills/task-planning/SKILL.md", import.meta.url)
const SKILL_ID = "task-planning"
const SKILL_NAME = "Task Planning"

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
        "Call this whenever the plan or progress changes.",
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
        },
        required: ["tasks"],
      },
      options: { codemode: false },
      execute: async (input, toolCtx) => {
        const tasks = normalizeTasks((input as { tasks?: unknown } | undefined)?.tasks)
        const sessionID = String(toolCtx?.sessionID ?? "global")
        saveTasks(sessionID, tasks)

        // Only `content` is returned on purpose: this tool declares no
        // structured `output` schema, and returning `output` anyway makes the
        // runtime reject the result with "Tool result declared output without
        // an output schema" — which made every call fail.
        return { content: summarizeTasks(tasks) }
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
export { TASK_STATUSES, normalizeTasks, flattenTasks, saveTasks, summarizeTasks, tasksDir, tasksFile } from "./src/tasks.ts"
