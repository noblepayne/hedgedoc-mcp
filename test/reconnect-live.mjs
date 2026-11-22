// reconnect-live.mjs — P3-00c incident reproduction, draft.
// Starts a disposable dev note worker, restarts the dev HedgeDoc app, and
// proves the worker reconnects and writes without a session restart.
//
//   HEDGEDOC_DEV=1 node test/reconnect-live.mjs
//
// Refuses prod. Creates a disposable note; never touches 694/692. The note is
// left in the disposable dev DB.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.HEDGEDOC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.env.HEDGEDOC_EMAIL || 'bot@dev.local';
const PASSWORD = process.env.HEDGEDOC_PASSWORD || 'devpassword123';
const DEV = process.env.HEDGEDOC_DEV === '1' || process.argv.includes('--dev');
const host = new URL(BASE).hostname;
const devHost = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.dev');
if (!DEV || !devHost) {
  console.error('refusing: set HEDGEDOC_DEV=1 (or --dev) and a loopback/dev host');
  process.exit(2);
}

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- disposable note as a bot ----------
const login = await fetch(`${BASE}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
});
const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
  .filter(Boolean).map(c => c.split(';')[0]).join('; ');
if (!cookie) { console.error('login failed'); process.exit(1); }
const mk = await fetch(`${BASE}/new`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie: cookie, 'Content-Type': 'text/markdown' },
  body: '# reconnect\n\nalpha\nbeta\n',
});
const noteId = (mk.headers.get('location') || '').split('/').filter(Boolean).pop();
if (!noteId) { console.error('create failed:', mk.status); process.exit(1); }
console.log(`disposable: ${BASE}/${noteId}`);

// ---------- MCP child ----------
const child = spawn(process.execPath, ['hedgedoc_mcp/core.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, HEDGEDOC_URL: BASE, HEDGEDOC_NOTE_ID: noteId,
         HEDGEDOC_EMAIL: EMAIL, HEDGEDOC_PASSWORD: PASSWORD,
         HEDGEDOC_CLIENT_MAJOR: '4', HEDGEDOC_POLL_TIMEOUT_MS: '1500' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '', nextId = 1, waiting = new Map();
child.stderr.setEncoding('utf8');
child.stderr.on('data', d => { for (const l of d.split('\n')) if (l.trim()) console.error('  mcp:', l.trim()); });
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => {
  buf += d;
  let i;
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
  if (m.error) throw new Error(JSON.stringify(m.error));
  return JSON.parse(m.result.content[0].text);
}
await rpc('initialize', { protocolVersion: '2024-11-05' });

let baseline, baselineContent;
try {
  baseline = await call('get-status', { waitMs: 15000 });
  check('baseline connected and writable', () => {
    assert(baseline.connected === true, 'not connected');
    assert(baseline.writable === true, 'not writable');
    assert(Number.isInteger(baseline.rev) && baseline.rev >= 0, `rev ${baseline.rev}`);
  });
  baselineContent = String((await call('read-note', { limit: 50 })).content);

  // ---------- restart the app, not the database ----------
  console.log('restarting hedgedoc-dev-app');
  execFileSync('podman', ['restart', 'hedgedoc-dev-app'], { stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/status`)).ok) break; } catch {}
    await sleep(1000);
  }
  await sleep(500);

  // ---------- recovery without a session restart ----------
  let recovered = null;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const st = await call('get-status', { waitMs: 2000 });
    if (st.connected === true && st.writable === true && Number.isInteger(st.rev) && st.rev >= 0) {
      recovered = st; break;
    }
    await sleep(500);
  }
  check('worker reconnects and becomes writable', () => {
    assert(recovered, 'no connected+writable status within 30s');
  });
  check('reconnect restored a valid rev', () => {
    assert(recovered.rev >= 0, `rev ${recovered.rev}`);
  });

  // ---------- one verified write and restore ----------
  const rn = await call('read-note', { limit: 50 });
  const line = String(rn.content).split('\n').findIndex(l => l === 'alpha') + 1;
  assert(line > 0, 'alpha line missing');
  const ins = await call('insert-lines', {
    'base-rev': recovered.rev, 'base-hash': recovered.hash,
    line, text: '+ reconnect probe',
  });
  check('write after reconnect is confirmed', () => {
    assert(ins.status === 'confirmed', `status ${ins.status}`);
    assert(ins['new-rev'] > recovered.rev, 'rev did not advance');
  });
  const mid = await call('read-note', { limit: 50 });
  check('probe is present', () => assert(String(mid.content).includes('+ reconnect probe'), 'missing'));
  const del = await call('delete-lines', {
    'base-rev': mid.rev, 'base-hash': mid.hash, line, count: 1,
  });
  check('restore write is confirmed', () => assert(del.status === 'confirmed', `status ${del.status}`));
  const back = await call('read-note', { limit: 50 });
  check('final content matches baseline', () => {
    const norm = s => String(s).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    assert(norm(back.content) === norm(baselineContent), 'note content drift');
  });
} catch (e) {
  check('live scenario completed', () => { throw e; });
} finally {
  child.stdin.end(); child.kill('SIGTERM');
}
console.log(results.every(([, r]) => r === 'PASS') ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(results.every(([, r]) => r === 'PASS') ? 0 : 1);
