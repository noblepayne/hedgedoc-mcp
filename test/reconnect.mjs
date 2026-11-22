// reconnect.mjs — P3-00a socket lifecycle contract.
//
// Pure helpers come from compiled modules (model/state have no main()). core
// calls main() at module load, so get-status and forceReconnect are exercised
// through a subprocess, the same way arg-validation.mjs does it.
import { spawn } from 'node:child_process';
import { backoff_ms, gen_stale_QMARK_, force_reconnect_block } from '../hedgedoc_mcp/model.mjs';
import { make_initial, invalidate_rev_BANG_ } from '../hedgedoc_mcp/state.mjs';

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

// --- 1. backoff: 1s, 2s, 4s, 8s, 16s, 30s capped --------------------------
const schedule = [0, 1, 2, 3, 4, 5, 6, 12].map((n) => backoff_ms(n));
check(JSON.stringify(schedule) === JSON.stringify([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]),
  `backoff schedule ${JSON.stringify(schedule)}`);
check(JSON.stringify([0, 2].map((n) => backoff_ms(n, (d) => d + 1))) === JSON.stringify([1001, 4001]),
  'injected jitter applies to the scheduled delay');
check(backoff_ms(0, () => -5) === 0, 'negative jitter clamps to 0');
check(backoff_ms(-3) === 1000, 'negative attempt uses the first step');

// --- 2. generation predicate ---------------------------------------------
check(gen_stale_QMARK_(3, 3) === false, 'same generation is current');
check(gen_stale_QMARK_(2, 3) === true, 'older generation is stale');
check(gen_stale_QMARK_(4, 3) === true, 'unknown newer generation is stale');
check(gen_stale_QMARK_(null, 3) === true, 'nil generation is stale');

// --- 3. forceReconnect refusal policy ------------------------------------
check(force_reconnect_block({ 'op-id': 'op-1' }, false) === 'write-in-flight',
  'in-flight write blocks forceReconnect');
check(force_reconnect_block(null, false) === null, 'idle socket may be disposed');
check(force_reconnect_block(null, true) === 'shutting-down', 'shutdown blocks forceReconnect');

// --- 4. a disconnect invalidates the rev, reads keep their snapshot ------
let st;
try {
  const { atom } = await import('squint-cljs/src/squint/core.js');
  st = atom(make_initial('note', 7, '# t\n', 1000));
  invalidate_rev_BANG_(st);
  const v = st.val !== undefined ? st.val : undefined;
  check((v ? v.rev : undefined) === -1, 'disconnect invalidates rev (7 -> -1)');
  check((v ? v.content : undefined) === '# t\n', 'rev invalidation leaves content for reads');
} catch (e) {
  check(false, `rev invalidation setup failed: ${String(e)}`);
}

// --- 5. get-status / forceReconnect through a real core process (offline) --
const child = spawn(process.execPath, ['hedgedoc_mcp/core.mjs'], {
  env: {
    ...process.env,
    HEDGEDOC_URL: 'http://127.0.0.1:9',
    HEDGEDOC_NOTE_ID: 'reconnect',
    HEDGEDOC_POLL_TIMEOUT_MS: '100',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = ''; const boxes = new Map(); let errBuf = '';
child.stderr.on('data', (d) => { errBuf += String(d); });
child.on('error', (e) => { errBuf += `spawn error: ${String(e)}\n`; });
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); boxes.set(m.id, m); } catch {}
  }
});
child.stderr.on('data', () => {});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = (id, ms = 15000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => boxes.has(id) ? res(boxes.get(id)) : (Date.now() - t0 > ms ? rej(new Error(`timeout ${id}`)) : setTimeout(tick, 20));
  tick();
});
const call = async (id, tool, args) => {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } });
  const r = await wait(id);
  try { return JSON.parse(r.result.content[0].text); } catch { return {}; }
};
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await wait(1);
  const bad = await call(2, 'get-status', { forceReconnect: 'yes' });
  check(bad.code === 'bad-args' && bad.data?.field === 'forceReconnect',
    `stringified forceReconnect is bad-args (${bad.code})`);
  const waited = await call(3, 'get-status', { waitMs: 400 });
  check(waited.code === undefined && typeof waited.waitedMs === 'number' && waited.waitedMs >= 300,
    `get-status waitMs returns waitedMs >= 300 (${waited.waitedMs}, code ${waited.code})`);
  check(waited.connected === false, 'offline get-status reports connected false, not an error');
  const forced = await call(4, 'get-status', { forceReconnect: true, waitMs: 0 });
  check(forced.forceReconnect === true && forced.code === undefined,
    `forceReconnect is accepted and echoed (${forced.code || 'ok'})`);
  const write = await call(5, 'replace-lines', {
    'base-rev': 0, 'base-hash': 'x', edits: [{ line: 1, old: 'a', new: 'b' }],
  });
  check(['not-booted', 'not-connected', 'rev-unknown'].includes(write.code) && write['new-rev'] === undefined,
    `no write while disconnected (${write.code})`);
  const after = await call(6, 'get-status', {});
  check(after.code === undefined && typeof after.rev === 'number',
    'worker still answers after forceReconnect and the retry loop');
} catch (e) {
  check(false, `${String(e)}${errBuf ? `\n--- child stderr ---\n${errBuf.slice(-2000)}` : ''}`);
} finally {
  child.stdin.end(); child.kill('SIGTERM');
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
