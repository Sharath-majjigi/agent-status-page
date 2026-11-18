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
const WEEK = 7 * 24 * 3600 * 1000;

/** @type {Map<string, any>} */
const sessions = new Map();
const pidAlias = new Map(); // "pid:123" -> session id (fallback when the MCP server lacks the env var)
const subscribers = new Map(); // session id or '*' (latest) -> Set<res>
const waiters = new Map(); // session id -> res (a Stop hook waiting to wake the idle agent)
let lastRequest = Date.now();

const safeName = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
let seq = 0;
const newId = p => p + Date.now().toString(36) + (seq++).toString(36);

// ---------- persistence ----------
for (const f of fs.readdirSync(SESSIONS_DIR)) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    if (Date.now() - (s.updatedAt || 0) > WEEK) { fs.unlinkSync(path.join(SESSIONS_DIR, f)); continue; }
    if (s.status === 'working') s.status = 'idle';
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
    followups: [], children: [], hostId: '', parent: null, stepStartedAt: 0,
    pending: { plan: null, overrides: [], followups: [] },
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
  for (const d of s.done) if (!d.id) d.id = newId('n');
  if (s.now) delete s.now.file; // file names are no longer shown
  if (s.pause === undefined) s.pause = null;
  s.resume = !!s.resume;
  gate(s);
}
const hasPending = s => !!(s.pending.plan || s.pending.overrides.length || s.pending.followups.length);
const currentStepId = s => (s.next[0] && s.next[0].id) || (s.done.length ? s.done[s.done.length - 1].id : null);
function latest() {
  let best = null;
  for (const s of sessions.values()) if (s.touchedAt && (!best || s.touchedAt > best.touchedAt)) best = s;
  return best;
}
function view(s) {
  if (!s) return null;
  const { pending, agentNext, pid, resume, ...rest } = s;
  rest.children = s.children.map(c => {
    const x = findChild(c);
    return x ? { ...c, id: x.id, title: x.title, status: x.status, done: x.done.length, total: x.done.length + x.next.length }
      : { ...c, id: null, title: '', status: 'starting', done: 0, total: 0 };
  });
  const parent = s.parent && sessions.get(s.parent);
  rest.parent = parent ? { id: parent.id, title: parent.title } : null;
  return rest;
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
  if (!plan && !overrides.length && !followups.length) return null;
  const lines = ['Update from the user, made on the status page while you were working:', ''];
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
  s.pending = { plan: null, overrides: [], followups: [] };
  s.edits = { state: 'received', at: Date.now() };
  changed(s);
  return lines.join('\n');
}

const PAUSE_MESSAGE = 'The user paused this task on the status page. Stop here: make no more tool calls, and end your turn with one short line saying where you paused. You will be resumed later.';
const RESUME_MESSAGE = 'The user resumed this task on the status page. Carry on from where you paused.';

// What the agent should hear next. While paused, only the pause itself; edits wait for the resume.
function takeFor(s, { stopping = false, prompt = false } = {}) {
  if (prompt && (s.pause || s.resume)) { s.pause = null; s.resume = false; gate(s); changed(s); } // typing in Claude Code resumes
  if (s.pause) {
    if (stopping) { s.pause.state = 'paused'; changed(s); return null; }
    if (s.pause.state !== 'asked') return null;
    s.pause.state = 'told';
    changed(s);
    return PAUSE_MESSAGE;
  }
  const edits = takeEdits(s);
  if (!s.resume) return edits;
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
  if (Array.isArray(next)) {
    const before = s.next[0] && s.next[0].id;
    markDone(s, next.map(t => short(t)).filter(Boolean));
    const pool = [...s.next];
    s.next = next.map(t => short(t)).filter(Boolean).map(text => {
      const i = pool.findIndex(n => n.text === text);
      return i >= 0 ? { id: pool.splice(i, 1)[0].id, text } : { id: newId('n'), text };
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
// A new title with none of the current steps in it means the agent moved on to another task.
// (A renamed title over the same steps is the same task. Unsent overrides keep the task open.)
function isNewTask(s, newTitle, next) {
  if (!s.title || newTitle === s.title || hasPending(s)) return false;
  if (!s.done.length && !s.decisions.length && !s.next.length) return false;
  const texts = new Set((Array.isArray(next) ? next : []).map(t => short(t)));
  return !s.next.some(n => texts.has(n.text));
}
// Move the finished task into Earlier, so the page shows only the current one.
function archiveTask(s) {
  s.earlier = s.earlier || [];
  s.earlier.unshift({
    id: newId('t'), title: s.title, endedAt: Date.now(),
    done: s.done, dropped: s.next.map(n => n.text), decisions: s.decisions, followups: s.followups,
  });
  if (s.earlier.length > 20) s.earlier.length = 20;
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
    id: n.id, text: n.text, at: Date.now(),
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

// ---------- user side (the page) ----------
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

    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return fs.createReadStream(PAGE).pipe(res);
    }

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
    const s = p.startsWith('/api/') ? get(body.session) : null;

    switch (p) {
      case '/api/hook/start': {
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
      case '/api/user/followup':
        userFollowup(s, body.stepId, body.text);
        return send(res, 200, view(s));
      case '/api/user/followup/remove':
        userRemoveFollowup(s, body.id);
        return send(res, 200, view(s));
      case '/api/hook/activity':
        if (body.status) {
          s.status = body.status;
          if (body.status === 'working') releaseWaiter(s.id);
        }
        changed(s);
        return send(res, 200, { ok: true });
      case '/api/take':
        return send(res, 200, { message: takeFor(s, { stopping: !!body.stopping, prompt: !!body.prompt }) });
      case '/api/user/pause':
        userPause(s);
        return send(res, 200, view(s));
      case '/api/user/resume':
        userResume(s);
        return send(res, 200, view(s));
      case '/api/agent/plan':
        return send(res, 200, agentUpdatePlan(s, body));
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
