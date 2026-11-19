#!/usr/bin/env node
// The status tools as a command, for sessions where the plugin's MCP server
// isn't loaded (for example a session that was already open when the plugin
// was installed: Claude Code only starts plugin MCP servers with a new session).
//
//   node cli.js plan "Title" "First step" "Second step" ...   (title "" keeps the current one)
//   node cli.js now "What you're doing"
//   node cli.js decision "The choice" "Why, in one line" high|medium|low [id-it-replaces]
//   node cli.js followup-done f1
//   node cli.js edits
//
// Like the tools, every command prints any edits the user made on the page.
'use strict';
const { request, ensureServer } = require('./client');
const { run } = require('./actions');

const USAGE = `Usage:
  plan "Title" "Step" "Step" ...
  now "What you're doing"
  decision "The choice" "Why" high|medium|low [id it replaces]
  followup-done <id>
  edits`;

(async () => {
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) return fail('Run this from Claude Code (its Bash tool), so the page knows which session it is.');
  const [cmd, ...a] = process.argv.slice(2);
  let name, args;
  if (cmd === 'plan' && a.length >= 1) { name = 'update_plan'; args = { title: a[0] || undefined, next: a.slice(1) }; }
  else if (cmd === 'now' && a[0]) { name = 'set_now'; args = { doing: a[0] }; }
  else if (cmd === 'decision' && a[1]) { name = 'record_decision'; args = { decision: a[0], reason: a[1], confidence: a[2] || 'medium', ...(a[3] ? { supersedes: a[3] } : {}) }; }
  else if (cmd === 'followup-done' && a[0]) { name = 'followup_done'; args = { id: a[0] }; }
  else if (cmd === 'edits') { name = 'get_user_edits'; args = {}; }
  else return fail(USAGE);

  if (!(await ensureServer())) return fail('Could not start the status page server.');
  // Hooks may not have run in this session, so tell the page where it lives.
  await request('POST', '/api/hook/start', {
    session, cli: true, cwd: process.cwd(), pid: Number(process.env.CLAUDE_PID) || 0,
    hostId: process.env.CLAUDE_CODE_HOST_SESSION_ID || '',
  }).catch(() => {});
  console.log(await run(session, name, args));
})().catch(e => fail(`Status page unavailable: ${e.message}. Carry on with the task.`));

function fail(msg) { console.log(msg); process.exitCode = 1; }
