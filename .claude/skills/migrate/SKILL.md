---
name: migrate
description: Dispatcher for the four migration paths (OpenClaw→NanoClaw, NanoClaw v1→v2, fork→upstream, OpenClaw→v2 direct). Use when the user says "migrate" without specifying which path — asks the right question, then invokes the specific skill. Do not invoke the migration skills directly; route through here so the right one is picked.
---

# /migrate — Pick the right migration path

Four migration skills exist on this install. Each is comprehensive but applies to a different scenario. This dispatcher routes by asking the user.

## Decision

Use `AskUserQuestion` with these options:

| Option | Invoke |
|---|---|
| "Migrating from OpenClaw" | `/migrate-from-openclaw` |
| "Upgrading NanoClaw v1 → v2" | `/migrate-v1-to-v2` |
| "Catching up with upstream NanoClaw" | `/migrate-nanoclaw` |
| "Fresh OpenClaw → v2 direct" | `/migrate-from-v1` |

If unclear which applies, ask: "Which install are we migrating *from*, and to what?"

## Notes

- The 4 underlying skills each do 5–7 phases of procedural work. Compaction risk is real — when invoked, the picked skill will pause for `AskUserQuestion` at major decision points.
- If the user is on Sunshine (this install): they are post-migration. The migration skills should only be needed when helping someone *else* set up.
