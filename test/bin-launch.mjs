// bin-launch.mjs — the npm/npx entry point must work through a symlink.
// Regression for: core-path was dirname(process.argv[1]), so `.bin/hedgedoc-mcp`
// looked for `.bin/core.mjs` and every tools/call failed after initialize.
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
// Keep the link inside the build tree: the Nix sandbox does not resolve a
// /tmp symlink back into /build reliably.
const dir = mkdtempSync(join(root, '.bin-launch-'));
const link = join(dir, 'hedgedoc-mcp');
symlinkSync(join(root, 'bin/hedgedoc-mcp.mjs'), link);

const env = {
  ...process.env,
  HEDGEDOC_URL: 'http://127.0.0.1:9',
  HEDGEDOC_NOTE_ID: 'smoke',
  HEDGEDOC_MAX_NOTES: '1',
};
delete env.HEDGEDOC_EMAIL;
delete env.HEDGEDOC_PASSWORD;
delete env.HEDGEDOC_COOKIE;

const child = spawn(process.execPath, [link], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function waitFor(id, ms = 15000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (boxes.has(id)) return res(boxes.get(id));
      if (Date.now() - t0 > ms) return rej(new Error(`timeout id=${id}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
const call = (id, name, args) => {
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return waitFor(id);
};

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  await waitFor(1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  const names = new Set((list.result?.tools ?? []).map((t) => t.name));
  check(names.has('get-status') && names.has('list-notes'), 'tools/list through a symlink');

  const status = await call(3, 'get-status', {});
  const text = status.result?.content?.[0]?.text ?? '';
  check(!/Cannot find module/i.test(stderr), 'worker module resolves (no Cannot find module)');
  check(/not-booted|rev|error/i.test(text), 'tools/call reaches the worker');
} catch (e) {
  check(false, `${String(e)} pid=${child.pid} exit=${child.exitCode}\n--- stderr ---\n${stderr.slice(-2000)}`);
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
