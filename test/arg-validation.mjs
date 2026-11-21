// arg-validation.mjs — unknown keys and wrong JSON types must be bad-args,
// never an internal error and never a coerced write. Regression for the
// clojure.string/join typo that turned every unknown key into "internal".
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['hedgedoc_mcp/core.mjs'], {
  env: {
    ...process.env,
    HEDGEDOC_URL: 'http://127.0.0.1:9',
    HEDGEDOC_NOTE_ID: 'argtest',
    HEDGEDOC_POLL_TIMEOUT_MS: '200',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = ''; const boxes = new Map();
child.stdout.on('data', (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); boxes.set(m.id, m); } catch {}
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const wait = (id, ms = 10000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => boxes.has(id) ? res(boxes.get(id)) : (Date.now() - t0 > ms ? rej(new Error('timeout')) : setTimeout(tick, 20));
  tick();
});
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
const call = async (id, args) => {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'replace-lines', arguments: args } });
  const r = await wait(id);
  try { return JSON.parse(r.result.content[0].text); } catch { return {}; }
};
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await wait(1);
  const unknown = await call(2, { 'base-rev': 0, 'base-hash': 'x', bogus: true });
  check(unknown.code === 'bad-args' && Array.isArray(unknown.data?.unknown), `unknown key is bad-args (${unknown.code})`);
  const wrongType = await call(3, { 'base-rev': 0, 'base-hash': 'x', dryRun: 'true', edits: [{ line: 1, old: 'a', new: 'b' }] });
  check(wrongType.code === 'bad-args' && wrongType.data?.expected === 'boolean', `stringified dryRun is rejected (${wrongType.code})`);
} catch (e) {
  check(false, String(e));
} finally {
  child.stdin.end(); child.kill('SIGTERM');
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
