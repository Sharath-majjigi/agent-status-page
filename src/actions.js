// What the agent can do to the status page. Used by the MCP tools and by the
// Bash fallback (cli.js). Every result also carries any edits the user made.
'use strict';
const { call, pageUrl } = require('./client');

async function run(session, name, args) {
  let text = 'Done.';
  if (name === 'update_plan') {
    const r = await call('POST', '/api/agent/plan', { session, title: args.title, next: args.next });
    if (!r.accepted) return withShare(session, `Not applied: the user changed the plan first.\n\n${r.message}`);
  } else if (name === 'set_now') {
    await call('POST', '/api/agent/now', { session, doing: args.doing });
  } else if (name === 'record_decision') {
    const r = await call('POST', '/api/agent/decision', { session, ...args });
    text = `Recorded as ${r.id}.`;
  } else if (name === 'followup_done') {
    await call('POST', '/api/agent/followup_done', { session, id: args.id });
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

module.exports = { run };
