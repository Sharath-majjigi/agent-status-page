// The tiny local server: holds each session's status, serves the page,
// streams changes with server-sent events, and queues the user's edits
// until a hook (or a tool call) hands them to the running agent.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { HOME, PORT, HOST, APP, token } = require('./client');

const TOKEN = token();
const SESSIONS_DIR = path.join(HOME, 'sessions');
const PAUSED_DIR = path.join(HOME, 'paused');
fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(PAUSED_DIR, { recursive: true, mode: 0o700 });
const PAGE = path.join(__dirname, 'page.html');
const HISTORY_PAGE = path.join(__dirname, 'history.html');
const KEEP = 30 * 24 * 3600 * 1000; // sessions (and their history) are kept for a month

/** @type {Map<string, any>} */
const sessions = new Map();
const pidAlias = new Map(); // "pid:123" -> session id (fallback when the MCP server lacks the env var)
const subscribers = new Map(); // session id or '*' (latest) -> Set<res>
const waiters = new Map(); // session id -> res (a Stop hook waiting to wake the idle agent)
const permWaiters = new Map(); // permission request id -> { done, suggestions } (a PermissionRequest hook waiting for the page)
let lastRequest = Date.now();

const safeName = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
let seq = 0;
const newId = p => p + Date.now().toString(36) + (seq++).toString(36);

// ---------- persistence ----------
for (const f of fs.readdirSync(SESSIONS_DIR)) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    if (Date.now() - (s.updatedAt || 0) > KEEP) { fs.unlinkSync(path.join(SESSIONS_DIR, f)); continue; }
    if (s.status === 'working') s.status = 'idle';
    s.permissions = []; // a permission request only lives as long as its hook is waiting
    migrate(s);
    sessions.set(s.id, s);
  } catch {}
}
const saveTimers = new Map();
function save(s) {
  clearTimeout(saveTimers.get(s.id));
  saveTimers.set(s.id, setTimeout(() => {
    fs.writeFile(path.join(SESSIONS_DIR, safeName(s.id) + '.json'), JSON.stringify(s), { mode: 0o600 }, () => {});
  }, 250));
}

// ---------- state ----------

function blank(id) {
  return {
    id, title: '', cwd: '', pid: 0, status: 'idle', updatedAt: Date.now(), touchedAt: 0,
    now: { text: '', at: 0 },
    decisions: [],
    next: [], agentNext: [], done: [],
    followups: [], children: [], hostId: '', parent: null, stepStartedAt: 0, taskStartedAt: 0,
    pending: { plan: null, overrides: [], followups: [], answer: null },
    question: null, // { id, text, options, at, state: 'open' | 'sent' | 'received', answer } when Claude asked the user something
    edits: { state: 'none', at: 0 },
    shared: false,
    earlier: [],
    pause: null, // { state: 'asked' | 'told' | 'paused', at, idle } while the user has paused the task
    resume: false, // tell the agent it was resumed, with the next edits
  };
}
function get(id) {
  if (!id) throw Object.assign(new Error('missing session'), { code: 400 });
  id = pidAlias.get(id) || id;
  if (!sessions.has(id)) sessions.set(id, blank(id));
  const s = sessions.get(id);
  migrate(s);
  return s;
}
// Sessions saved by older versions lack the newer fields.
function migrate(s) {
  s.done = s.done || []; s.earlier = s.earlier || [];
  s.followups = s.followups || []; s.children = s.children || [];
  delete s.helpers; // subagents are no longer shown
  s.pending = s.pending || { plan: null, overrides: [] };
  s.pending.followups = s.pending.followups || [];
  if (s.pending.answer === undefined) s.pending.answer = null;
  if (s.question === undefined) s.question = null;
  s.permissions = s.permissions || [];
  for (const d of s.done) if (!d.id) d.id = newId('n');
  if (s.now) delete s.now.file; // file names are no longer shown
  if (s.pause === undefined) s.pause = null;
  s.resume = !!s.resume;
  gate(s);
}
const hasPending = s => !!(s.pending.plan || s.pending.overrides.length || s.pending.followups.length || s.pending.answer);
const currentStepId = s => (s.next[0] && s.next[0].id) || (s.done.length ? s.done[s.done.length - 1].id : null);
function latest() {
  let best = null;
  for (const s of sessions.values()) if (s.touchedAt && (!best || s.touchedAt > best.touchedAt)) best = s;
  return best;
}
function view(s) {
  if (!s) return null;
  const { pending, agentNext, pid, resume, earlier, tasks, ...rest } = s; // past tasks are on the history page
  rest.children = s.children.map(c => ({ ...c, ...childInfo(c) }));
  const parent = s.parent && sessions.get(s.parent);
  rest.parent = parent ? { id: parent.id, title: parent.title } : null;
  return rest;
}
function childInfo(c) {
  const x = findChild(c);
  return x ? { id: x.id, title: x.title, status: x.status, done: x.done.length, total: x.done.length + x.next.length }
    : { id: null, title: c.title || '', status: c.status === 'ended' ? 'ended' : 'starting', done: c.done || 0, total: c.total || 0 };
}
function findChild(c) {
  if (c.sessionId) return sessions.get(c.sessionId) || null;
  if (c.hostId) for (const x of sessions.values()) if (x.hostId === c.hostId) return x;
  return null;
}
// A side session changed: its parent's page shows its progress, so refresh that too.
function parentsOf(s) {
  const out = [];
  for (const x of sessions.values()) if (x !== s && x.children.some(c => c.sessionId === s.id || (s.hostId && c.hostId === s.hostId))) out.push(x);
  return out;
}
function changed(s, { touch = false } = {}) {
  s.updatedAt = Date.now();
  if (touch) s.touchedAt = s.updatedAt;
  save(s);
  broadcast(s);
  for (const p of parentsOf(s)) broadcast(p);
}
function broadcast(s) {
  const msg = `event: state\ndata: ${JSON.stringify(view(s))}\n\n`;
  for (const res of subscribers.get(s.id) || []) res.write(msg);
  if (latest() === s) for (const res of subscribers.get('*') || []) res.write(msg);
}

const short = (t, n = 200) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const q = t => `“${t}”`;

// Turn whatever the user changed into one plain message for the agent, and mark it received.
function takeEdits(s) {
  const plan = s.pending.plan;
  const overrides = s.pending.overrides.map(id => s.decisions.find(d => d.id === id)).filter(Boolean);
  const followups = s.pending.followups.map(id => s.followups.find(f => f.id === id)).filter(Boolean);
  const answer = s.pending.answer && s.question ? s.pending.answer : null;
  if (!plan && !overrides.length && !followups.length && !answer) return null;
  const lines = [];
  if (answer) {
    lines.push('The user answered your question on the status page.', '', `You asked: ${q(s.question.text)}`, `They answered: ${q(answer)}`, '',
      'This is the user\'s reply, given on the page instead of the chat. Carry on accordingly.');
    s.question.state = 'received'; s.question.receivedAt = Date.now();
  }
  if (!plan && !overrides.length && !followups.length) {
    s.pending.answer = null;
    s.edits = { state: 'received', at: Date.now() };
    changed(s);
    return lines.join('\n');
  }
  if (answer) lines.push('');
  lines.push('Update from the user, made on the status page while you were working:', '');
  for (const d of overrides) {
    lines.push(`- The user overrode your decision ${q(d.text)} (id ${d.id}). In their words: ${q(d.override.text)}`);
    d.override.state = 'received';
    d.override.receivedAt = Date.now();
  }
  for (const f of followups) {
    lines.push(`- The user added a follow-up (id ${f.id}) ${whereFollowup(s, f)}: ${q(f.text)}`);
    f.state = 'received';
  }
  if (plan) {
    lines.push(`- The user edited your next steps: ${plan.summary}.`);
    lines.push('  Next up is now:');
    s.next.forEach((n, i) => lines.push(`  ${i + 1}. ${n.text}`));
    if (!s.next.length) lines.push('  (nothing: the user removed all remaining steps)');
  }
  lines.push('', 'Follow the user\'s version from here and re-plan if needed. Then call update_plan so the page matches'
    + (overrides.length ? ', and record_decision with `supersedes` set to the overridden id' : '')
    + (followups.length ? '. When you finish a follow-up, call followup_done with its id.' : '.'));
  s.pending = { plan: null, overrides: [], followups: [], answer: null };
  s.edits = { state: 'received', at: Date.now() };
  changed(s);
  return lines.join('\n');
}

const PAUSE_MESSAGE = 'The user paused this task on the status page. Stop here: make no more tool calls, and end your turn with one short line saying where you paused. You will be resumed later.';
const RESUME_MESSAGE = 'The user resumed this task on the status page. Carry on from where you paused.';

// What the agent should hear next. While paused, only the pause itself; edits wait for the resume.
// The page is only as current as the agent's task list. If the step in progress hasn't moved for a while
// although the agent keeps working, remind it once to update the list.
const NUDGE_AFTER = 90 * 1000, NUDGE_TOOLS = 6;
function staleNudge(s) {
  if (s.status !== 'working' || s.next.length < 2 || !s.planAt || s.pause) return null;
  const now = Date.now();
  if (now - s.planAt < NUDGE_AFTER || (s.toolCalls || 0) - (s.planToolMark || 0) < NUDGE_TOOLS || now - (s.nudgedAt || 0) < NUDGE_AFTER) return null;
  s.nudgedAt = now;
  const mins = Math.round((now - s.planAt) / 60000);
  return `Status page: your task list has shown ${q(s.next[0].text)} as the step in progress for ${mins} minutes. `
    + 'If you have finished it (or more), update your task list now so the page shows where you are. If you are still on it, carry on.';
}
// Any plan update (the agent's own list or update_plan) resets the reminder.
function planTouched(s) { s.planAt = Date.now(); s.planToolMark = s.toolCalls || 0; }

function takeFor(s, { stopping = false, prompt = false, between = false } = {}) {
  if (prompt && (s.pause || s.resume)) { s.pause = null; s.resume = false; gate(s); changed(s); } // typing in Claude Code resumes
  if (s.pause) {
    if (stopping) { s.pause.state = 'paused'; changed(s); return null; }
    if (s.pause.state !== 'asked') return null;
    s.pause.state = 'told';
    changed(s);
    return PAUSE_MESSAGE;
  }
  const edits = takeEdits(s);
  if (!s.resume) return edits || (between ? staleNudge(s) : null);
  s.resume = false;
  changed(s);
  return edits ? `${RESUME_MESSAGE}\n\n${edits}` : RESUME_MESSAGE;
}

// A file per paused session, so the PreToolUse gate can check it without a network call.
function gate(s) {
  const file = path.join(PAUSED_DIR, safeName(s.id));
  try { s.pause ? fs.writeFileSync(file, '', { mode: 0o600 }) : fs.rmSync(file, { force: true }); } catch {}
}

function whereFollowup(s, f) {
  const done = s.done.find(d => d.id === f.stepId);
  if (done) return `on the finished step ${q(done.text)}. Go back and do it after your current step`;
  const i = s.next.findIndex(n => n.id === f.stepId);
  if (i === 0 && s.status === 'working') return `on your current step ${q(s.next[0].text)}. Do it as part of this step`;
  if (i >= 0) return `on the step ${q(s.next[i].text)}. Do it as part of that step`;
  return 'for this task. Do it after your current step';
}
function describePlanChange(before, after) {
  const beforeIds = new Map(before.map(n => [n.id, n]));
  const afterIds = new Set(after.map(n => n.id));
  const parts = [];
  for (const n of after) {
    const old = beforeIds.get(n.id);
    if (!old) parts.push(`added ${q(n.text)}`);
    else if (old.text !== n.text) parts.push(`changed ${q(old.text)} to ${q(n.text)}`);
  }
  for (const n of before) if (!afterIds.has(n.id)) parts.push(`removed ${q(n.text)}`);
  const common = after.filter(n => beforeIds.has(n.id)).map(n => n.id);
  const commonBefore = before.filter(n => afterIds.has(n.id)).map(n => n.id);
  if (common.join() !== commonBefore.join()) parts.push('reordered the steps');
  return parts.join('; ');
}

// ---------- agent side (MCP server + hooks) ----------
function agentUpdatePlan(s, { title, next }) {
  if (s.pending.plan) return { accepted: false, message: takeEdits(s) };
  const newTitle = typeof title === 'string' && title.trim() ? short(title, 120) : '';
  if (newTitle && isNewTask(s, newTitle, next)) archiveTask(s);
  if (newTitle) s.title = newTitle;
  beginTask(s);
  planTouched(s);
  if (Array.isArray(next)) {
    const before = s.next[0] && s.next[0].id;
    markDone(s, next.map(t => short(t)).filter(Boolean));
    const pool = [...s.next];
    s.next = next.map(t => short(t)).filter(Boolean).map(text => {
      const i = pool.findIndex(n => n.text === text);
      if (i < 0) return { id: newId('n'), text };
      const o = pool.splice(i, 1)[0];
      return o.edited ? { id: o.id, text, edited: true } : { id: o.id, text }; // the user's steps stay marked as theirs
    });
    s.agentNext = s.next.map(n => ({ ...n }));
    if (!s.stepStartedAt || (s.next[0] && s.next[0].id) !== before) s.stepStartedAt = Date.now();
  }
  // The agent re-planned after receiving the user's edits.
  if (s.edits.state === 'received') {
    s.edits = { state: 'none', at: Date.now() };
    for (const d of s.decisions) if (d.override && d.override.state === 'received') d.override.state = 'applied';
  }
  changed(s, { touch: true });
  return { accepted: true };
}
// ---------- the agent's own task list ----------
// Agents keep a task list anyway (the desktop app's task list, TodoWrite in the terminal).
// The hooks pass each update here and the page follows it, so it fills in even when the
// agent never calls the status tools. If the agent did call update_plan since the user's
// last message, its own plan wins.
const TASK_STATES = new Set(['pending', 'in_progress', 'completed']);
// The user's own words from a prompt: apps add tagged blocks (reminders, events) around them.
// The user's own words, without the tagged blocks the app adds. Line breaks stay: a title ends at the first one.
const userWords = t => String(t).replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/[^\S\n]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim();
// A task title from the user's message, if it reads like a request ("Yes, build it" doesn't).
function titleFrom(prompt) {
  const first = String(prompt || '').split(/(?<=[.?!])\s|\n/)[0].trim();
  if (first.split(/\s+/).length < 4) return '';
  const t = first.replace(/[.?!]+$/, '');
  return (t.length > 70 ? t.slice(0, 69).replace(/\s+\S*$/, '') + '…' : t).replace(/^./, c => c.toUpperCase());
}
function readTaskList(input, prev) {
  const full = Array.isArray(input.todos) ? input.todos : Array.isArray(input.items) ? input.items : null;
  if (full) {
    const list = full.map(t => ({ text: short(t && t.content, 200), status: TASK_STATES.has(t && t.status) ? t.status : 'pending' })).filter(t => t.text);
    return list.length ? { list, full: true } : null;
  }
  if (!prev || !prev.length) return null; // a partial update needs the list it updates
  const list = prev.map(t => ({ ...t }));
  if (input.advance) {
    const cur = list.findIndex(t => t.status === 'in_progress');
    if (cur >= 0) list[cur].status = 'completed';
    const nxt = list.findIndex(t => t.status === 'pending');
    if (nxt >= 0) list[nxt].status = 'in_progress';
  }
  for (const n of Array.isArray(input.done) ? input.done : []) if (list[n - 1]) list[n - 1].status = 'completed';
  if (Number.isInteger(input.start) && list[input.start - 1]) list[input.start - 1].status = 'in_progress';
  return { list, full: false };
}
function hookTasks(s, input) {
  const r = readTaskList(input || {}, s.tasks);
  if (!r) return;
  s.tasks = r.list;
  if (s.ownPlanAt && s.ownPlanAt > (s.promptAt || 0)) return; // the agent keeps the page itself
  if (s.pending.plan) return; // the user's edit goes first; the agent re-plans from it
  const texts = r.list.map(t => t.text);
  const current = [...s.done, ...s.next];
  // A different list is a new task. So is a fresh list after the user's next message once the last task is finished.
  const fresh = (s.promptAt || 0) > (s.tasksAt || 0) && !s.next.length && r.list.some(t => t.status !== 'completed');
  if (r.full && current.length && !hasPending(s) && (!sameTask(s, texts) || fresh)) archiveTask(s);
  beginTask(s);
  s.tasksAt = Date.now();
  planTouched(s);
  if (!s.title || !s.done.length && !s.next.length) s.title = (s.promptTitle !== undefined ? s.promptTitle : titleFrom(s.lastPrompt)) || texts[0];
  const known = new Map([...s.done, ...s.next].map(x => [x.text, x]));
  const wasFirst = s.next[0] && s.next[0].id;
  s.done = r.list.filter(t => t.status === 'completed').map(t => {
    const o = known.get(t.text);
    if (o && o.at) return o; // already done
    return { id: (o && o.id) || newId('n'), text: t.text, at: Date.now(), took: o && o.id === wasFirst && s.stepStartedAt ? Date.now() - s.stepStartedAt : null, ...(o && o.edited ? { edited: true } : {}) };
  });
  // In progress first, then the rest in order.
  const open = r.list.filter(t => t.status !== 'completed').sort((a, b) => (b.status === 'in_progress') - (a.status === 'in_progress'));
  s.next = open.map(t => { const o = known.get(t.text) || {}; return { id: o.id || newId('n'), text: t.text, ...(o.edited ? { edited: true } : {}) }; });
  s.agentNext = s.next.map(n => ({ ...n }));
  if ((s.next[0] && s.next[0].id) !== wasFirst) s.stepStartedAt = Date.now();
  if (s.edits.state === 'received') s.edits = { state: 'none', at: Date.now() };
  changed(s, { touch: true });
}

// A new title with none of the current steps in it means the agent moved on to another task.
// (A renamed title over the same steps is the same task. Unsent overrides keep the task open.)
function isNewTask(s, newTitle, next) {
  if (!s.title || newTitle === s.title || hasPending(s)) return false;
  if (!s.done.length && !s.decisions.length && !s.next.length) return false;
  const texts = (Array.isArray(next) ? next : []).map(t => short(t)).filter(Boolean);
  return !texts.length || !sameTask(s, texts);
}
// A list is the same task when at least half of its steps are already on the map.
// (One shared step like "Commit" doesn't make two tasks the same.)
function sameTask(s, texts) {
  const have = new Set([...s.done, ...s.next].map(x => x.text));
  return texts.filter(t => have.has(t)).length * 2 >= texts.length;
}
// The first plan of a task marks when it started (shown in history).
function beginTask(s) {
  if (!s.taskStartedAt || (!s.done.length && !s.next.length && !s.decisions.length)) s.taskStartedAt = Date.now();
}
// Move the finished task into Earlier, so the page shows only the current one.
function archiveTask(s) {
  s.earlier = s.earlier || [];
  // Side sessions go with their task, unless they're still running.
  const running = c => { const x = findChild(c); return !x || x.status === 'working'; };
  const children = s.children.filter(c => !running(c)).map(c => ({ ...c, ...childInfo(c) }));
  s.children = s.children.filter(running);
  s.earlier.unshift({
    id: newId('t'), title: s.title, startedAt: s.taskStartedAt || null, endedAt: Date.now(),
    done: s.done, dropped: s.next.map(n => n.text), decisions: s.decisions, followups: s.followups, children,
  });
  if (s.earlier.length > 40) s.earlier.length = 40;
  s.taskStartedAt = 0;
  s.done = []; s.next = []; s.agentNext = []; s.decisions = []; s.followups = [];
  s.now = { text: '', at: 0 };
  s.edits = { state: 'none', at: Date.now() };
}
// Steps the agent dropped from the front of its list are finished.
// (A full rewrite with no overlap is a re-plan, not progress; an empty list means all done.)
function markDone(s, nextTexts) {
  const keep = new Set(nextTexts);
  const firstKept = s.next.findIndex(n => keep.has(n.text));
  const finished = firstKept === -1 ? (nextTexts.length ? [] : s.next) : s.next.slice(0, firstKept);
  finished.filter(n => !keep.has(n.text)).forEach((n, k) => s.done.push({
    id: n.id, text: n.text, at: Date.now(), ...(n.edited ? { edited: true } : {}),
    took: k === 0 && s.stepStartedAt ? Date.now() - s.stepStartedAt : null, // only the step that was in progress has a real duration
  }));
  if (s.done.length > 100) s.done = s.done.slice(-100);
}
function agentSetNow(s, { doing }) {
  s.now = { text: short(doing, 160), at: Date.now() };
  s.status = 'working';
  changed(s, { touch: true });
}
function agentDecision(s, { decision, reason, confidence, supersedes }) {
  const conf = ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium';
  s.dseq = Math.max(s.dseq || 0, s.decisions.length) + 1; // ids stay unique across tasks
  const d = { id: 'd' + s.dseq, text: short(decision, 160), reason: short(reason, 240), confidence: conf, at: Date.now(), override: null, supersedes: null, stepId: currentStepId(s) };
  const old = supersedes && s.decisions.find(x => x.id === supersedes);
  if (old) {
    d.supersedes = old.id;
    if (old.override) old.override.state = 'applied';
  }
  s.decisions.push(d);
  changed(s, { touch: true });
  return d.id;
}
function agentFollowupDone(s, id) {
  const f = s.followups.find(x => x.id === String(id));
  if (!f) throw Object.assign(new Error(`No follow-up with id ${id}`), { code: 404 });
  f.state = 'done'; f.doneAt = Date.now();
  s.pending.followups = s.pending.followups.filter(x => x !== f.id);
  changed(s, { touch: true });
}
// The parent started a side session (desktop) or launched claude from its shell (seen by the child).
function linkChild(parent, link) {
  const dupe = parent.children.some(c => (link.hostId && c.hostId === link.hostId) || (link.sessionId && c.sessionId === link.sessionId));
  if (dupe || (link.hostId && link.hostId === parent.hostId) || link.sessionId === parent.id) return;
  parent.children.push({ ...link, stepId: currentStepId(parent), at: Date.now() });
  if (parent.children.length > 30) parent.children = parent.children.slice(-30);
  changed(parent);
}

// Claude ended its turn with a question (the desktop app's next-step box). The page shows it with the same buttons.
function hookQuestion(s, input) {
  // Wrapping up checks off the whole task list in the app, without another task-list update: do the same here.
  if (Array.isArray(s.tasks) && s.tasks.some(t => t.status !== 'completed'))
    hookTasks(s, { items: s.tasks.map(t => ({ content: t.text, status: 'completed' })) });
  const ask = short(input && input.ask, 300);
  if (!ask) { if (s.question && s.question.state !== 'sent') { s.question = null; changed(s); } return; } // the turn ended with nothing to ask
  const options = (Array.isArray(input.actions) ? input.actions : []).filter(a => a && !a.action && a.label).map(a => short(a.label, 40)).slice(0, 3);
  s.question = { id: newId('q'), text: ask, options, at: Date.now(), state: 'open', answer: null };
  s.pending.answer = null;
  changed(s, { touch: true });
}

// ---------- permission prompts, answered on the page ----------
// Claude Code is about to ask the user to allow a tool call. If the page is open, ask there instead;
// the click goes back as Claude Code's own permission decision. Nobody looking: Claude Code asks as usual.
const PERM_WAIT = 10 * 60 * 1000;
const viewers = s => (subscribers.get(s.id)?.size || 0) + (latest() === s ? (subscribers.get('*')?.size || 0) : 0);
function describeTool(name, input) {
  const base = p => String(p || '').split('/').filter(Boolean).pop() || '';
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (name === 'Bash') return { title: input.description ? short(input.description, 140) : 'Run a command', detail: String(input.command || '').slice(0, 2000) };
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) return { title: `${name === 'Write' ? 'Write' : 'Edit'} ${base(input.file_path || input.notebook_path)}`, detail: String(input.file_path || input.notebook_path || '') };
  if (name === 'WebFetch') return { title: 'Open a web page', detail: String(input.url || '') };
  if (name === 'WebSearch') return { title: 'Search the web', detail: String(input.query || '') };
  if (mcp) return { title: `Use ${mcp[2].replace(/[_-]+/g, ' ')}`, detail: mcp[1].replace(/^plugin_/, '').replace(/[_-]+/g, ' ') };
  return { title: `Use ${name}`, detail: short(JSON.stringify(input), 400) };
}
function hookPermission(s, body, res) {
  if (!viewers(s)) return send(res, 200, { decision: null });
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
  const p = { id: newId('p'), tool: short(body.tool, 120), ...describeTool(String(body.tool || ''), body.input || {}), always: suggestions.length > 0, at: Date.now() };
  s.permissions.push(p);
  changed(s, { touch: true });
  const done = decision => {
    if (!permWaiters.has(p.id)) return;
    clearTimeout(permWaiters.get(p.id).timer);
    permWaiters.delete(p.id);
    s.permissions = s.permissions.filter(x => x.id !== p.id);
    changed(s);
    if (!res.writableEnded) send(res, 200, { decision });
  };
  permWaiters.set(p.id, { done, suggestions, timer: setTimeout(() => done(null), PERM_WAIT) }); // then Claude Code asks as usual
  res.on('close', () => done(null)); // the hook went away (turn interrupted, timed out)
}
function userPermission(s, id, behavior, always) {
  const w = permWaiters.get(id);
  if (!w || !s.permissions.some(p => p.id === id)) throw Object.assign(new Error('That request is no longer waiting'), { code: 409 });
  if (behavior === 'allow') w.done({ behavior: 'allow', ...(always && w.suggestions.length ? { updatedPermissions: w.suggestions } : {}) });
  else w.done({ behavior: 'deny', message: 'The user denied this on the status page.' });
}

// ---------- user side (the page) ----------
function userAnswer(s, id, text) {
  if (!s.question || s.question.id !== id || s.question.state !== 'open') throw Object.assign(new Error('That question is no longer open'), { code: 409 });
  text = short(text, 500);
  if (!text) throw Object.assign(new Error('Empty answer'), { code: 400 });
  s.question.answer = text; s.question.state = 'sent'; s.question.sentAt = Date.now();
  s.pending.answer = text;
  s.edits = { state: 'waiting', at: Date.now() };
  changed(s, { touch: true });
  wakeIfIdle(s);
}
function userEditPlan(s, items) {
  const clean = (Array.isArray(items) ? items : []).slice(0, 100)
    .map(n => ({ id: typeof n.id === 'string' && n.id ? n.id : newId('n'), text: short(n.text) }))
    .filter(n => n.text);
  const base = s.agentNext;
  s.next = clean.map(n => {
    const orig = base.find(b => b.id === n.id);
    return { ...n, edited: !orig || orig.text !== n.text };
  });
  const summary = describePlanChange(base, s.next);
  s.pending.plan = summary ? { summary } : null;
  s.edits = { state: hasPending(s) ? 'waiting' : 'none', at: Date.now() };
  changed(s, { touch: true });
  wakeIfIdle(s);
}
function userOverride(s, id, text) {
  const d = s.decisions.find(x => x.id === id);
  if (!d) throw Object.assign(new Error('no such decision'), { code: 404 });
  text = short(text, 400);
  if (!text) {
    d.override = null;
    s.pending.overrides = s.pending.overrides.filter(x => x !== id);
  } else {
    d.override = { text, at: Date.now(), state: 'waiting' };
    if (!s.pending.overrides.includes(id)) s.pending.overrides.push(id);
  }
  s.edits = { state: hasPending(s) ? 'waiting' : 'none', at: Date.now() };
  changed(s, { touch: true });
  wakeIfIdle(s);
}
function userFollowup(s, stepId, text) {
  text = short(text, 300);
  if (!text) throw Object.assign(new Error('empty follow-up'), { code: 400 });
  s.fseq = (s.fseq || 0) + 1;
  const f = { id: 'f' + s.fseq, stepId: String(stepId || currentStepId(s) || ''), text, state: 'waiting', at: Date.now() };
  s.followups.push(f);
  s.pending.followups.push(f.id);
  s.edits = { state: 'waiting', at: Date.now() };
  changed(s, { touch: true });
  wakeIfIdle(s);
}
function userRemoveFollowup(s, id) {
  const f = s.followups.find(x => x.id === String(id));
  if (!f || f.state !== 'waiting') return; // once the agent has it, it stays
  s.followups = s.followups.filter(x => x !== f);
  s.pending.followups = s.pending.followups.filter(x => x !== f.id);
  s.edits = { state: hasPending(s) ? 'waiting' : 'none', at: Date.now() };
  changed(s, { touch: true });
}

function userPause(s) {
  if (s.pause || s.status === 'ended') return;
  const idle = s.status !== 'working';
  s.pause = { state: idle ? 'paused' : 'asked', at: Date.now(), idle };
  s.resume = false;
  gate(s);
  changed(s, { touch: true });
}
function userResume(s) {
  if (!s.pause) return;
  s.resume = !s.pause.idle; // it stopped because of the pause: tell it to carry on
  s.pause = null;
  gate(s);
  changed(s, { touch: true });
  wakeIfIdle(s);
}

// When the agent has stopped, a Stop hook may be waiting on us; hand it the edits so it wakes the agent.
function wakeIfIdle(s) {
  const w = waiters.get(s.id);
  if (!w || s.status === 'working' || s.pause) return;
  const message = takeFor(s);
  if (!message) return;
  waiters.delete(s.id);
  s.status = 'working';
  changed(s);
  w.end(JSON.stringify({ message }));
}
function releaseWaiter(id) {
  const w = waiters.get(id);
  if (w) { waiters.delete(id); w.end(JSON.stringify({ message: null })); }
}

// Mark sessions whose Claude Code process is gone.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.pid || s.status === 'ended') continue;
    try { process.kill(s.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') {
        s.status = 'ended';
        s.pause = null; s.resume = false; gate(s);
        releaseWaiter(s.id); changed(s);
      }
    }
  }
  // Exit when nothing has used the server for a day; the next session starts it again.
  const listeners = [...subscribers.values()].reduce((a, set) => a + set.size, 0);
  if (!listeners && Date.now() - lastRequest > 24 * 3600 * 1000) process.exit(0);
}, 15000).unref();

// ---------- history ----------
// Every finished task from every session, newest first, for the read-only history page.
function historyList() {
  const out = [];
  const first = t => Math.min(...[t.endedAt, ...t.done.map(d => d.at - (d.took || 0)), ...t.decisions.map(d => d.at), ...t.followups.map(f => f.at)].filter(Number.isFinite));
  const add = (s, t, key) => out.push({
    key, session: s.id, project: (s.cwd || '').split('/').filter(Boolean).pop() || '',
    title: t.title || 'Untitled task', startedAt: t.startedAt || first(t), endedAt: t.endedAt,
    done: t.done, dropped: t.dropped, decisions: t.decisions, followups: t.followups,
    children: (t.children || []).map(c => ({ ...c, ...childInfo(c) })),
  });
  for (const s of sessions.values()) {
    for (const t of s.earlier || []) add(s, t, t.id);
    // The task on the map counts once it's over: all steps done, or the session ended.
    const over = s.done.length && s.status !== 'working' && (!s.next.length || s.status === 'ended');
    if (over) add(s, { title: s.title, startedAt: s.taskStartedAt, endedAt: Math.max(...s.done.map(d => d.at), ...s.decisions.map(d => d.at)),
      done: s.done, dropped: s.next.map(n => n.text), decisions: s.decisions, followups: s.followups,
      children: s.children.filter(c => { const x = findChild(c); return x && x.status !== 'working'; }) }, 'now-' + s.id);
  }
  return out.sort((a, b) => b.endedAt - a.endedAt);
}

// ---------- http ----------
function okToken(t) {
  if (typeof t !== 'string' || t.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', d => { raw += d; if (raw.length > 256 * 1024) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); } });
  });
}

const server = http.createServer(async (req, res) => {
  lastRequest = Date.now();
  try {
    // Only answer requests addressed to this machine by name (blocks DNS-rebinding tricks).
    const host = String(req.headers.host || '');
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return send(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, `http://${host}`);
    const p = url.pathname;

    if (p === '/health') return send(res, 200, { app: APP });

    const t = req.headers['x-token'] || url.searchParams.get('t');
    if (!okToken(t)) {
      if (p === '/') return send(res, 403, 'Open the link Claude gave you. It includes a private token.', 'text/plain; charset=utf-8');
      return send(res, 403, { error: 'bad token' });
    }

    if (req.method === 'GET' && (p === '/' || p === '/history')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return fs.createReadStream(p === '/' ? PAGE : HISTORY_PAGE).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/history') return send(res, 200, { tasks: historyList() });

    if (req.method === 'GET' && p === '/api/events') {
      const sid = url.searchParams.get('s') || '*';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      if (!subscribers.has(sid)) subscribers.set(sid, new Set());
      subscribers.get(sid).add(res);
      const s = sid === '*' ? latest() : sessions.get(pidAlias.get(sid) || sid);
      res.write(`event: state\ndata: ${JSON.stringify(view(s))}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); subscribers.get(sid)?.delete(res); });
      return;
    }

    if (req.method === 'GET' && p === '/api/wait') {
      // Long-poll used by the Stop hook: resolves with the user's edits, or null when no longer needed.
      const s = get(url.searchParams.get('s'));
      releaseWaiter(s.id);
      if (s.pause) { if (s.pause.state !== 'paused') { s.pause.state = 'paused'; changed(s); } }
      else {
        const message = takeFor(s);
        if (message) return send(res, 200, { message });
      }
      waiters.set(s.id, res);
      req.on('close', () => { if (waiters.get(s.id) === res) waiters.delete(s.id); });
      return;
    }

    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    // A browser can't add this header to a cross-site form post, so page writes need it.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
    const body = await readBody(req);
    if (p === '/api/diagnose') { // for /status-page:open: why might this session's page be empty? (never creates a session)
      const x = sessions.get(pidAlias.get(String(body.session)) || String(body.session));
      return send(res, 200, { hooks: !!(x && (x.hookAt || x.cwd)), tools: !!(x && x.toolsAt), task: !!(x && (x.title || x.next.length || x.done.length)) });
    }
    const s = p.startsWith('/api/') ? get(body.session) : null;

    switch (p) {
      case '/api/hook/start': {
        if (!body.cli) s.hookAt = Date.now(); // the Bash fallback registers too, but isn't a hook
        s.cwd = String(body.cwd || s.cwd);
        if (body.pid) { s.pid = Number(body.pid); pidAlias.set('pid:' + s.pid, s.id); }
        if (body.hostId) s.hostId = String(body.hostId);
        if (s.status === 'ended') s.status = 'idle';
        // Launched from another session's shell? Its Claude process is one of our ancestors.
        const ancestors = (Array.isArray(body.ancestors) ? body.ancestors : []).map(Number).filter(Boolean);
        if (!s.parent && ancestors.length) {
          const parent = [...sessions.values()].find(x => x !== s && x.pid && ancestors.includes(x.pid) && x.status !== 'ended');
          if (parent) { s.parent = parent.id; linkChild(parent, { sessionId: s.id }); }
        }
        if (!s.parent && s.hostId) {
          const parent = [...sessions.values()].find(x => x !== s && x.children.some(c => c.hostId === s.hostId));
          if (parent) s.parent = parent.id;
        }
        changed(s);
        return send(res, 200, { ok: true });
      }
      case '/api/hook/started-session': {
        for (const hostId of (Array.isArray(body.hostIds) ? body.hostIds : []).map(String)) {
          linkChild(s, { hostId });
          const child = findChild({ hostId });
          if (child && !child.parent) { child.parent = s.id; changed(child); }
        }
        return send(res, 200, { ok: true });
      }
      case '/api/agent/followup_done':
        agentFollowupDone(s, body.id);
        return send(res, 200, { ok: true });
      case '/api/hook/permission':
        return hookPermission(s, body, res);
      case '/api/user/permission':
        userPermission(s, String(body.id || ''), body.behavior === 'allow' ? 'allow' : 'deny', !!body.always);
        return send(res, 200, view(s));
      case '/api/hook/question':
        hookQuestion(s, body.input);
        return send(res, 200, { ok: true });
      case '/api/user/answer':
        userAnswer(s, String(body.id || ''), body.text);
        return send(res, 200, view(s));
      case '/api/user/followup':
        userFollowup(s, body.stepId, body.text);
        return send(res, 200, view(s));
      case '/api/user/followup/remove':
        userRemoveFollowup(s, body.id);
        return send(res, 200, view(s));
      case '/api/hook/activity':
        s.hookAt = Date.now();
        const said = typeof body.prompt === 'string' ? userWords(body.prompt) : '';
        // Automated turns (background-task notices, other sessions' messages) aren't the user talking.
        const fromUser = said && !/^(\[SYSTEM NOTIFICATION|<(task-notification|side-sessions-event|cross-session-message|ci-monitor-event)\b)/i.test(said);
        if (body.tool) s.toolCalls = (s.toolCalls || 0) + 1;
        if (fromUser && s.question) { s.question = null; s.pending.answer = null; } // answered (or moved on) in the chat
        if (fromUser && !said.startsWith('/')) {
          s.lastPrompt = short(said, 200); s.promptTitle = titleFrom(said); s.promptAt = Date.now(); // shown while the agent hasn't said what it's doing
          if (!s.next.length) { s.now = { text: '', at: 0 }; s.stepStartedAt = Date.now(); } // the last task is over: drop its activity, time from this message
        }
        // The turn ended without a new next-step box, so the app still shows the old question: so does the page.
        if (body.status === 'idle' && s.question && s.question.state === 'received') Object.assign(s.question, { state: 'open', unheard: s.question.answer, answer: null });
        if (body.status) {
          s.status = body.status;
          if (body.status === 'working') releaseWaiter(s.id);
        }
        changed(s);
        return send(res, 200, { ok: true });
      case '/api/agent/hello': // the MCP server started for this session, so the agent has the tools
        s.toolsAt = Date.now(); save(s);
        return send(res, 200, { ok: true });
      case '/api/take':
        return send(res, 200, { message: takeFor(s, { stopping: !!body.stopping, prompt: !!body.prompt, between: !!body.between }) });
      case '/api/user/pause':
        userPause(s);
        return send(res, 200, view(s));
      case '/api/user/resume':
        userResume(s);
        return send(res, 200, view(s));
      case '/api/agent/plan':
        s.ownPlanAt = Date.now();
        return send(res, 200, agentUpdatePlan(s, body));
      case '/api/hook/tasks':
        hookTasks(s, body.input);
        return send(res, 200, { ok: true });
      case '/api/agent/now':
        agentSetNow(s, body);
        return send(res, 200, { ok: true });
      case '/api/agent/decision':
        return send(res, 200, { id: agentDecision(s, body) });
      case '/api/agent/shared': {
        const first = !s.shared;
        s.shared = true;
        return send(res, 200, { first });
      }
      case '/api/user/plan':
        userEditPlan(s, body.next);
        return send(res, 200, view(s));
      case '/api/user/override':
        userOverride(s, String(body.id), body.text);
        return send(res, 200, view(s));
      default:
        return send(res, 404, { error: 'not found' });
    }
  } catch (e) {
    send(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
});

server.on('error', e => { if (e.code === 'EADDRINUSE') process.exit(0); throw e; });
server.listen(PORT, HOST);
