/**
 * Panel configuration.
 *
 * The plugin is configured through a small JSON file next to the OpenCode
 * config, so the behaviour can be changed without touching code and without
 * restarting OpenCode: the file is re-read on every refresh tick.
 *
 * ```jsonc
 * // ~/.config/opencode/tasks-panel.json
 * { "showSubagentTasks": true }
 * ```
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface PanelConfig {
  /**
   * Also show the task lists of the current session's subagents, grouped under
   * the agent that owns them.
   */
  showSubagentTasks: boolean
}

const DEFAULTS: PanelConfig = {
  showSubagentTasks: false,
}

/**
 * Candidate locations for the configuration file, most specific first.
 *
 * Both are checked because the XDG base directory is not guaranteed to agree
 * between the processes that load this plugin: the server, the TUI, and a
 * desktop launcher can each see a different `XDG_CONFIG_HOME`. The file next
 * to the user's `opencode.jsonc` always wins when it exists.
 */
export function configCandidates(): string[] {
  // `HOME` is read directly rather than through `os.homedir()`: some runtimes
  // resolve the home directory from the passwd database and ignore the
  // environment, which would make the lookup depend on the machine instead of
  // the process.
  const home = join(process.env.HOME || homedir(), ".config", "opencode", "tasks-panel.json")
  const xdg = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode", "tasks-panel.json")
    : null
  return xdg && xdg !== home ? [xdg, home] : [home]
}

/** Path of the configuration file that will actually be read. */
export function configPath(): string {
  const candidates = configCandidates()
  return candidates.find((path) => existsSync(path)) ?? candidates[candidates.length - 1]
}

/**
 * Read the configuration, falling back to the defaults.
 *
 * A missing or malformed file is not an error: the panel must still work.
 */
export function readConfig(): PanelConfig {
  for (const path of configCandidates()) {
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PanelConfig>
      return {
        showSubagentTasks:
          typeof parsed.showSubagentTasks === "boolean"
            ? parsed.showSubagentTasks
            : DEFAULTS.showSubagentTasks,
      }
    } catch {
      // Malformed file: fall through to the next candidate, then to defaults.
      return { ...DEFAULTS }
    }
  }
  return { ...DEFAULTS }
}
