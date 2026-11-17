# 60-second demo for X

**Setup (before recording):** plugin installed, Claude Code restarted, a small repo open. Screen split: Claude Code on the left, the browser on the right (or your phone on a stand). Dark mode looks best on video.

Prompt to paste (it has a few real choices and takes a few minutes):

> Add rate limiting to this API: a middleware with per-key limits, tests for the 429 response, and a short section in the README.

---

**0:00–0:08 · Hook.** Paste the prompt and hit enter.
Caption: *"Long Claude Code tasks make me anxious. So I built a page I can glance at, and steer."*

**0:08–0:18 · The link.** Claude replies with the page link. Click it. The page fills in: title, **Now**, and **Next up**.
Caption: *"What it's doing now, and what's next. Nothing else."*

**0:18–0:30 · Decisions.** A decision appears with a quiet **review** tag (e.g. "Limit each key to 100 requests a minute").
Caption: *"Every choice it makes, with a reason. The ones it's unsure about are flagged."*

**0:30–0:42 · Override.** Click **Change**, type "Make it 600 a minute, our batch clients burst", press ⌘↵. It shows "Waiting for the agent's next step", then **Agent is re-planning**.
Caption: *"Disagree? Say so in plain words."*

**0:42–0:52 · Edit the plan.** In **Next up**, click a step and rewrite it, or drag one to the top. Cut to the terminal: Claude says it got your edit and changes course.
Caption: *"Edit the plan. It follows at its next step."*

**0:52–0:60 · Close.** Show the phone view for a second.
Caption: *"Open source, local only, one command to install."* + repo link.

Tips: keep the cursor still, zoom the browser to 110–125%, and trim the waits between steps in the edit.
