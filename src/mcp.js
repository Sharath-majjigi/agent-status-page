#!/usr/bin/env node
// A dependency-free MCP server (stdio, JSON-RPC) with the few tools the agent
// uses to keep the status page current. Every tool result also carries any
// edits the user made on the page, so they arrive even without hooks.
'use strict';
const readline = require('readline');
const { call, ensureServer, pageUrl } = require('./client');

// Claude Code passes its session id to MCP servers; fall back to the parent pid,
// which the SessionStart hook maps to the same session.
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || `pid:${process.ppid}`;

const INSTRUCTIONS = `This session has a live status page the user watches and edits instead of asking you for updates.
For any task with three or more steps: call update_plan first (a short title and the remaining steps), set_now when you start each step, and record_decision for each meaningful choice (with an honest confidence). Keep it brief: one plain line each. Skip it for quick questions.
The user can edit the steps or override a decision on the page. Those edits reach you between steps and in tool results. Follow them.`;

const TOOLS = [
  {
    name: 'update_plan',
    description: 'Set the task title and the full ordered list of steps still to do (leave out finished ones). Call at the start of a multi-step task and whenever the plan changes, including after the user edits it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title, e.g. "Add rate limiting to the API"' },
        next: { type: 'array', items: { type: 'string' }, description: 'Remaining steps in order, starting with the one you are on now. One short line each. Drop a step once it is finished.' },
      },
      required: ['next'],
    },
  },
  {
    name: 'set_now',
    description: 'Say in one short line what you are doing right now, e.g. "Writing the migration for user sessions". Call when you start each step.',
    inputSchema: {
      type: 'object',
      properties: {
        doing: { type: 'string' },
        file: { type: 'string', description: 'Main file you are working in, if any' },
      },
      required: ['doing'],
    },
  },
  {
    name: 'record_decision',
    description: 'Record a meaningful choice you made (library, approach, trade-off, assumption), with a one-line reason. Use low confidence when the user may well want something else. Not for trivial steps.',
    inputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string', description: 'The choice, e.g. "Use SQLite for local storage"' },
        reason: { type: 'string', description: 'Why, in one line' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        supersedes: { type: 'string', description: 'Id of an earlier decision this replaces (e.g. after the user overrode it)' },
      },
      required: ['decision', 'reason', 'confidence'],
    },
  },
  {
    name: 'get_user_edits',
    description: 'Fetch edits the user made on the status page. They normally arrive on their own between steps, so you rarely need this.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function run(name, args) {
  const session = SESSION;
  let text = 'Done.';
  if (name === 'update_plan') {
    const r = await call('POST', '/api/agent/plan', { session, title: args.title, next: args.next });
    if (!r.accepted) return withShare(session, `Not applied: the user changed the plan first.\n\n${r.message}`);
  } else if (name === 'set_now') {
    await call('POST', '/api/agent/now', { session, doing: args.doing, file: args.file });
  } else if (name === 'record_decision') {
    const r = await call('POST', '/api/agent/decision', { session, ...args });
    text = `Recorded as ${r.id}.`;
  } else if (name === 'get_user_edits') {
    const r = await call('POST', '/api/take', { session });
    return r.message || 'No new edits from the user.';
  } else {
    throw new Error(`Unknown tool ${name}`);
  }
  const r = await call('POST', '/api/take', { session });
  if (r.message) text += `\n\n${r.message}`;
  return withShare(session, text);
}

// The first time the page has something on it, give the agent the link to pass on.
async function withShare(session, text) {
  try {
    const r = await call('POST', '/api/agent/shared', { session });
    if (r.first) {
      const id = session.startsWith('pid:') ? '' : session;
      text += `\n\nLive status page for this task: ${pageUrl(id)}\nShare this link with the user once, in your next message to them.`;
    }
  } catch {}
  return text;
}

// ---------- JSON-RPC over stdio ----------
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

ensureServer().catch(() => {});

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'status-page', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        try {
          const text = await run(params.name, params.arguments || {});
          return reply(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: `Status page unavailable: ${e.message}. Carry on with the task.` }], isError: true });
        }
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    fail(id, -32603, e.message);
  }
});
