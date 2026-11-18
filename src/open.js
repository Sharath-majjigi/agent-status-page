#!/usr/bin/env node
// Print the status page link (and open it in the browser).
'use strict';
const { execFile } = require('child_process');
const { ensureServer, pageUrl, request } = require('./client');

// One plain line on why the page might still say "Waiting for Claude".
async function diagnose(session) {
  const r = await request('POST', '/api/diagnose', { session }).catch(() => null);
  if (!r) return '';
  if (!r.hooks) return 'Note: this session isn’t connected to the page. Plugins load when a session starts, so start a new session (or restart Claude Code). If that doesn’t help, your settings may block plugin hooks.';
  if (!r.tools) return 'Note: the status tools didn’t load in this session, so Claude can’t fill in the page. Restart Claude Code; if it still happens, run /mcp and check that status-page is connected.';
  if (!r.task) return 'The page fills in once Claude starts a task with three or more steps.';
  return '';
}

(async () => {
  const arg = process.argv[2] || '';
  const session = /^[\w-]{8,}$/.test(arg) ? arg : '';
  if (!(await ensureServer())) { console.log('Could not start the status page server.'); process.exit(1); }
  const url = pageUrl(session);
  console.log(url);
  if (session) console.log(await diagnose(session));
  if (process.argv.includes('--no-open') || process.env.AGENT_STATUS_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
})();
