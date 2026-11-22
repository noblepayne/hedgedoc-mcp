// multi-note.mjs — supervisor smoke: two notes, one process, isolated state.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.HEDGEDOC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.env.HEDGEDOC_EMAIL || 'bot@dev.local';
const PASSWORD = process.env.HEDGEDOC_PASSWORD || 'devpassword123';
const DEFAULT_NOTE = process.env.DEFAULT_NOTE;
if (!DEFAULT_NOTE) { console.error('DEFAULT_NOTE is required'); process.exit(1); }

const assert = (c, m) => { if (!c) throw new Error(m); };

const login = await fetch(`${BASE}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
});
const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
  .filter(Boolean).map(c => c.split(';')[0]).join('; ');
assert(cookie, 'login failed');
const mk = await fetch(`${BASE}/new`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie: cookie, 'Content-Type': 'text/markdown' },
  body: '# Multi test\n\nalpha line\nbeta line\n',
});
const other = (mk.headers.get('location') || '').split('/').filter(Boolean).pop();
assert(other, 'could not create second note');

const child = spawn(process.execPath, ['hedgedoc_mcp/multi.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, HEDGEDOC_URL: BASE, HEDGEDOC_NOTE_ID: DEFAULT_NOTE,
         HEDGEDOC_EMAIL: EMAIL, HEDGEDOC_PASSWORD: PASSWORD },
  stdio: ['pipe', 'pipe', 'ignore'],
});
let buf = '', nextId = 1; const waiting = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
  }
});
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${method} timeout`)), 60000);
    waiting.set(id, m => { clearTimeout(t); res(m); });
  });
}
async function call(name, args = {}) {
  const m = await rpc('tools/call', { name, arguments: args });
  try { return JSON.parse(m.result.content[0].text); } catch { return m.result; }
}
await rpc('initialize', { protocolVersion: '2024-11-05' });
await new Promise(r => setTimeout(r, 8000));

const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
assert(tools.includes('list-notes'), 'list-notes missing');
assert('note-id' in (await rpc('tools/list', {})).result.tools.find(t => t.name === 'apply-ops').inputSchema.properties,
       'note-id missing from schema');

const a = await call('get-status', { waitMs: 10000 });
const b = await call('get-status', { 'note-id': other, waitMs: 10000 });
assert(a.rev >= 0 && b.rev >= 0, 'a note did not boot');
const nb = await call('read-note', { 'note-id': other });
const lines = nb.content.split('\n');
const target = lines.find(l => l === 'alpha line');
const n = lines.indexOf(target) + 1;
const w = await call('replace-lines', {
  'note-id': other, 'base-rev': b.rev, 'base-hash': b.hash,
  edits: [{ line: n, old: 'alpha line', new: 'alpha line [multi]' }],
});
assert(['download-poll', 'ack'].includes(w.verified), 'write to second note failed: ' + JSON.stringify(w));
const a2 = await call('get-status');
assert(a.hash === a2.hash, 'default note changed');
const notes = await call('list-notes');
assert(notes.active.includes(DEFAULT_NOTE) && notes.active.includes(other), 'active workers missing');
console.log(`multi-note: ok (default ${DEFAULT_NOTE}, second ${other})`);
child.stdin.end();
