---
name: Task Planning
description: Use when a task needs three or more steps, spans multiple phases, or involves several tool calls. Maintains a visible, nestable task list in the right sidebar so the user can follow progress.
---

# Task Planning

Keep a live task list so the user can see the plan without reading the
transcript, and so the plan survives context compaction.

## When to plan

Create the list when the work has **three or more steps**, spans multiple
phases, or needs several tool calls. For a single trivial action, skip it —
an empty panel is cheaper than a noisy one.

## Shape of the list

- Every entry needs a short unique `id` (`T1`, `T2`, ...). Sub-tasks use
  `T1.1`, `T1.2` and set `parent_id` to the parent id, so they render indented
  under it.
- `status` is one of `pending`, `in_progress`, `blocked`, `done`, `cancelled`.
- `summary` is one line: what the item is, not how it will be done.
- Keep the list flat-ish. Two levels of nesting is the practical limit.

## Rules

1. **One call replaces the whole list.** Always send the complete list on
   every call — never just the changed items. The tool takes the full array
   and overwrites what was there.
2. **Exactly one item is `in_progress` at a time** (zero when the work is
   blocked). This is what makes the panel readable at a glance.
3. **Update the list whenever the plan or the progress changes** — not only
   at the start and the end. A stale panel is worse than no panel.
4. **Nothing stays `pending` at the end.** Finish it, cancel it, or mark it
   `blocked` with the reason in the summary.
5. **Nest only for real sub-steps.** A sub-task that is not part of its
   parent's completion is a top-level item.
6. **Re-plan when the plan changes.** If new work appears, insert the new
   items and send the whole list again.
7. **A new phase starts a new list.** When the work moves to a different
   phase, send a fresh list and set `new_plan: true` on that one call. It
   clears the task lists of your subagents, so the panel shows the current
   phase only. Subagent lists that already finished are cleared on their own,
   without the flag.

## Example

```json
{
  "tasks": [
    { "id": "T1", "status": "in_progress", "summary": "Map the existing auth flow" },
    { "id": "T1.1", "parent_id": "T1", "status": "done", "summary": "Locate the session store" },
    { "id": "T1.2", "parent_id": "T1", "status": "pending", "summary": "Trace the refresh path" },
    { "id": "T2", "status": "blocked", "summary": "Needs the staging credentials" }
  ]
}
```

## Example — starting a new phase

```json
{
  "new_plan": true,
  "tasks": [
    { "id": "T1", "status": "in_progress", "summary": "Ship the migration" }
  ]
}
```
