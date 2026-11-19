#!/usr/bin/env node
// Print the status page link (and open it in the browser).
'use strict';
const { execFile } = require('child_process');
const { ensureServer, pageUrl, request } = require('./client');

const path = require('path');
const CLI = path.join(__dirname, 'cli.js');

// Why the page might still say "Waiting for Claude", and, when the status tools
// aren't loaded (the session was open before the plugin), how Claude can use the Bash fallback.
async function diagnose(session) {
  const r = await request('POST', '/api/diagnose', { session }).catch(() => null);
  if (!r) return '';
  if (r.tools) return r.task ? '' : 'The page fills in once Claude starts a task with three or more steps.';
  const note = r.hooks
    ? 'Note: the status tools didn’t load in this session, so Claude will keep the page current through Bash instead.'
    : 'Note: this session was open before the plugin loaded, so Claude will keep the page current through Bash instead. If you haven’t yet, run /reload-plugins to also get your edits between steps and Pause.';
  const cli = `node "${CLI}"`;
  return `${note}

[For Claude, not the user] The status page tools aren't loaded in this session. For the rest of this session, do what the keep-status skill says through Bash instead, one command per update:
  ${cli} plan "Short title" "Step you're on" "Next step" ...
  ${cli} now "What you're doing, in one plain line"
  ${cli} decision "The choice" "Why, in one line" high|medium|low [id it replaces]
  ${cli} followup-done <id>
  ${cli} edits
After each step, run plan again with only the steps still to do (no title needed: ""); that's how the page marks steps done. Each command prints any edits the user made on the page. Treat those as the user speaking and follow them. If you're in the middle of a task now, run the plan command for it right away.`;
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
