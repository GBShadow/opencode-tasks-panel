import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearTasks,
  flattenTasks,
  isFinished,
  normalizeTasks,
  staleSubagentLists,
  summarizeTasks,
  tasksForSession,
} from "../src/tasks.ts"

describe("normalizeTasks", () => {
  test("keeps a well-formed list untouched", () => {
    const input = [
      { id: "T1", parent_id: null, status: "pending", summary: "first" },
      { id: "T2", parent_id: "T1", status: "done", summary: "second" },
    ]
    expect(normalizeTasks(input)).toEqual(input)
  })

  test("drops duplicate ids, keeping the first", () => {
    const result = normalizeTasks([
      { id: "T1", status: "pending", summary: "a" },
      { id: "T1", status: "done", summary: "b" },
    ])
    expect(result).toHaveLength(1)
    expect(result[0].summary).toBe("a")
  })

  test("normalizes an unknown status to pending", () => {
    const result = normalizeTasks([{ id: "T1", status: "wat", summary: "x" }])
    expect(result[0].status).toBe("pending")
  })

  test("treats an empty parent_id as no parent", () => {
    const result = normalizeTasks([{ id: "T1", parent_id: "", status: "pending", summary: "x" }])
    expect(result[0].parent_id).toBeNull()
  })

  test("falls back to the index when the id is missing", () => {
    const result = normalizeTasks([{ status: "pending", summary: "x" }])
    expect(result[0].id).toBe("1")
  })

  test("returns an empty list for a non-array input", () => {
    expect(normalizeTasks(undefined)).toEqual([])
    expect(normalizeTasks("nope")).toEqual([])
  })
})

describe("flattenTasks", () => {
  test("orders children under their parent and computes depth", () => {
    const tasks = normalizeTasks([
      { id: "T1", status: "pending", summary: "first" },
      { id: "T1.1", parent_id: "T1", status: "done", summary: "child" },
      { id: "T1.1.1", parent_id: "T1.1", status: "done", summary: "grandchild" },
      { id: "T2", status: "pending", summary: "second" },
    ])
    const flat = flattenTasks(tasks)
    expect(flat.map((t) => t.id)).toEqual(["T1", "T1.1", "T1.1.1", "T2"])
    expect(flat.map((t) => t.depth)).toEqual([0, 1, 2, 0])
  })

  test("preserves the input order of siblings", () => {
    const tasks = normalizeTasks([
      { id: "T2", status: "pending", summary: "second" },
      { id: "T1", status: "pending", summary: "first" },
      { id: "T1.1", parent_id: "T1", status: "done", summary: "child" },
    ])
    const flat = flattenTasks(tasks)
    expect(flat.map((t) => t.id)).toEqual(["T2", "T1", "T1.1"])
    expect(flat.map((t) => t.depth)).toEqual([0, 0, 1])
  })

  test("shows orphans at the top level instead of hiding them", () => {
    const tasks = normalizeTasks([{ id: "T9", parent_id: "ghost", status: "pending", summary: "orphan" }])
    const flat = flattenTasks(tasks)
    expect(flat).toHaveLength(1)
    expect(flat[0].depth).toBe(0)
  })

  test("survives a parent cycle", () => {
    const tasks = normalizeTasks([
      { id: "A", parent_id: "B", status: "pending", summary: "a" },
      { id: "B", parent_id: "A", status: "pending", summary: "b" },
    ])
    const flat = flattenTasks(tasks)
    expect(flat.length).toBeGreaterThan(0)
    expect(new Set(flat.map((t) => t.id)).size).toBe(flat.length)
  })

  test("survives a self-parent", () => {
    const tasks = normalizeTasks([{ id: "A", parent_id: "A", status: "pending", summary: "a" }])
    expect(flattenTasks(tasks).length).toBeGreaterThan(0)
  })
})

describe("tasksForSession", () => {
  test("only returns the requested session", () => {
    const bySession = {
      s1: normalizeTasks([{ id: "A", status: "pending", summary: "a" }]),
      s2: normalizeTasks([{ id: "B", status: "pending", summary: "b" }]),
    }
    expect(tasksForSession(bySession, "s1").map((t) => t.id)).toEqual(["A"])
    expect(tasksForSession(bySession, "missing")).toEqual([])
  })
})

describe("summarizeTasks", () => {
  test("counts the statuses that occur", () => {
    const tasks = normalizeTasks([
      { id: "A", status: "done", summary: "a" },
      { id: "B", status: "done", summary: "b" },
      { id: "C", status: "in_progress", summary: "c" },
    ])
    expect(summarizeTasks(tasks)).toBe("3 task(s): 2 done, 1 in progress.")
  })

  test("reports an empty list", () => {
    expect(summarizeTasks([])).toBe("Task list cleared.")
  })

  test("mentions the subagent lists that were cleared", () => {
    const tasks = normalizeTasks([{ id: "A", status: "done", summary: "a" }])
    expect(summarizeTasks(tasks, 1)).toBe("1 task(s): 1 done. 1 subagent list was cleared.")
    expect(summarizeTasks(tasks, 2)).toBe("1 task(s): 1 done. 2 subagent lists were cleared.")
  })

  test("mentions the cleared lists even when the list is empty", () => {
    expect(summarizeTasks([], 1)).toBe("Task list cleared. 1 subagent list was cleared.")
  })
})

describe("isFinished", () => {
  test("is true only when every entry is terminal", () => {
    expect(
      isFinished(
        normalizeTasks([
          { id: "A", status: "done", summary: "a" },
          { id: "B", status: "cancelled", summary: "b" },
        ]),
      ),
    ).toBe(true)
  })

  test("is false while an entry can still change", () => {
    expect(
      isFinished(
        normalizeTasks([
          { id: "A", status: "done", summary: "a" },
          { id: "B", status: "in_progress", summary: "b" },
        ]),
      ),
    ).toBe(false)
    expect(isFinished(normalizeTasks([{ id: "A", status: "pending", summary: "a" }]))).toBe(false)
    expect(isFinished(normalizeTasks([{ id: "A", status: "blocked", summary: "a" }]))).toBe(false)
  })

  test("an empty list is not finished", () => {
    expect(isFinished([])).toBe(false)
  })
})

describe("staleSubagentLists", () => {
  const bySession = {
    done: normalizeTasks([{ id: "A", status: "done", summary: "a" }]),
    cancelled: normalizeTasks([{ id: "A", status: "cancelled", summary: "a" }]),
    running: normalizeTasks([{ id: "A", status: "in_progress", summary: "a" }]),
    pending: normalizeTasks([{ id: "A", status: "pending", summary: "a" }]),
  }

  test("clears the descendants that already finished", () => {
    const stale = staleSubagentLists(bySession, ["done", "cancelled", "running", "pending"])
    expect(stale).toEqual(["done", "cancelled"])
  })

  test("keeps a subagent that is still working", () => {
    expect(staleSubagentLists(bySession, ["running", "pending"])).toEqual([])
  })

  test("a descendant with no list has nothing to clear", () => {
    expect(staleSubagentLists(bySession, ["missing"])).toEqual([])
  })

  test("a new plan clears every descendant that has a list", () => {
    const stale = staleSubagentLists(bySession, ["done", "running", "missing"], true)
    expect(stale).toEqual(["done", "running"])
  })
})

describe("on-disk round trip", () => {
  test("a session file is readable back as its own list", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-test-"))
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = dir
    try {
      const { saveTasks, readAllTasks, tasksFile } = require("../src/tasks.ts")
      const tasks = normalizeTasks([{ id: "T1", status: "in_progress", summary: "write me" }])
      saveTasks("ses_abc", tasks)
      expect(tasksFile("ses_abc")).toBe(join(dir, "opencode-tasks", "ses_abc.json"))

      const all = readAllTasks()
      expect(all.ses_abc).toHaveLength(1)
      expect(all.ses_abc[0].summary).toBe("write me")
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a half-written file is skipped instead of blanking the panel", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-test-"))
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = dir
    try {
      const { readAllTasks } = require("../src/tasks.ts")
      const { mkdirSync } = require("node:fs")
      mkdirSync(join(dir, "opencode-tasks"), { recursive: true })
      writeFileSync(join(dir, "opencode-tasks", "ses_broken.json"), "{ not json")
      writeFileSync(
        join(dir, "opencode-tasks", "ses_ok.json"),
        JSON.stringify([{ id: "T1", status: "pending", summary: "fine" }]),
      )
      const all = readAllTasks()
      expect(all.ses_broken).toBeUndefined()
      expect(all.ses_ok).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("clearing a session removes its list and leaves the others alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-test-"))
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = dir
    try {
      const { saveTasks, readAllTasks, tasksFile } = require("../src/tasks.ts")
      saveTasks("ses_sub", normalizeTasks([{ id: "S1", status: "done", summary: "sub" }]))
      saveTasks("ses_main", normalizeTasks([{ id: "T1", status: "pending", summary: "main" }]))

      clearTasks("ses_sub")

      expect(readAllTasks().ses_sub).toBeUndefined()
      expect(readAllTasks().ses_main).toHaveLength(1)
      expect(existsSync(tasksFile("ses_sub"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("clearing a session with no list is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-test-"))
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = dir
    try {
      expect(() => clearTasks("ses_missing")).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
