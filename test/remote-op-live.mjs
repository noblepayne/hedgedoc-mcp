// remote-op-live.mjs — drive the real core process and have a second socket
// make a human edit. This is the regression gate for the unbound `ops` bug:
// before it, the first remote operation threw, resynced to rev -1, and every
// later write failed with rev-unknown.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

const base = (process.env.HEDGEDOC_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.HEDGEDOC_EMAIL || 'bot@dev.local';
const password = process.env.HEDGEDOC_PASSWORD || 'devpassword123';

const fixture = `---
tags: LUP
---
# Remote op test

## Picks

+ seed pick

## News

+ bullet one
`;

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const r = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

const cookie = await login();
const newRes = await fetch(`${base}/new`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'text/markdown', Cookie: cookie },
  body: fixture,
});
const noteId = new URL(newRes.headers.get('location'), base).pathname.split('/').pop();
if (!noteId) { console.log('FAIL could not create note'); process.exit(1); }

const child = spawn(process.execPath, ['hedgedoc_mcp/core.mjs'], {
  env: {
    ...process.env,
    HEDGEDOC_URL: base,
    HEDGEDOC_NOTE_ID: noteId,
    HEDGEDOC_EMAIL: email,
    HEDGEDOC_PASSWORD: password,
    HEDGEDOC_POLL_TIMEOUT_MS: '5000',
    HEDGEDOC_POLL_MS: '100',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += String(d); });

let buf = '';
const boxes = new Map();
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); boxes.set(m.id, m); } catch {}
  }
});
let id = 10;
function call(name, args) {
  const my = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (boxes.has(my)) return res(boxes.get(my));
      if (Date.now() - t0 > 20000) return rej(new Error(`timeout ${name}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
const body = (r) => {
  try { return JSON.parse(r.result.content[0].text); } catch { return {}; }
};

try {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  await sleep(2000);

  let st;
  for (let i = 0; i < 60; i++) {
    st = body(await call('get-status', {}));
    if (st.rev >= 0 && st.connected) break;
    await sleep(500);
  }
  check(st.rev >= 0, `core booted (rev ${st.rev})`);

  // A second client (the "human") inserts a marker at offset 0.
  const human = io(base, {
    path: '/socket.io/', query: { noteId }, transports: ['websocket'],
    reconnection: false, extraHeaders: { Cookie: cookie },
  });
  await new Promise((res, rej) => {
    human.on('connect', res);
    human.on('connect_error', rej);
    setTimeout(() => rej(new Error('human connect timeout')), 8000);
  });
  const humanDoc = await new Promise((res) => human.on('doc', res));
  const len = humanDoc.str.length;
  human.emit('operation', humanDoc.revision, ['HUMANMARK', len], null);
  await sleep(1000);

  let after;
  for (let i = 0; i < 40; i++) {
    after = body(await call('read-note', {}));
    if ((after.content || '').includes('HUMANMARK') && after.rev > humanDoc.revision) break;
    await sleep(250);
  }
  check((after.content || '').includes('HUMANMARK'), 'core folded the remote operation');
  check(after.rev > humanDoc.revision, `rev advanced after the remote op (${humanDoc.revision} -> ${after.rev})`);

  const st2 = body(await call('get-status', {}));
  const wrote = body(await call('append-to-section', {
    heading: 'News',
    text: '+ after remote op',
    'base-rev': st2.rev,
    'base-hash': st2.hash,
  }));
  check(wrote.status === 'confirmed' || wrote.verified === 'download-poll', `write after remote op (${JSON.stringify(wrote).slice(0, 120)})`);

  const fin = body(await call('read-note', {}));
  check((fin.content || '').includes('+ after remote op'), 'write is present');
  human.close();
  child.stdin.end();
} catch (e) {
  check(false, String(e));
  if (stderr) console.log(stderr.split('\n').slice(-8).join('\n'));
} finally {
  child.kill('SIGTERM');
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
