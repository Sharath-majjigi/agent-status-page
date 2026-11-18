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

// True for `claude -p` runs: nobody is there to edit the page, and the run must be able to exit.
function unattended() {
  if (process.env.CLAUDE_CODE_SESSION_ATTENDED === '0') return true;
  const pid = Number(process.env.CLAUDE_PID);
  if (!pid) return false;
  try {
    const args = require('child_process').execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    return /\s(-p|--print)(\s|$)/.test(args);
  } catch { return false; }
}

// The chain of parent pids above Claude, so a claude started from another session's shell can find it.
function ancestors() {
  const pid = Number(process.env.CLAUDE_PID);
  if (!pid) return [];
  try {
    const parent = new Map(require('child_process').execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)));
    const out = [];
    for (let p = parent.get(pid); p && p > 1 && out.length < 12; p = parent.get(p)) out.push(p);
    return out;
  } catch { return []; }
}
const SESSION_IDS = /local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const print = obj => process.stdout.write(JSON.stringify(obj));
const take = session => request('POST', '/api/take', { session }, 1500).then(r => r && r.message);

async function main() {
  const input = raw ? JSON.parse(raw) : {};
  const session = input.session_id;
  if (!session) return;

  switch (mode) {
    case 'start': {
      await ensureServer();
      await request('POST', '/api/hook/start', {
        session, cwd: input.cwd, pid: Number(process.env.CLAUDE_PID) || 0,
        hostId: process.env.CLAUDE_CODE_HOST_SESSION_ID || '', ancestors: ancestors(),
      });
      return;
    }
    case 'allow': // our own status tools only write to the local page, so don't prompt for them
      if (input.agent_id) { // a subagent shares the session id: keep it from replacing the main agent's page
        return print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
          permissionDecisionReason: 'Only the main agent updates the status page. Carry on with your task and report back to it.' } });
      }
      return print({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Status page update' } });

    case 'pre': // async: the agent is working
      await request('POST', '/api/hook/activity', { session, status: 'working' }, 800);
      return;
    case 'post': { // between steps: deliver edits
      if (OWN_TOOLS.test(input.tool_name || '')) return; // those results already carry edits
      if (input.agent_id) return; // edits are for the main agent; a subagent would swallow them
      if (/start_session$/.test(input.tool_name || '')) { // the desktop app started a side session for us
        const hostIds = [...new Set(JSON.stringify(input.tool_response || '').match(SESSION_IDS) || [])];
        if (hostIds.length) await request('POST', '/api/hook/started-session', { session, hostIds }, 1500).catch(() => {});
      }
      const message = await take(session);
      if (message) print({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message } });
      return;
    }
    case 'helper': { // the main agent is starting a subagent
      if (input.agent_id) return;
      const t = input.tool_input || {};
      await request('POST', '/api/hook/helper', { session, action: 'start', toolUseId: input.tool_use_id, type: t.subagent_type || 'general-purpose', text: t.description || '' }, 1500);
      return;
    }
    case 'substart':
      await request('POST', '/api/hook/helper', { session, action: 'bind', agentId: input.agent_id, type: input.agent_type }, 1500);
      return;
    case 'substop':
      await request('POST', '/api/hook/helper', { session, action: 'stop', agentId: input.agent_id }, 1500);
      return;
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
      if (unattended()) return; // print mode waits for background hooks, so a waiter would hang the run
      const r = await request('GET', `/api/wait?s=${encodeURIComponent(session)}`, undefined, 2 * 3600 * 1000);
      if (r && r.message) {
        process.stderr.write(r.message + '\n');
        process.exit(2);
      }
      return;
    }
  }
}
