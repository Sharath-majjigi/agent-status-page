# Status Page for Claude Code

A calm live page for long Claude Code tasks: the agent's steps as one map, from done to now to next. **Edit a step, add a follow-up, or override a decision, and the running agent follows at its next step.**

<p>
  <img src="docs/desktop-light.png" width="62%" alt="Status page in light mode">
  <img src="docs/phone-dark.png" width="30%" alt="Status page on a phone in dark mode">
</p>

## Install

```bash
claude plugin marketplace add Sharath-majjigi/agent-status-page && claude plugin install status-page@agent-status-page
```

Needs Node 18+. Sessions you start after installing get everything. In a session that was already open, run `/status-page:open`: Claude keeps the page current through a small command instead of its usual tools, and your edits reach it. Run `/reload-plugins` there too to also get edits between steps and Pause.

## Use

Give Claude any multi-step task and open the page with `/status-page:open`. The map fills in by itself from the task list Claude already keeps (the desktop app's list, or its to-dos in the terminal), so it never goes blank while Claude works. Claude adds its decisions on top.

- **The map:** every step on one line, with what's done, what's running now, and what's next. Tap a step to open it: what it's doing and the decisions made there. Unsure decisions are marked *review*; click **Change** to say what to do instead.
- **Next up:** rename, reorder (drag or Move up/down), remove, or add steps.
- **Follow-ups:** add one to any step, even a finished one, and it branches off the map as a blue square: waiting, then *agent has it*, then done. Branches fold into a small badge once they're done; click it to open them.
- **Side sessions:** sessions the agent starts show as linked branches with their own progress. Click one to open its page.
- **Questions:** when Claude ends a turn with a question (the desktop app's next-step box), it shows on the page with the same buttons, plus *Reply…* for your own words. Your answer wakes Claude. Questions Claude asks with its question dialog show too, with each option and *Other…*; a click answers the dialog itself, in any permission mode. Claude Code's own permission checks still apply to whatever it does next.
- **Permissions:** when Claude Code is about to ask your permission (say, to run a command) and the session's page is open, the request shows on the page: *Allow*, *Deny* or *Always allow*. Your click is Claude Code's own permission decision. Unanswered for 10 minutes, Claude Code asks as usual. In auto mode Claude Code decides by itself and doesn't ask, so nothing shows here. Anyone with the page link can answer, so keep it to yourself.
- **Pause and Resume:** Pause stops the agent at its next step (whatever it is running finishes first). While it's paused, your edits wait. Resume wakes it where it left off, edits included. Typing to Claude also resumes it.
- **History:** the clock button opens the last 30 days of work, grouped by session. Built to be skimmed, not read:
  - **Needs you** lists only what you have to settle: a downside Claude flagged, failing tests, commits that were never pushed. Click **Fine** to clear one.
  - Each task is one line: a verb (Fixed, Added, Changed, Removed), a headline of at most 5 words, and **proof** the page saw happen: tests passed or failed, checked in the browser, pushed. Proof comes from the commands Claude ran, never from what it says.
  - It leads with what's new since you last looked; older tasks fold away.
  - Opening a task shows **Before / After / Catch** in at most 6 words each, the decisions, and a replay of the steps. Claude writes the summary when it finishes; the page refuses anything longer.

Your edits reach the agent between its steps. In an open session, they wake it up even after it has stopped.

## How it works

A plugin with three parts: an MCP server with a few small tools the agent uses to update the page, hooks that hand your edits to the agent between steps (and notice the side sessions it starts), and a tiny local server that streams the page live. No dependencies, no accounts, no network calls.

## Privacy

The server listens on `127.0.0.1` only. Every request needs a random token that lives in `~/.agent-status-page/token` and in your page link, so nothing else on your network can read the page or steer the agent. State is kept in `~/.agent-status-page/`.

## Uninstall

```bash
claude plugin uninstall status-page@agent-status-page
```

MIT License
