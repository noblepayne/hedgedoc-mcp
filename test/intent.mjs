// intent.mjs — resolved-range intent contract (WO-06).
// Pure: runs against the compiled model modules, no socket, no note.
//   npx squint compile && node test/intent.mjs
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const errData = (e) => (e && (e._data || e.data)) || e;
function codeOf(fn) {
  try { fn(); } catch (e) { return errData(e).code; }
  return null;
}

// Realistic show-doc shape: a blank body line, a child section, a peer.
const doc = base.normalize('## P\n\nintro\n\n### C1\nold child\n\n## S\n\ns body\n');
const CHILD_AT = doc.indexOf('old child');
const SIBLING_AT = doc.indexOf('s body');
const intent = (pre, actual) => mops.intent_matches_QMARK_(pre, actual);

function subtreeWrite(text) {
  const resolved = mops.resolve_ops(doc, {
    'new-section-text': text,
    heading: 'P',
    level: 2,
    includeSubsections: true,
  });
  const expected = mops.apply_ops(doc, resolved.ops);
  return { resolved, expected, pre: mops.intent_pre(resolved, expected) };
}

check('subtree replace: pre carries the resolved range and write options', () => {
  const { resolved, pre } = subtreeWrite('\nintro\n\n### C1\nNEW child\n\n');
  assert(resolved['target-start'] === 5, `subtree start=${resolved['target-start']}`);
  assert(pre['target-start'] === resolved['target-start'], 'pre target-start drifted');
  assert(pre['target-end'] === resolved['target-end'], 'pre target-end drifted');
  assert(pre['include-subsections'] === true, 'include-subsections missing');
  assert(pre.level === 2, 'level missing');
  assert(pre['heading-or-nil'] === 'P', 'heading missing');
  assert(pre.occurrence == null, 'occurrence should be nil');
  assert(typeof pre['new-target-start'] === 'number', 'new target span missing');
  assert(pre['target-start'] <= CHILD_AT && CHILD_AT < pre['target-end'],
    'child change must be inside the verified range');
});

check('subtree replace applied -> true', () => {
  const { expected, pre } = subtreeWrite('\nintro\n\n### C1\nNEW child\n\n');
  assert(intent(pre, expected) === true, 'applied subtree replace not confirmed');
});

check('subtree replace rejected, child-only same-length change -> false', () => {
  const { pre } = subtreeWrite('\nintro\n\n### C1\nNEW child\n\n');
  assert(intent(pre, doc) === false, 'rejected subtree replace confirmed (false-confirm bug)');
});

check('subtree replace with a length-changing child edit -> true applied / false rejected', () => {
  const { expected, pre } = subtreeWrite('\nintro\n\n### C1\nNEW child\nsecond line\n\n');
  assert(expected.length > doc.length, 'fixture should grow');
  assert(intent(pre, expected) === true, 'applied length-changing replace not confirmed');
  assert(intent(pre, doc) === false, 'rejected length-changing replace confirmed');
});

check('overlap-check: selection inside the child aborts, outside does not', () => {
  const { pre } = subtreeWrite('\nintro\n\n### C1\nNEW child\n\n');
  const t0 = pre['target-start'];
  const t1 = pre['target-end'];
  const inside = codeOf(() => mops.overlap_check(
    { selections: [{ rev: 7, start: CHILD_AT, end: CHILD_AT + 9 }] }, t0, t1, 7));
  assert(inside === 'overlap-abort', `inside selection got ${inside}`);
  const outside = codeOf(() => mops.overlap_check(
    { selections: [{ rev: 7, start: SIBLING_AT, end: SIBLING_AT + 6 }] }, t0, t1, 7));
  assert(outside === null, `outside selection threw ${outside}`);
  // A selection on another revision is stale, not an overlap.
  const otherRev = codeOf(() => mops.overlap_check(
    { selections: [{ rev: 6, start: CHILD_AT, end: CHILD_AT + 9 }] }, t0, t1, 7));
  assert(otherRev === null, `other-rev selection threw ${otherRev}`);
});

check('level-qualified write: no duplicate-heading inside intent', () => {
  const dup = base.normalize('## Notes\na body\n\n### Notes\nb body\n\n## Tail\nt\n');
  const r = mops.resolve_ops(dup, {
    'new-section-text': 'new b\n',
    heading: 'Notes',
    level: 3,
  });
  const expected = mops.apply_ops(dup, r.ops);
  const pre = mops.intent_pre(r, expected);
  assert(intent(pre, expected) === true, 'applied level-qualified write not confirmed');
  assert(intent(pre, dup) === false, 'rejected level-qualified write confirmed');
  // The legacy heading region is level-aware too: no :duplicate-heading.
  const reg = mops.region_lines(dup, 'Notes', { level: 3 });
  assert(reg.start > 0 && reg.start < reg.end, 'level-qualified region empty');
});

check('leaf (no-flags) replace: byte-identical ops and equal-range intent', () => {
  const leaf = base.normalize('## H\nbody\n\n## Next\nb\n');
  const sections = mops.parse_sections(leaf);
  const legacyOps = mops.section_replace_ops(leaf, sections, 'H', '- item\n', {});
  const resolved = mops.resolve_ops(leaf, { 'new-section-text': '- item\n', heading: 'H' });
  assert(resolved['include-subsections'] === false, 'leaf write must not be subtree');
  assert(JSON.stringify(resolved.ops) === JSON.stringify(legacyOps),
    'default replace ops changed');
  const expected = mops.apply_ops(leaf, resolved.ops);
  // WO-07 writer shape: one constructed blank line after the heading.
  assert(expected === '## H\n\n- item\n\n## Next\nb\n', `leaf body shape=${JSON.stringify(expected)}`);
  const pre = mops.intent_pre(resolved, expected);
  assert(intent(pre, expected) === true, 'applied leaf replace not confirmed');
  assert(intent(pre, leaf) === false, 'rejected leaf replace confirmed');
});

check('length-changing delete and insert verify on the new span', () => {
  const old = base.normalize('a\nb\nc\n');
  const del = mops.delete_lines__GT_ops(old, 2, 1);
  const afterDel = mops.apply_ops(old, del.ops);
  const delPre = mops.intent_pre({ ...del, heading_or_nil: null, occurrence: null,
    level: null, include_subsections: false }, afterDel);
  assert(intent(delPre, afterDel) === true, 'applied delete not confirmed');
  assert(intent(delPre, old) === false, 'rejected delete confirmed');

  const ins = mops.insert_lines__GT_ops(old, 2, 'X\nY');
  const afterIns = mops.apply_ops(old, ins.ops);
  const insPre = mops.intent_pre({ ...ins, heading_or_nil: null, occurrence: null,
    level: null, include_subsections: false }, afterIns);
  assert(intent(insPre, afterIns) === true, 'applied insert not confirmed');
  assert(intent(insPre, old) === false, 'rejected insert confirmed');
});

const failed = results.filter(([, s]) => s !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
