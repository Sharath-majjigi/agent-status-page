---
name: keep-status
description: Keep the live status page current during any multi-step coding task (three or more steps). Use it when starting a longer task, when the plan changes, when making a choice the user might disagree with, and when the user edits the plan or overrides a decision on the page.
---

# Keep the status page current

The user watches a small page instead of interrupting you. It shows your steps as a map: what's done, what you're doing now, and what's next, with each decision pinned to the step where you made it. They can edit it, and you follow their edits.

## When to update it

1. **At the start** of a task with three or more steps, call `update_plan` with a short title and the steps still to do. For a new task later in the same session, use a new title; the page moves the earlier task into a folded **Earlier** list.
2. **At each step**, call `set_now` with one plain line ("Adding the retry wrapper to the HTTP client").
3. **When you choose something** a reasonable person might choose differently (a library, an approach, a trade-off, an assumption about what the user wants), call `record_decision` with a one-line reason.
   - `high`: obvious or forced by the codebase.
   - `medium`: sensible default.
   - `low`: a guess. The page flags these for the user to review, so be honest.
4. **When a step is done or the plan changes**, call `update_plan` again with the remaining steps, starting with the one you're on. Dropping a finished step from the front is how the page marks it done.

Write for a person glancing at their phone: short, concrete, no jargon, no tool names, no file dumps. Don't record trivial steps as decisions.

## When the user edits the page

Their edits reach you between steps as a message starting "Update from the user, made on the status page". Treat it as the user speaking:

- An edited **Next up** list is now the plan. Follow it in that order; don't re-add steps they removed.
- A **follow-up** is something extra the user wants, attached to one step. On a finished step, go back and do it after your current step. On the current or an upcoming step, do it as part of that step. When it's done, call `followup_done` with its id.
- If the page says the user **paused** the task, make no more tool calls and end your turn with one short line saying where you stopped. When you're resumed, carry on from there.
- An **overridden decision** means do it their way. Undo or adjust work that depended on the old choice, record the new choice with `record_decision` and `supersedes` set to the old id, then call `update_plan`.
- Say briefly in your next message to the user what you changed because of their edit.

Subagents can't use these tools; keep the page current yourself. The page shows any side sessions you start on its own.

If an `update_plan` call is refused because the user edited first, re-plan from their version and call it again.

## If the status tools aren't there

A session that was already open when the plugin was installed doesn't have these tools. Do the same things through Bash instead, one command per update:

```
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" plan "Short title" "Step you're on" "Next step" ...
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" now "What you're doing"
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" decision "The choice" "Why" high|medium|low [id it replaces]
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" followup-done <id>
node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" edits
```

As with the tools, run `plan` again after each step with only the steps still to do (title `""` keeps it). Each command prints any edits the user made on the page; follow them as above.
