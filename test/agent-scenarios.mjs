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
let st = await call('get-status', { waitMs: 0 });
const base = await call('read-note');
const baseHash = st.hash, baseLines = base['total-lines'];
const baseFull = base.content;
assert(st.rev >= 0 && st.auth?.kind === 'user', 'not booted as a user');
console.log(`baseline rev=${st.rev} lines=${baseLines} length=${base.length}`);

// S0 get-status wait contract: waitMs 0 must not spend wall-clock, and a
// ready worker reports writable instead of making the client poll.
check('S0 get-status waitMs 0 reports writable without waiting', () => {
  assert(st.writable === true, `writable expected true, got ${st.writable}`);
  assert(st.waitedMs === 0, `waitedMs expected 0, got ${st.waitedMs}`);
});
const stWait = await call('get-status', { waitMs: 5000 });
check('S0b get-status waitMs 5000 on a ready worker', () => {
  assert(stWait.writable === true, `writable expected true, got ${stWait.writable}`);
  assert(Number.isInteger(stWait.waitedMs) && stWait.waitedMs >= 0, `bad waitedMs: ${stWait.waitedMs}`);
  assert(stWait.rev >= 0, 'rev not known after the wait');
  assert(stWait.connected === true, 'not connected after the wait');
});

// S1
check('S1 orientation', () => {
  assert((base.sections || []).length > 0, 'no sections');
  assert(base.content.startsWith('---'), 'front matter not visible');
  assert(base.sections.every(s => Number.isInteger(s.line) && s.line >= 1), 'sections lack line numbers');
  assert(base.length > 0, 'missing length');
});

// S1b subtree read: includeSubsections walks past child headings; the default
// read still stops at the first child and must not grow the write marker.
const secs = base.sections || [];
const parentIdx = secs.findIndex((s, i) => s.level > 1 && secs[i + 1] && secs[i + 1].level > s.level);
const subQ = parentIdx >= 0
  ? { heading: secs[parentIdx].heading, level: secs[parentIdx].level,
      occurrence: secs[parentIdx].occurrence, includeSubsections: true }
  : null;
const subRead = subQ ? await call('read-section', subQ) : null;
const plainRead = subQ
  ? await call('read-section', { heading: subQ.heading, level: subQ.level, occurrence: subQ.occurrence })
  : null;
check('S1b subtree read includes children; default read unchanged', () => {
  assert(subQ && subRead, 'no section with a nested child heading found');
  assert(subRead.writeRoundTrip === false, `writeRoundTrip=${subRead.writeRoundTrip}`);
  assert(typeof subRead.hint === 'string' && subRead.hint.length > 0, 'no subtree hint');
  assert(plainRead.writeRoundTrip === undefined, 'writeRoundTrip leaked into a default read');
  assert(subRead.start === plainRead.start, 'subtree start moved');
  assert(subRead.content.startsWith(plainRead.content), 'subtree must extend the default body');
  assert(subRead.end >= plainRead.end, 'subtree end did not advance');
  assert(subRead.content.includes(secs[parentIdx + 1].heading), 'child heading missing from subtree');
});

// S1c read-note section modes: "all" (default), "none", "window". The window
// filter is by section start offset, so :line must stay an absolute document
// line. get-status still lists every heading when read-note is asked for none;
// that asymmetry is deliberate.
const noneNote = await call('read-note', { sections: 'none' });
const allNote = await call('read-note', { sections: 'all' });
const windowHead = secs.length ? secs[Math.floor(secs.length / 3)] : null;
const pageAll = windowHead ? await call('read-note', { offset: windowHead.line, limit: 8 }) : null;
const pageWin = windowHead
  ? await call('read-note', { offset: windowHead.line, limit: 8, sections: 'window' })
  : null;
check('S1c sections none returns [] and keeps size fields', () => {
  assert(Array.isArray(noneNote.sections) && noneNote.sections.length === 0, 'none did not return []');
  assert(noneNote.content === base.content, 'none changed content');
  assert(noneNote.length === base.length && noneNote['total-lines'] === base['total-lines'],
    'none changed length/total-lines');
  assert((st.sections || []).length === secs.length && secs.length > 0,
    'get-status stopped listing headings (asymmetry broken)');
});
check('S1c sections all is unchanged', () => {
  assert(JSON.stringify(allNote.sections) === JSON.stringify(base.sections), 'all differs from default');
});
check('S1c sections window keeps only headings inside the slice', () => {
  assert(pageAll && pageWin, 'no section to window on');
  const expected = (base.sections || [])
    .filter(s => s.line >= pageWin['start-line'] && s.line <= pageWin['end-line'])
    .map(s => ({ level: s.level, heading: s.heading, occurrence: s.occurrence, line: s.line }));
  assert(pageAll.sections.length === (base.sections || []).length, 'paginated default is not all');
  assert(JSON.stringify(pageWin.sections) === JSON.stringify(expected),
    `window mismatch: ${JSON.stringify(pageWin.sections)} vs ${JSON.stringify(expected)}`);
  assert(pageWin.sections.every(s => Number.isInteger(s.line) && s.line >= 1), 'window lines are not absolute');
  assert(pageWin.content === base.content.split('\n').slice(pageWin['start-line'] - 1, pageWin['end-line']).join('\n'),
    'window changed content');
  assert(pageWin.length === pageAll.length && pageWin['truncated'] === pageAll.truncated,
    'window changed length/truncated');
});

// locate a distinctive line
const lines = baseFull.split('\n');
const targetText = lines.find(l => l.startsWith('+ It') || (l.length > 12 && !l.startsWith('#'))) || lines[5];
const targetLine = lines.indexOf(targetText) + 1;

// S2 dry-run must not write, under the canonical key and both legacy aliases.
const dryArgs = { 'base-rev': st.rev, 'base-hash': st.hash,
  edits: [{ line: targetLine, old: targetText, new: targetText + ' [dry]' }] };
const s2a = await call('replace-lines', { ...dryArgs, dryRun: true });
const s2alias = await call('replace-lines', { ...dryArgs, 'dry-run': true });
const s2legacy = await call('replace-lines', { ...dryArgs, 'dry-run?': true });
const dryModes = {};
for (const mode of ['window', 'region', 'tail']) {
  dryModes[mode] = await call('replace-lines', { ...dryArgs, dryRun: true, preview: mode });
}
const s2b = await call('get-status');
check('S2 dry-run never writes', () => {
  for (const [name, r] of [['dryRun', s2a], ['dry-run', s2alias], ['dry-run?', s2legacy]]) {
    assert(r['dry-run'] === true, `no dry-run flag for ${name}`);
    assert(r.written === false, `dry-run claims a write for ${name}`);
    assert(r['new-rev'] === undefined, `dry-run leaked new-rev for ${name}`);
    assert(r.status === 'dry-run', `wrong dry-run status for ${name}: ${r.status}`);
  }
  assert(String(s2a.preview).includes(String(targetLine)), 'preview not localized');
  assert(s2b.rev === st.rev && s2b.hash === st.hash, 'dry-run changed state');
});
check('S2b preview modes: shape, affected line, nothing written', () => {
  for (const mode of ['window', 'region', 'tail']) {
    const r = dryModes[mode];
    assert(r['preview-mode'] === mode, `mode ${r['preview-mode']} != ${mode}`);
    assert(r.written === false && r['new-rev'] === undefined, `${mode} claims a write`);
    assert(Number.isInteger(r['preview-total-lines']) && r['preview-total-lines'] >= 1,
      `${mode} preview-total-lines=${r['preview-total-lines']}`);
    assert(r['preview-lines'] && Number.isInteger(r['preview-lines']['start-line'])
      && Number.isInteger(r['preview-lines']['end-line']), `${mode} preview-lines bad`);
    assert(typeof r['preview-truncated'] === 'boolean', `${mode} preview-truncated missing`);
    assert(String(r.preview).includes(targetText + ' [dry]'), `${mode} preview missed the edit`);
    assert(r.preview.split('\n').length <= 200, `${mode} preview exceeded 200 lines`);
  }
});
// append-to-section resolves to a suffix ending at doc end, but its preview
// must be the inserted block only (affected-span), not the tail of the note.
const apSec = (secs || []).find(s => s.level >= 2) || (secs || [])[0];
const apDry = apSec ? await call('append-to-section', {
  'base-rev': st.rev, 'base-hash': st.hash, heading: apSec.heading,
  occurrence: apSec.occurrence, text: 'PREVIEW-DRY-ONLY', dryRun: true, preview: 'region',
}) : null;
check('S2c append dry-run previews its own block', () => {
  assert(apDry, 'no section to append to');
  assert(apDry['dry-run'] === true && apDry.written === false, 'append dry-run wrote');
  assert(apDry['new-rev'] === undefined, 'append dry-run leaked new-rev');
  assert(apDry['preview-mode'] === 'region', `mode ${apDry['preview-mode']}`);
  assert(String(apDry.preview).includes('PREVIEW-DRY-ONLY'), 'append preview missed the block');
  assert(apDry['preview-total-lines'] <= 3,
    `append preview spanned ${apDry['preview-total-lines']} lines (note-end suffix?)`);
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
  heading: secName, 'new-section-text': rewrite, dryRun: true });
const dry5region = await call('apply-ops', { 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': rewrite, dryRun: true, preview: 'region' });
const dry5tail = await call('apply-ops', { 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': rewrite, dryRun: true, preview: 'tail' });
st = await call('get-status');
const w5 = await write('apply-ops', st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': rewrite }), c => c.includes('Rehearsal rewrite line.'));
const after5 = await call('read-section', { heading: secName });
st = await call('get-status');
const r5 = await write('apply-ops', st => ({ 'base-rev': st.rev, 'base-hash': st.hash,
  heading: secName, 'new-section-text': secContent }), c => norm(c) === norm(baseFull));
const back5 = await call('read-section', { heading: secName });
check('S5 section rewrite + restore', () => {
  assert(dry5['dry-run'] === true && dry5.written === false, 'bad dry-run flag/state');
  assert(dry5['new-rev'] === undefined, 'dry-run leaked new-rev');
  for (const [mode, r] of [['region', dry5region], ['tail', dry5tail]]) {
    assert(r['preview-mode'] === mode, `${mode} mode ${r['preview-mode']}`);
    assert(r.written === false && r['new-rev'] === undefined, `${mode} dry-run wrote`);
    assert(String(r.preview).includes('Rehearsal rewrite line.'),
      `${mode} preview missed the end of the replacement`);
    assert(r['preview-total-lines'] > 1, `${mode} total-lines ${r['preview-total-lines']}`);
  }
  assert(dry5tail['preview-truncated'] === true || dry5tail.preview.split('\n').length <= 12,
    'tail is not bounded');
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
const re9 = await call('search', { query: 'scenario\\s+insert\\s+line', regex: true, caseSensitive: true });
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
  assert(re9.matches && re9.matches.length === 1, 'canonical regex/caseSensitive search failed');
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
