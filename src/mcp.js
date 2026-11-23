#!/usr/bin/env node
// A dependency-free MCP server (stdio, JSON-RPC) with the few tools the agent
// uses to keep the status page current. Every tool result also carries any
// edits the user made on the page, so they arrive even without hooks.
'use strict';
const readline = require('readline');
const { call, ensureServer } = require('./client');
const { run: runAction } = require('./actions');

// Claude Code passes its session id to MCP servers; fall back to the parent pid,
// which the SessionStart hook maps to the same session.
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || `pid:${process.ppid}`;

const INSTRUCTIONS = `This session has a live status page the user watches and edits instead of asking you for updates.
For any task with three or more steps: call update_plan first (a short title and the remaining steps), set_now when you start each step, and record_decision for each meaningful choice (with an honest confidence). Keep it brief: one plain line each. When the task is done, call summarize_task once. Skip all of this for quick questions. (If you don't call update_plan, the page follows your own task list instead.)
The user can edit the steps, override a decision, or add a follow-up to a step on the page. Those edits reach you between steps and in tool results. Follow them, and call followup_done when you finish a follow-up.`;

const TOOLS = [
  {
    name: 'update_plan',
    description: 'Set the task title and the full ordered list of steps still to do (leave out finished ones). Call at the start of a multi-step task and whenever the plan changes, including after the user edits it. When you move on to a different task, give it a new title: the page files the previous task under Earlier.',
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
    name: 'summarize_task',
    description: 'When a task is finished, sum it up for the History page in plain everyday words, no jargon. Strict word limits; the page refuses longer text. Call once per task, before your final message.',
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', enum: ['Fixed', 'Added', 'Changed', 'Removed'] },
        headline: { type: 'string', description: 'What, in at most 5 words, read after the verb. E.g. verb Fixed + "push question"' },
        before: { type: 'string', description: 'How it was before, at most 6 words. E.g. "Button did nothing"' },
        after: { type: 'string', description: 'How it is now, at most 6 words. E.g. "Says answer in the chat"' },
        catch: { type: 'string', description: 'Optional: the one downside the user should know, at most 6 words. Leave out if none.' },
        open: { type: 'string', description: 'Optional: what the user should open to see the result, as a full file path or an http(s) link. E.g. "/Users/me/Desktop/game.html" or "http://localhost:3000". Leave out if nothing to open.' },
      },
      required: ['verb', 'headline', 'before', 'after'],
    },
  },
  {
    name: 'followup_done',
    description: 'Mark a follow-up the user added on the status page as done, once you have actually done it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The follow-up id, e.g. "f1"' } }, required: ['id'] },
  },
  {
    name: 'get_user_edits',
    description: 'Fetch edits the user made on the status page. They normally arrive on their own between steps, so you rarely need this.',
    inputSchema: { type: 'object', properties: {} },
  },
];


// ---------- JSON-RPC over stdio ----------
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

ensureServer().then(() => call('POST', '/api/agent/hello', { session: SESSION })).catch(() => {});

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
          const text = await runAction(SESSION, params.name, params.arguments || {});
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
