// Shared helpers for the hooks and the MCP server: find the local page server,
// start it if it isn't running, and talk to it over 127.0.0.1 with the token.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOME = process.env.AGENT_STATUS_HOME || path.join(os.homedir(), '.agent-status-page');
const PORT = Number(process.env.AGENT_STATUS_PORT || 4317);
const HOST = '127.0.0.1';
const APP = 'agent-status-page';

function token() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = path.join(HOME, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  // wx: if two processes race, the loser re-reads the winner's token.
  try { fs.writeFileSync(file, t + '\n', { mode: 0o600, flag: 'wx' }); return t; }
  catch { return fs.readFileSync(file, 'utf8').trim(); }
}

function pageUrl(sessionId) {
  return `http://${HOST}:${PORT}/?t=${token()}` + (sessionId ? `#${sessionId}` : '');
}

function request(method, route, body, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port: PORT, method, path: route, timeout: timeoutMs,
      headers: {
        'x-token': token(),
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', d => (raw += d));
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${raw}`));
        resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function healthy() {
  try { const r = await request('GET', '/health', undefined, 400); return r && r.app === APP; }
  catch { return false; }
}

// Start the page server once, detached, so it outlives any single hook or session.
async function ensureServer() {
  if (await healthy()) return true;
  token(); // make sure the token exists before the server reads it
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    detached: true, stdio: 'ignore', env: { ...process.env },
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 80));
    if (await healthy()) return true;
  }
  return false;
}

async function call(method, route, body) {
  try { return await request(method, route, body); }
  catch {
    if (!(await ensureServer())) throw new Error('status page server is not reachable');
    return request(method, route, body);
  }
}

module.exports = { HOME, PORT, HOST, APP, token, pageUrl, request, ensureServer, call };
