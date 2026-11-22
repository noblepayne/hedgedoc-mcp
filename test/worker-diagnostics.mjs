// worker-diagnostics.mjs — P3-00b: heartbeat registry, PID liveness, stale
// marking, duplicates, no-kill, get-status diagnostics, doctor dispatch, and
// list-notes compatibility.
//
// registry.mjs has no module-level side effects, so it is imported directly.
// core.mjs and multi.mjs call main() at load, so their dispatch is exercised
// through subprocesses against a dead URL: no live HedgeDoc needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hdmcp-reg-'));
process.env.XDG_RUNTIME_DIR = TMP;

const reg = await import('../hedgedoc_mcp/registry.mjs');

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entriesFor = (note) => reg.read_entries().filter((e) => e.note === note);

// A live PID whose /proc/<pid>/cmdline contains "core.mjs", like a real worker.
const fakeWorker = () => spawn(process.execPath,
  ['-e', 'setTimeout(() => {}, 60000)', 'hedgedoc_mcp/core.mjs'], { stdio: 'ignore' });
// A live PID that is NOT ours: the reused-PID case.
const otherProcess = () => spawn(process.execPath,
  ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

const stopAll = (procs) => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } };

// --- 1. registry directory -------------------------------------------------
check(reg.registry_dir() === path.join(TMP, 'hedgedoc-mcp'), 'XDG_RUNTIME_DIR is honored');
const savedXdg = process.env.XDG_RUNTIME_DIR;
delete process.env.XDG_RUNTIME_DIR;
check(reg.registry_dir() === '/tmp/opencode/hedgedoc-mcp', 'absent XDG_RUNTIME_DIR falls back to /tmp/opencode');
process.env.XDG_RUNTIME_DIR = savedXdg;

// --- 2. write / read / remove, live worker ---------------------------------
const w1 = fakeWorker();
await sleep(300);
reg.write_entry_BANG_({ note: 'wdiag-a', pid: w1.pid, version: '0.2.3',
  startedAt: Date.now(), lastHeartbeat: Date.now(), connected: true,
  writable: false, rev: 3, attempts: 1, lastConnectAt: Date.now() });
let a = entriesFor('wdiag-a');
check(a.length === 1 && a[0].pid === w1.pid, 'write-entry then read-entries round trip');
check(a[0].stale === false && a[0].live === true, 'fresh heartbeat on a live worker is neither stale nor dead');
check(reg.remove_entry_BANG_('wdiag-a', w1.pid) === true && entriesFor('wdiag-a').length === 0,
  'remove-entry deletes the file');

// --- 3. stale heartbeat is marked, not pruned ------------------------------
reg.write_entry_BANG_({ note: 'wdiag-stale', pid: w1.pid, version: '0.2.3',
  lastHeartbeat: Date.now() - 91000, connected: false });
a = entriesFor('wdiag-stale');
check(a.length === 1 && a[0].stale === true, 'heartbeat older than 90s is marked stale and kept');
check(reg.entry_stale_QMARK_({ lastHeartbeat: Date.now() }, Date.now()) === false,
  'entry-stale? false inside the window');
reg.remove_entry_BANG_('wdiag-stale', w1.pid);

// --- 4. reused PID is dead ------------------------------------------------
const alien = otherProcess();
await sleep(300);
check(reg.pid_live_QMARK_(alien.pid) === false,
  'a live PID that is not hedgedoc_mcp/core.mjs reads as dead (reused PID)');
check(reg.pid_live_QMARK_(w1.pid) === true, 'a live core.mjs cmdline reads as live');
check(reg.pid_live_QMARK_(999999999) === false, 'unknown PID is dead');
check(reg.cmdline_live_QMARK_('node\0/opt/x/hedgedoc_mcp/core.mjs\0') === true,
  'cmdline predicate accepts hedgedoc_mcp');
check(reg.cmdline_live_QMARK_('node\u0000/usr/bin/sleep\u000010\u0000') === false,
  'cmdline predicate rejects a foreign process');
reg.write_entry_BANG_({ note: 'wdiag-alien', pid: alien.pid, version: '0.2.3', lastHeartbeat: Date.now() });
check(entriesFor('wdiag-alien').length === 0, 'an entry for a reused PID is pruned on read');

// --- 5. dead PID is pruned ------------------------------------------------
const deadPid = alien.pid;
stopAll([alien]);
await sleep(300);
reg.write_entry_BANG_({ note: 'wdiag-dead', pid: deadPid, version: '0.2.3',
  lastHeartbeat: Date.now() - 10000 });
check(entriesFor('wdiag-dead').length === 0, 'an entry whose PID is gone is pruned');

// --- 6. duplicates and version mismatch ----------------------------------
const w2 = fakeWorker();
await sleep(300);
const now = Date.now();
reg.write_entry_BANG_({ note: 'wdiag-dup', pid: w1.pid, version: '0.2.3', lastHeartbeat: now });
reg.write_entry_BANG_({ note: 'wdiag-dup', pid: w2.pid, version: '0.2.4', lastHeartbeat: now });
const both = entriesFor('wdiag-dup');
const dup = reg.duplicates(both);
check(dup.length === 1 && dup[0].note === 'wdiag-dup' && dup[0].pids.length === 2,
  `two live PIDs on one note are a duplicate (${JSON.stringify(dup)})`);
const vm = reg.version_mismatch(both, '0.2.3');
check(vm.mismatch === true && vm.entries.length === 1 && vm.entries[0].version === '0.2.4',
  'old working tree versus Nix version mismatch is reported with the PID');
check(reg.version_mismatch(both, '0.2.3').entries[0].pid === w2.pid, 'the mismatched PID is named');

// --- 7. no kill: doctor and registry never signal ------------------------
const realKill = process.kill;
let kills = 0;
process.kill = (...args) => { kills += 1; return realKill.apply(process, args); };
let report;
try {
  reg.read_entries();
  report = reg.doctor_report({ server: { ok: true }, workers: [{ note: 'wdiag-dup', pid: w2.pid, status: 'timeout' }], entries: both, version: '0.2.3' });
} finally {
  process.kill = realKill;
}
check(kills === 0, `registry read and doctor report call process.kill zero times (${kills})`);
check(report.readOnly === true && Array.isArray(report.registry) && report.duplicates.length === 1,
  'doctor report is read-only, lists registry rows and duplicates');
check(report.timeouts.length === 1 && report.hint.includes('never kills'),
  'a timed-out worker is reported with a never-kills hint');

// --- 8. pinned shapes ----------------------------------------------------
const ws = reg.worker_summary(both[0]);
check(JSON.stringify(Object.keys(ws).sort()) === JSON.stringify(
  ['attempts', 'connected', 'lastConnectAt', 'note', 'pid', 'version', 'writable']),
  `list-notes worker shape is pinned (${Object.keys(ws)})`);
const es = reg.entry_summary(both[0]);
check(es.stale === false && es.live === true && es.note === 'wdiag-dup',
  'registry summary carries stale/live/note');

// --- 9. MCP subprocesses (core refusal, get-status, multi list-notes/doctor) ---
function rpcClient(script, env) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', nextId = 1;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  const rpc = (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} timeout`)), 15000);
      waiting.set(id, (m) => { clearTimeout(t); res(m); });
    });
  };
  const call = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    try { return JSON.parse(m.result.content[0].text); } catch { return m.result; }
  };
  return { child, rpc, call };
}

const dead = { HEDGEDOC_URL: 'http://127.0.0.1:9', HEDGEDOC_POLL_TIMEOUT_MS: '200' };
const core = rpcClient('hedgedoc_mcp/core.mjs', { ...dead, HEDGEDOC_NOTE_ID: 'wdiag-core' });
const multi = rpcClient('hedgedoc_mcp/multi.mjs', { ...dead, HEDGEDOC_NOTE_ID: 'wdiag-multi' });
try {
  await core.rpc('initialize', { protocolVersion: '2024-11-05' });
  await multi.rpc('initialize', { protocolVersion: '2024-11-05' });

  const coreTools = (await core.rpc('tools/list', {})).result.tools.map((t) => t.name);
  check(!coreTools.includes('doctor'), 'core hides doctor from tools/list');
  const refused = await core.call('doctor');
  check(refused.code === 'doctor-requires-supervisor' && typeof refused.data?.hint === 'string',
    `core doctor refusal is doctor-requires-supervisor with a hint (${refused.code})`);

  const st = await core.call('get-status', {});
  check(st.worker && st.worker.pid === core.child.pid && st.worker.noteId === 'wdiag-core'
    && st.worker.version && typeof st.worker.startedAt === 'number' && st.worker.logGeneration === 0,
    `get-status.worker carries pid/version/noteId/startedAt/logGeneration (${JSON.stringify(st.worker)})`);
  check(st.socket && st.socket.connected === false && st.socket.reconnectAttempts >= 1
    && typeof st.socket.generation === 'number' && 'nextAttemptAt' in st.socket,
    `get-status.socket carries the reconnect diagnostics (${JSON.stringify(st.socket)})`);

  // The core process wrote a heartbeat; its own note is in the registry.
  const own = entriesFor('wdiag-core');
  check(own.length === 1 && own[0].version === st.worker.version,
    'core writes a registry heartbeat at boot');

  const multiTools = (await multi.rpc('tools/list', {})).result.tools;
  const doctorDef = multiTools.find((t) => t.name === 'doctor');
  check(Boolean(doctorDef) && !('note-id' in doctorDef.inputSchema.properties),
    'multi advertises doctor without note-id injection');

  const notes = await multi.call('list-notes');
  check(Array.isArray(notes.active) && notes.active.length === 0 && Array.isArray(notes.workers),
    `list-notes keeps active as an id array and adds workers (${JSON.stringify(notes)})`);

  const doc = await multi.call('doctor');
  check(Array.isArray(doc.registry) && Array.isArray(doc.workers) && Array.isArray(doc.duplicates)
    && doc.readOnly === true && doc.server && doc.server.ok === false,
    `multi doctor answers without a note-id and reports server failure honestly (${JSON.stringify(doc.server)})`);
} catch (e) {
  check(false, String(e));
} finally {
  core.child.stdin.end(); core.child.kill('SIGTERM');
  multi.child.stdin.end(); multi.child.kill('SIGTERM');
}

// --- 10. the worker removes its registry file on exit --------------------
await sleep(1200);
check(entriesFor('wdiag-core').length === 0, 'core removes its heartbeat on shutdown');

stopAll([w1, w2]);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
