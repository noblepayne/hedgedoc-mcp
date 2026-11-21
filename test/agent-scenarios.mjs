// agent-scenarios.mjs — regression suite: can a fresh agent do real edits?
// Runs S1–S9 from AGENT_SCENARIOS.md against a disposable copy of a source note.
//
//   HEDGEDOC_URL=https://host/stage \
//   HEDGEDOC_EMAIL=... HEDGEDOC_PASSWORD=... \
//   SOURCE_NOTE=WoGZLWM0I \
//   node test/agent-scenarios.mjs
//
// Exits non-zero on failure. Creates a copy; never edits the source.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
import { fileURLToPath } from 'node:url';

const BASE = (process.env.HEDGEDOC_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.HEDGEDOC_EMAIL || 'bot@dev.local';
const PASSWORD = process.env.HEDGEDOC_PASSWORD || 'devpassword123';
const SOURCE = process.env.SOURCE_NOTE;
if (!SOURCE) { console.error('SOURCE_NOTE is required'); process.exit(1); }

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const norm = s => s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();

// ---------- login + copy ----------
const login = await fetch(`${BASE}/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
});
const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
  .filter(Boolean).map(c => c.split(';')[0]).join('; ');
if (!cookie) { console.error('login failed'); process.exit(1); }

const src = await (await fetch(`${BASE}/${SOURCE}/download`)).text();
const mk = await fetch(`${BASE}/new`, {
  method: 'POST', redirect: 'manual',
  headers: { Cookie: cookie, 'Content-Type': 'text/markdown' },
  body: src,
});
const noteId = (mk.headers.get('location') || '').split('/').filter(Boolean).pop();
if (!noteId) { console.error('copy failed:', mk.status); process.exit(1); }
console.log(`copy: ${BASE}/${noteId}  source=${SOURCE}  bytes=${src.length}`);

// ---------- MCP child ----------
const child = spawn('node', ['hedgedoc_mcp/core.mjs'], {
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
  try { return JSON.parse(m.result.content[0].text); }
  catch { return m.result ? m.result : m; }
}
// HedgeDoc keeps OT revisions per note-instance: a reconnect (or a rejected
// op) resets the server to rev 0 and sends a doc frame. An agent must re-read
// and retry; do that here so the suite tests the adapter, not the race.
const ATTEMPTS = Number(process.env.WRITE_ATTEMPTS || 3);
async function write(name, buildArgs, applied) {
  let last;
  for (let i = 0; i < ATTEMPTS; i++) {
    const st = await call('get-status');
    const r = await call(name, buildArgs(st));
    if (['download-poll', 'ack'].includes(r.verified)) return r;
    last = r;
    const n = await call('read-note');
    if (applied && applied(n.content)) return { ...r, verified: 'observed' };
    await new Promise(res => setTimeout(res, 300));
  }
  return last;
}

await rpc('initialize', { protocolVersion: '2024-11-05' });
await new Promise(r => setTimeout(r, 7000));

// ---------- baseline ----------
let st = await call('get-status');
const base = await call('read-note');
const baseHash = st.hash, baseLines = base['total-lines'];
const baseFull = base.content;
assert(st.rev >= 0 && st.auth?.kind === 'user', 'not booted as a user');
console.log(`baseline rev=${st.rev} lines=${baseLines} length=${base.length}`);

// S1
check('S1 orientation', () => {
  assert((base.sections || []).length > 0, 'no sections');
  assert(base.content.startsWith('---'), 'front matter not visible');
  assert(base.sections.every(s => Number.isInteger(s.line) && s.line >= 1), 'sections lack line numbers');
  assert(base.length > 0, 'missing length');
});

// locate a distinctive line
const lines = baseFull.split('\n');
const targetText = lines.find(l => l.startsWith('+ It') || (l.length > 12 && !l.startsWith('#'))) || lines[5];
const targetLine = lines.indexOf(targetText) + 1;

// S2 dry-run must not write
const s2a = await call('replace-lines', { 'base-rev': st.rev, 'base-hash': st.hash,
  edits: [{ line: targetLine, old: targetText, new: targetText + ' [dry]' }], 'dry-run?': true });
const s2b = await call('get-status');
check('S2 dry-run never writes', () => {
  assert(s2a['dry-run'] === true, 'no dry-run flag');
  assert(String(s2a.preview).includes(String(targetLine)), 'preview not localized');
  assert(s2b.rev === st.rev && s2b.hash === st.hash, 'dry-run changed state');
});

// S3 single-line edit + revert
const s3a = await write('replace-lines',
  st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
           edits: [{ line: targetLine, old: targetText, new: targetText + ' [s3]' }] }),
  c => c.includes(targetText + ' [s3]'));
const s3read = await call('read-note', { offset: targetLine, limit: 1 });
const s3b = await call('get-status');
console.error('  revs after S3 write:', st.rev, '->', s3b.rev);
const s3c = await write('replace-lines',
  st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
           edits: [{ line: targetLine, old: targetText + ' [s3]', new: targetText }] }),
  c => !c.includes('[s3]'));
check('S3 single-line edit + revert', () => {
  assert(['download-poll', 'ack'].includes(s3c.verified), 'revert not verified');
  assert(s3a.verified !== 'emitted', 'write not acknowledged');
  assert(s3read.content === targetText + ' [s3]', 'edit not visible');
});

// S4 batch four lines + revert
st = await call('get-status');
const b = await call('read-note');
const bl = b.content.split('\n');
const picks = bl.map((l, i) => [l, i + 1]).filter(([l]) => l.startsWith('+ ') && l.length > 10).slice(0, 4);
const bEdits = picks.map(([l, n]) => ({ line: n, old: l, new: l + ' [s4]' }));
const s4a = await write('replace-lines', st => ({ 'base-rev': st.rev, 'base-hash': st.hash, edits: bEdits }),
  c => bEdits.every(e => c.includes(e.new)));
const s4r = await call('read-note');
st = await call('get-status');
const bRevert = bEdits.map(e => ({ line: e.line, old: e.new, new: e.old }));
const s4b = await write('replace-lines', st => ({ 'base-rev': st.rev, 'base-hash': st.hash, edits: bRevert }),
  c => bRevert.every(e => c.includes(e.new)));
check('S4 batch edit + revert', () => {
  assert(['download-poll', 'ack'].includes(s4a.verified), 'batch not verified');
  assert(bEdits.every(e => s4r.content.includes(e.new)), 'not all batch edits applied');
  assert(['download-poll', 'ack'].includes(s4b.verified), 'batch revert not verified');
});

// S5 section rewrite + restore
st = await call('get-status');
let secName = null, sec = null;
for (const cand of (base.sections || [])) {
  if (cand.level < 2 || /^(Show|Episode|Title|Description|Tags|GUID|Guests|End Guests|SPONSORS)$/i.test(cand.heading)) continue;
  const c = await call('read-section', { heading: cand.heading });
  if ((c.content || '').length > 150) { secName = cand.heading; sec = c; break; }
}
assert(secName && sec, 'no prose section found');
const secContent = sec.content;
const rewrite = `${sec.content.trim()}\n\n+ Rehearsal rewrite line.\n`;
console.error('  rev before S5:', st.rev);
const dry5 = await call('apply-ops', { 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': rewrite, 'dry-run?': true });
st = await call('get-status');
const w5 = await write('apply-ops', st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': rewrite }), c => c.includes('Rehearsal rewrite line.'));
const after5 = await call('read-section', { heading: secName });
st = await call('get-status');
const r5 = await write('apply-ops', st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': secContent }), c => norm(c) === norm(baseFull));
const back5 = await call('read-section', { heading: secName });
check('S5 section rewrite + restore', () => {
  assert(dry5['dry-run'] === true, 'no dry-run flag');
  assert(['download-poll', 'ack'].includes(w5.verified), 'rewrite not verified: ' + JSON.stringify(w5));
  assert(after5.content.includes('Rehearsal rewrite line.'), 'rewrite not visible');
  assert(norm(back5.content) === norm(secContent), 'section not restored');
});

// S6 append block + blank line + restore
st = await call('get-status');
const pickSection = (base.sections || []).find(s => /Feedback/i.test(s.heading))?.heading || secName;
const cap6 = await call('read-section', { heading: pickSection });
st = await call('get-status');
const block = `> "Rehearsal feedback block."\n\n> — Scenario S6\n`;
const a6 = await write('append-to-section', st => ({ heading: pickSection, 'base-rev': st.rev,
  'base-hash': st.hash, text: block }), c => c.includes('Scenario S6'));
const with6 = await call('read-section', { heading: pickSection });
const full6 = await call('read-note');
st = await call('get-status');
const r6 = await write('apply-ops', st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
  heading: pickSection, 'new-section-text': cap6.content }), c => norm(c) === norm(baseFull));
const back6 = await call('read-section', { heading: pickSection });
check('S6 append + blank line + restore', () => {
  assert(['download-poll', 'ack'].includes(a6.verified), 'append not verified');
  assert(with6.content.includes('Scenario S6'), 'append not visible');
  const tail = full6.content.slice(full6.content.indexOf('Scenario S6'));
  assert(/\n\s*\n##\s/.test(tail) || /\n\s*\n#/.test(tail), 'no blank line before next heading');
  assert(norm(back6.content) === norm(cap6.content),
         'append not restored; r6=' + JSON.stringify(r6));
});

// S7 stale
st = await call('get-status');
const stale = await call('replace-lines', { 'base-rev': st.rev - 5, 'base-hash': st.hash,
  edits: [{ line: targetLine, old: targetText, new: targetText + ' [stale]' }] });
check('S7 stale rejected', () => {
  assert(stale.code === 'stale-revision', 'wrong code ' + stale.code);
  assert(stale.data?.hint, 'no hint');
});

// S8 line mismatch
st = await call('get-status');
const mism = await call('replace-lines', { 'base-rev': st.rev, 'base-hash': st.hash,
  edits: [{ line: targetLine, old: 'definitely not the line', new: 'x' }] });
check('S8 mismatch rejected', () => {
  assert(mism.code === 'line-mismatch', 'wrong code ' + mism.code);
  assert(mism.data?.actual !== undefined, 'no actual line in error');
});

// S9 insert / search / delete
st = await call('get-status');
const pre9 = await call('read-note');
const ins9 = await write('insert-lines',
  st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
           line: pre9['total-lines'] + 1, text: '+ scenario insert line' }),
  c => c.includes('+ scenario insert line'));
let found9 = await call('search', { query: 'scenario insert line' });
for (let tries = 0; tries < 5 && (!found9.matches || found9.matches.length === 0); tries++) {
  await new Promise(r => setTimeout(r, 300));
  found9 = await call('search', { query: 'scenario insert line' });
}
const st9 = await call('get-status');
const del9 = found9.matches && found9.matches.length
  ? await write('delete-lines',
      st => ({ 'base-rev': st.rev, 'base-hash': st.hash, line: found9.matches[0].line }),
      c => !c.includes('+ scenario insert line'))
  : { verified: false, code: 'search-miss' };
const gone9 = await call('search', { query: 'scenario insert line' });
check('S9 insert/search/delete', () => {
  assert(['download-poll', 'ack'].includes(ins9.verified), 'insert not verified');
  assert(found9.matches && found9.matches.length === 1, 'search did not find inserted line');
  assert(['download-poll', 'ack'].includes(del9.verified), 'delete not verified');
  assert(gone9.matches.length === 0, 'insert line survived delete');
});

// S9 integrity
const fin = await call('read-note');
const finSt = await call('get-status');
check('S10 document restored', () => {
  assert(norm(fin.content) === norm(baseFull), 'content drift beyond blank lines');
  const fences = (fin.content.match(/```/g) || []).length;
  assert(fences % 2 === 0, 'unbalanced fences');
  assert(Math.abs(fin['total-lines'] - baseLines) <= 2, 'line count drift');
  assert(!fin.content.includes('[s3]') && !fin.content.includes('[s4]') && !fin.content.includes('Rehearsal rewrite line.'), 'marker survived');
});

child.stdin.end();
console.log(`\ncopy for inspection: ${BASE}/${noteId}`);
console.log(`baseline hash ${baseHash} -> final ${finSt.hash}`);
const failed = results.filter(r => r[1] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
