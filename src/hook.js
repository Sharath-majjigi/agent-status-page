#!/usr/bin/env node
// Claude Code hooks. They keep the "Now" line fresh and, most importantly,
// hand the user's page edits to the running agent between steps.
// A hook must never break the user's session: every failure exits 0 quietly.
'use strict';
const { request, ensureServer } = require('./client');

const mode = process.argv[2];
const OWN_TOOLS = /^mcp__plugin_status-page_status__/;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => main().catch(() => process.exit(0)));

const print = obj => process.stdout.write(JSON.stringify(obj));
const take = session => request('POST', '/api/take', { session }, 1500).then(r => r && r.message);

async function main() {
  const input = raw ? JSON.parse(raw) : {};
  const session = input.session_id;
  if (!session) return;

  switch (mode) {
    case 'start': {
      await ensureServer();
      await request('POST', '/api/hook/start', { session, cwd: input.cwd, pid: Number(process.env.CLAUDE_PID) || 0 });
      return;
    }
    case 'allow': // our own status tools only write to the local page, so don't prompt for them
      return print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Status page update' } });

    case 'pre': { // async: note the file being worked in
      const t = input.tool_input || {};
      const file = t.file_path || t.notebook_path || '';
      await request('POST', '/api/hook/activity', { session, status: 'working', ...(file ? { file } : {}) }, 800);
      return;
    }
    case 'post': { // between steps: deliver edits
      if (OWN_TOOLS.test(input.tool_name || '')) return; // those results already carry edits
      const message = await take(session);
      if (message) print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } });
      return;
    }
    case 'prompt': {
      await request('POST', '/api/hook/activity', { session, status: 'working' }, 800).catch(() => {});
      const message = await take(session);
      if (message) print({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } });
      return;
    }
    case 'stop': { // about to finish: if the user just edited something, keep going
      const message = await take(session);
      if (message) return print({ decision: 'block', reason: message });
      await request('POST', '/api/hook/activity', { session, status: 'idle' }, 800);
      return;
    }
    case 'wait': { // runs in the background after a stop; wakes the agent if the user edits later
      const r = await request('GET', `/api/wait?s=${encodeURIComponent(session)}`, undefined, 6 * 3600 * 1000);
      if (r && r.message) {
        process.stderr.write(r.message + '\n');
        process.exit(2);
      }
      return;
    }
  }
}
