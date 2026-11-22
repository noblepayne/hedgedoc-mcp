// replace-range.mjs — pure replace-range->ops contract (WO-09).
// Runs against the compiled model modules: no socket, no boot, no note.
//   npx squint compile && node test/replace-range.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atom, deref } from 'squint-cljs/src/squint/core.js';
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';
import * as tools from '../hedgedoc_mcp/tools.mjs';
import * as st from '../hedgedoc_mcp/state.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log('PASS ' + name); }
  catch (e) { results.push([name, 'FAIL']); console.log('FAIL ' + name + ': ' + e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const src = (p) => readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/' + p, import.meta.url)), 'utf8');
const errData = (e) => e && (e._data || e.data) || e;
function codeOf(fn) { try { fn(); } catch (e) { return errData(e).code; } return null; }
function dataOf(fn) { try { fn(); } catch (e) { return errData(e); } return null; }

const ops = (doc, s, e, oldText, newText) =>
  mops.replace_range__GT_ops(doc, s, e, oldText, newText);
const apply = (doc, r) => mops.apply_ops(doc, r.ops);

// 8 logical lines: 1 '# Alpha', 2 one, 3 two, 4 three, 5 blank, 6 '## Beta',
// 7 b1, 8 b2. A heading on line 6 keeps "section end" distinct from doc end.
const doc = base.normalize('# Alpha\none\ntwo\nthree\n\n## Beta\nb1\nb2\n');

check('fixture is eight logical lines', () => {
  assert(mops.line_spans !== undefined || true, '');
  assert(doc.split('\n').length === 9, 'fixture line count ' + doc.split('\n').length);
});

check('first line: replaces line 1 and the target consumes its newline', () => {
  const r = ops(doc, 1, 1, '# Alpha', '# Alpha One');
  assert(apply(doc, r) === '# Alpha One\none\ntwo\nthree\n\n## Beta\nb1\nb2\n',
    'out=' + JSON.stringify(apply(doc, r)));
  assert(r['target-start'] === 0, 'target-start ' + r['target-start']);
  assert(r['target-end'] === 8, 'target-end ' + r['target-end'] + ' (must include the newline)');
});

check('last line: replaces line 8, target runs to doc end', () => {
  const r = ops(doc, 8, 8, 'b2', 'B2');
  assert(apply(doc, r) === '# Alpha\none\ntwo\nthree\n\n## Beta\nb1\nB2\n',
    'out=' + JSON.stringify(apply(doc, r)));
  assert(r['target-end'] === doc.length, 'target-end ' + r['target-end']);
});

check('full document: replaces every line', () => {
  const oldAll = doc.replace(/\n$/, '');
  const r = ops(doc, 1, 8, oldAll, '# New\nonly');
  assert(apply(doc, r) === '# New\nonly\n', 'out=' + JSON.stringify(apply(doc, r)));
  assert(r['target-start'] === 0 && r['target-end'] === doc.length,
    'target [' + r['target-start'] + ',' + r['target-end'] + ']');
});

check('whole-document delete becomes a one-line blank document', () => {
  const oldAll = doc.replace(/\n$/, '');
  const r = ops(doc, 1, 8, oldAll, '');
  assert(apply(doc, r) === '\n', 'out=' + JSON.stringify(apply(doc, r)));
});

check('one-line document: replace and delete', () => {
  const solo = 'solo\n';
  const r = ops(solo, 1, 1, 'solo', 'alone');
  assert(apply(solo, r) === 'alone\n', 'out=' + JSON.stringify(apply(solo, r)));
  assert(r['target-start'] === 0 && r['target-end'] === 5, 'target ' + r['target-end']);
  const d = ops(solo, 1, 1, 'solo', '');
  assert(apply(solo, d) === '\n', 'delete out=' + JSON.stringify(apply(solo, d)));
});

check('multi-line replacement changes the line count', () => {
  const r = ops(doc, 2, 4, 'one\ntwo\nthree', 'ONE\nTWO');
  assert(apply(doc, r) === '# Alpha\nONE\nTWO\n\n## Beta\nb1\nb2\n',
    'out=' + JSON.stringify(apply(doc, r)));
  const r2 = ops(doc, 2, 3, 'one\ntwo', 'ONE\nTWO\n');
  assert(apply(doc, r2) === '# Alpha\nONE\nTWO\nthree\n\n## Beta\nb1\nb2\n',
    'trailing-nl newText out=' + JSON.stringify(apply(doc, r2)));
});

check('empty and whitespace-only newText delete the range', () => {
  const expected = '# Alpha\n\n## Beta\nb1\nb2\n';
  const a = ops(doc, 2, 4, 'one\ntwo\nthree', '');
  assert(apply(doc, a) === expected, 'empty out=' + JSON.stringify(apply(doc, a)));
  const b = ops(doc, 2, 4, 'one\ntwo\nthree', '   ');
  assert(apply(doc, b) === expected, 'blank out=' + JSON.stringify(apply(doc, b)));
});

check('identical old/new is a no-op', () => {
  assert(codeOf(() => ops(doc, 2, 2, 'one', 'one')) === 'no-op', 'single line');
  assert(codeOf(() => ops(doc, 2, 3, 'one\ntwo', 'one\ntwo')) === 'no-op', 'multi-line');
});

check('trailing newline in oldText is bad-args', () => {
  const d = dataOf(() => ops(doc, 2, 2, 'one\n', 'ONE'));
  assert(d.code === 'bad-args', 'code ' + d.code);
  assert(d.field === 'oldText' && d.reason === 'trailing-newline', JSON.stringify(d));
  const d2 = dataOf(() => ops(doc, 2, 3, 'one\ntwo\n', 'X'));
  assert(d2.code === 'bad-args', 'multi-line code ' + d2.code);
});

check('CRLF oldText fails exact match with an LF hint', () => {
  const d = dataOf(() => ops(doc, 2, 3, 'one\r\ntwo', 'X'));
  assert(d.code === 'range-mismatch', 'code ' + d.code);
  assert(d.startLine === 2 && d.endLine === 3, 'range ' + d.startLine + '..' + d.endLine);
  assert(d.expected === 'one\r\ntwo' && d.actual === 'one\ntwo',
    'expected/actual ' + JSON.stringify([d.expected, d.actual]));
  assert(/LF/.test(d.hint || ''), 'no LF hint: ' + d.hint);
});

check('non-matching oldText is range-mismatch with expected/actual', () => {
  const d = dataOf(() => ops(doc, 2, 3, 'one\ntwo!', 'X'));
  assert(d.code === 'range-mismatch', 'code ' + d.code);
  assert(d.expected === 'one\ntwo!' && d.actual === 'one\ntwo',
    'expected/actual ' + JSON.stringify([d.expected, d.actual]));
});

check('inverted, out-of-range and non-integer ranges are range-out-of-range', () => {
  assert(codeOf(() => ops(doc, 3, 2, 'x', 'y')) === 'range-out-of-range', 'inverted');
  assert(codeOf(() => ops(doc, 0, 1, 'x', 'y')) === 'range-out-of-range', 'start 0');
  assert(codeOf(() => ops(doc, 1, 99, 'x', 'y')) === 'range-out-of-range', 'end past doc');
  assert(codeOf(() => ops(doc, 1.5, 2, 'x', 'y')) === 'range-out-of-range', 'non-integer start');
  assert(codeOf(() => ops(doc, 1, 8.5, 'x', 'y')) === 'range-out-of-range', 'non-integer end');
});

check('the target span feeds the region preview', () => {
  const r = ops(doc, 2, 4, 'one\ntwo\nthree', 'ONE\nTWO');
  const span = mops.affected_span(r.ops);
  const newDoc = apply(doc, r);
  const p = tools.preview_dry_run('region', newDoc, doc, span, r['target-start']);
  assert(String(p.preview).includes('ONE') && String(p.preview).includes('TWO'),
    'region missed the replacement: ' + JSON.stringify(p.preview));
});

check('tool is wired: handler registered and schema declares it', () => {
  const c = src('core.cljs');
  assert(c.includes('"replace-range" handle-replace-range'), 'no tool-handlers entry');
  assert(c.includes('handle-replace-range'), 'no handler');
  const s = src('schema.cljs');
  assert(s.includes(':name "replace-range"'), 'no schema entry');
  assert(/startLine/.test(s) && /oldText/.test(s) && /newText/.test(s), 'schema properties missing');
});

check('dry run writes nothing and carries no new-rev', () => {
  const state = atom(st.make_initial('n', 3, doc, 0));
  const snap = st.snapshot_for_cas(state);
  const boxes = { sent: [], state, presence: { users: [], selections: [] } };
  const env = {
    state,
    inflight: atom(null),
    auth: null,
    'allow-guest-writes?': false,
    'connected?': () => true,
    'now-ms': () => 0,
    'sleep-ms': () => Promise.resolve(),
    'send-op!': (...a) => { boxes.sent.push(a); return Promise.resolve({ kind: 'emitted' }); },
    'get-presence': () => boxes.presence,
    'max-retries': 0,
  };
  let d = null;
  try {
    tools.replace_range(env, { 'base-rev': snap.rev, 'base-hash': snap.hash,
      startLine: 2, endLine: 4, oldText: 'one\ntwo\nthree', newText: 'ONE\nTWO',
      dryRun: true, preview: 'region' });
  } catch (e) { d = errData(e); }
  assert(d && d.code === 'dry-run-preview', 'dry-run code=' + (d && d.code));
  assert(d.written === false, 'dry-run did not report written false');
  assert(d['new-rev'] === undefined, 'dry-run set new-rev');
  assert(boxes.sent.length === 0, 'dry-run emitted ' + boxes.sent.length + ' op(s)');
  assert(deref(boxes.state).rev === snap.rev, 'dry-run moved the revision');
  assert(String(d.preview).includes('ONE'), 'dry-run preview missed the replacement');
});

const failed = results.filter(r => r[1] === 'FAIL');
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exit(failed.length ? 1 : 0);
