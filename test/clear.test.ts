import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSubagentLists, descendantSessions } from "../index.ts"
import { normalizeTasks, readAllTasks, saveTasks, tasksFile } from "../src/tasks.ts"

/**
 * A stand-in for the plugin context: only `session.get` is used, and it
 * answers with the session's own info, exactly like the real endpoint does.
 *
 * `parents` maps a session id to its parent id. A session that is not in the
 * map is unknown to the server and fails the lookup.
 */
function fakeContext(parents: Record<string, string>) {
  const ctx = {
    session: {
      get: async (input: { sessionID: string }) => {
        const parentID = parents[input.sessionID]
        if (parentID === undefined) throw new Error(`unknown session ${input.sessionID}`)
        return { id: input.sessionID, parentID }
      },
    },
  }
  return { ctx: ctx as never }
}

/** Run `fn` with the task files pointed at a throwaway directory. */
async function withStateDir(fn: () => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tasks-panel-clear-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    await fn()
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Silence the error log for a test that provokes a failure on purpose.
 *
 * The plugin always traces a failure — the server's stderr is not readable,
 * so a swallowed error would be an invisible bug.
 */
async function expectingErrors<T>(fn: () => Promise<T>): Promise<T> {
  const spy = spyOn(console, "error").mockImplementation(() => {})
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}

describe("descendantSessions", () => {
  test("finds the direct children", async () => {
    const { ctx } = fakeContext({ child: "main" })
    expect(await descendantSessions(ctx, "main", ["child"])).toEqual(["child"])
  })

  test("finds the grandchildren too", async () => {
    const { ctx } = fakeContext({ child: "main", grandchild: "child" })
    expect(await descendantSessions(ctx, "main", ["child", "grandchild"])).toEqual(["child", "grandchild"])
  })

  test("a grandchild is found even when the child keeps no list", async () => {
    const { ctx } = fakeContext({ child: "main", grandchild: "child" })
    expect(await descendantSessions(ctx, "main", ["grandchild"])).toEqual(["grandchild"])
  })

  test("returns nothing for a session with no children", async () => {
    const { ctx } = fakeContext({})
    expect(await descendantSessions(ctx, "main", ["main"])).toEqual([])
  })

  test("an unrelated session is not a descendant", async () => {
    const { ctx } = fakeContext({ other: "elsewhere" })
    await expectingErrors(async () => {
      expect(await descendantSessions(ctx, "main", ["other"])).toEqual([])
    })
  })

  test("a cycle in the tree does not hang the walk", async () => {
    const { ctx } = fakeContext({ a: "b", b: "a" })
    expect(await descendantSessions(ctx, "a", ["a", "b"])).toEqual(["b"])
  })

  test("a session that cannot be read keeps its own list", async () => {
    const { ctx } = fakeContext({})
    await expectingErrors(async () => {
      expect(await descendantSessions(ctx, "main", ["missing"])).toEqual([])
    })
  })
})

describe("clearSubagentLists", () => {
  test("clears a finished subagent list and keeps a running one", async () => {
    await withStateDir(async () => {
      saveTasks("sub_done", normalizeTasks([{ id: "S1", status: "done", summary: "old work" }]))
      saveTasks("sub_running", normalizeTasks([{ id: "S2", status: "in_progress", summary: "live work" }]))
      saveTasks("main", normalizeTasks([{ id: "T1", status: "pending", summary: "main" }]))

      const { ctx } = fakeContext({ sub_done: "main", sub_running: "main" })
      const cleared = await clearSubagentLists(ctx, "main", false)

      expect(cleared).toEqual(["sub_done"])
      expect(existsSync(tasksFile("sub_done"))).toBe(false)
      expect(existsSync(tasksFile("sub_running"))).toBe(true)
      expect(existsSync(tasksFile("main"))).toBe(true)
      expect(readAllTasks().sub_done).toBeUndefined()
    })
  })

  test("a new plan clears the unfinished subagent lists too", async () => {
    await withStateDir(async () => {
      saveTasks("sub_running", normalizeTasks([{ id: "S2", status: "in_progress", summary: "live work" }]))

      const { ctx } = fakeContext({ sub_running: "main" })
      const cleared = await clearSubagentLists(ctx, "main", true)

      expect(cleared).toEqual(["sub_running"])
      expect(existsSync(tasksFile("sub_running"))).toBe(false)
    })
  })

  test("a subagent writing its own list leaves the parent alone", async () => {
    await withStateDir(async () => {
      saveTasks("main", normalizeTasks([{ id: "T1", status: "pending", summary: "main" }]))
      saveTasks("sub", normalizeTasks([{ id: "S1", status: "done", summary: "sub" }]))

      const { ctx } = fakeContext({ sub: "main" })
      const cleared = await expectingErrors(async () => clearSubagentLists(ctx, "sub", false))

      expect(cleared).toEqual([])
      expect(existsSync(tasksFile("main"))).toBe(true)
      expect(existsSync(tasksFile("sub"))).toBe(true)
    })
  })
})
