#!/usr/bin/env node
// Print the status page link (and open it in the browser).
'use strict';
const { execFile } = require('child_process');
const { ensureServer, pageUrl } = require('./client');

(async () => {
  const arg = process.argv[2] || '';
  const session = /^[\w-]{8,}$/.test(arg) ? arg : '';
  if (!(await ensureServer())) { console.log('Could not start the status page server.'); process.exit(1); }
  const url = pageUrl(session);
  console.log(url);
  if (process.argv.includes('--no-open') || process.env.AGENT_STATUS_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
})();
