/**
 * Minimal `SKILL.md` frontmatter parser.
 *
 * The bundled skill ships as a Markdown file with a YAML-ish frontmatter block.
 * Only the two keys the runtime cares about are extracted (`name` and
 * `description`); anything else is ignored rather than pulling in a YAML
 * dependency.
 */

export interface SkillDocument {
  /** Frontmatter `name`, if present. */
  name?: string
  /** Frontmatter `description`, if present. */
  description?: string
  /** Markdown body with the frontmatter block removed. */
  body: string
}

/**
 * Split a Markdown document into frontmatter fields and body.
 *
 * A document without a leading `---` fence is treated as body-only.
 */
export function parseSkillDocument(markdown: string): SkillDocument {
  const text = markdown.replace(/\r\n/g, "\n")
  if (!text.startsWith("---\n")) return { body: text.trim() }

  const end = text.indexOf("\n---", 3)
  if (end === -1) return { body: text.trim() }

  const frontmatter = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^-+\n?/, "").trim()

  const fields: Record<string, string> = {}
  for (const line of frontmatter.split("\n")) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const value = match[2].trim()
    fields[match[1]] = value.replace(/^["'](.*)["']$/, "$1")
  }

  const result: SkillDocument = { body }
  if (fields.name) result.name = fields.name
  if (fields.description) result.description = fields.description
  return result
}
