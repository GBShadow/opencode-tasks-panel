import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configCandidates, configPath, readConfig } from "../src/config.ts"
import { parseSkillDocument } from "../src/skill.ts"

describe("parseSkillDocument", () => {
  test("reads the frontmatter fields and the body", () => {
    const doc = parseSkillDocument("---\nname: Task Planning\ndescription: Does things\n---\n\nBody text\n")
    expect(doc.name).toBe("Task Planning")
    expect(doc.description).toBe("Does things")
    expect(doc.body).toBe("Body text")
  })

  test("strips surrounding quotes", () => {
    const doc = parseSkillDocument('---\nname: "Quoted"\n---\nbody')
    expect(doc.name).toBe("Quoted")
  })

  test("treats a document without frontmatter as body only", () => {
    const doc = parseSkillDocument("just text")
    expect(doc.name).toBeUndefined()
    expect(doc.description).toBeUndefined()
    expect(doc.body).toBe("just text")
  })

  test("handles an unterminated frontmatter block", () => {
    const doc = parseSkillDocument("---\nname: Broken\n")
    expect(doc.description).toBeUndefined()
  })
})

describe("readConfig", () => {
  test("returns the defaults when no file exists anywhere", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME
    const previousHome = process.env.HOME
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-cfg-"))
    process.env.XDG_CONFIG_HOME = dir
    process.env.HOME = dir
    try {
      expect(readConfig().showSubagentTasks).toBe(false)
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to the home location when the XDG one is missing", () => {
    const previousXdg = process.env.XDG_CONFIG_HOME
    const previousHome = process.env.HOME
    const xdg = mkdtempSync(join(tmpdir(), "tasks-panel-xdg-"))
    const home = mkdtempSync(join(tmpdir(), "tasks-panel-home-"))
    process.env.XDG_CONFIG_HOME = xdg
    process.env.HOME = home
    try {
      mkdirSync(join(home, ".config", "opencode"), { recursive: true })
      writeFileSync(
        join(home, ".config", "opencode", "tasks-panel.json"),
        JSON.stringify({ showSubagentTasks: true }),
      )
      expect(readConfig().showSubagentTasks).toBe(true)
      expect(configPath()).toBe(join(home, ".config", "opencode", "tasks-panel.json"))
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(xdg, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("reads showSubagentTasks from the XDG location", () => {
    const previous = process.env.XDG_CONFIG_HOME
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-cfg-"))
    process.env.XDG_CONFIG_HOME = dir
    try {
      mkdirSync(join(dir, "opencode"), { recursive: true })
      writeFileSync(join(dir, "opencode", "tasks-panel.json"), JSON.stringify({ showSubagentTasks: true }))
      expect(readConfig().showSubagentTasks).toBe(true)
      expect(configPath()).toBe(join(dir, "opencode", "tasks-panel.json"))
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to the defaults for a malformed file", () => {
    const previous = process.env.XDG_CONFIG_HOME
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-cfg-"))
    process.env.XDG_CONFIG_HOME = dir
    try {
      mkdirSync(join(dir, "opencode"), { recursive: true })
      writeFileSync(join(dir, "opencode", "tasks-panel.json"), "{ not json")
      expect(readConfig().showSubagentTasks).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("checks both the XDG and the home location", () => {
    const previous = process.env.XDG_CONFIG_HOME
    const dir = mkdtempSync(join(tmpdir(), "tasks-panel-cfg-"))
    process.env.XDG_CONFIG_HOME = dir
    try {
      const candidates = configCandidates()
      expect(candidates.length).toBeGreaterThan(1)
      expect(candidates.some((p) => p.endsWith(join("opencode", "tasks-panel.json")))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
