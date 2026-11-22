// section-boundary.mjs — heading/body blank-line construction (WO-07).
// Pure: runs against the compiled model modules, no socket, no note.
//   npx squint compile && node test/section-boundary.mjs
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

// A mid-doc section (a next heading follows) and a last section. Both start
// with the 0.2.2 flush shape: no blank line after the heading.
const MID = base.normalize('## H\nbody\n\n## Next\nb\n');
const LAST = base.normalize('## H\nbody\n');

// Whole write path: resolve the range, then fold the ops.
const write = (doc, text) => {
  const r = mops.resolve_ops(doc, { 'new-section-text': text, heading: 'H' });
  return mops.apply_ops(doc, r.ops);
};
// Pure builder only (no range resolution, no :no-op gate).
const pureWrite = (doc, text) => {
  const secs = mops.parse_sections(doc);
  return mops.apply_ops(doc, mops.section_replace_ops(doc, secs, 'H', text, {}));
};
const capture = (doc) =>
  mops.read_section(mops.parse_sections(doc), doc, 'H', {}).content;
const oneBlank = (s, m) =>
  assert(!s.includes('\n\n\n'), `${m}: more than one consecutive blank line ${JSON.stringify(s)}`);

// ---------------------------------------------------------------- shapes
// [label, input, mid-doc result, last-section result]
const CASES = [
  ['text', 'text', '## H\n\ntext\n\n## Next\nb\n', '## H\n\ntext\n'],
  ['- item', '- item\n', '## H\n\n- item\n\n## Next\nb\n', '## H\n\n- item\n'],
  ['+', '+', '## H\n\n+\n\n## Next\nb\n', '## H\n\n+\n'],
  ['fenced code', '```\ncode\n```\n',
    '## H\n\n```\ncode\n```\n\n## Next\nb\n', '## H\n\n```\ncode\n```\n'],
  ['empty text', '', '## H\n\n## Next\nb\n', '## H\n'],
  ['whitespace-only text', '   ', '## H\n\n## Next\nb\n', '## H\n'],
  ['leading blank lines', '\n\nbody', '## H\n\nbody\n\n## Next\nb\n', '## H\n\nbody\n'],
  ['trailing spaces line', 'text\n   \n', '## H\n\ntext\n\n## Next\nb\n', '## H\n\ntext\n'],
];

for (const [label, input, midExpected, lastExpected] of CASES) {
  check(`mid-doc ${label}: exactly one blank line each side`, () => {
    const out = write(MID, input);
    assert(out === midExpected, `got ${JSON.stringify(out)}`);
    oneBlank(out, `mid-doc ${label}`);
  });
  check(`last section ${label}: pinned shape`, () => {
    const out = write(LAST, input);
    assert(out === lastExpected, `got ${JSON.stringify(out)}`);
    oneBlank(out, `last section ${label}`);
  });
  check(`${label}: resolve-ops path equals the pure builder`, () => {
    assert(write(MID, input) === pureWrite(MID, input), 'mid-doc paths disagree');
    assert(write(LAST, input) === pureWrite(LAST, input), 'last-section paths disagree');
  });
}

check('blank text never gains the separator: mid-doc is ## H\\n\\n## Next', () => {
  assert(write(MID, '') === write(MID, '   '), 'blank inputs diverge');
  assert(write(MID, '').indexOf('## H\n\n## Next') === 0, 'blank mid-doc is not one blank line');
});

check('empty last section is ## H\\n, not two blank lines', () => {
  assert(write(LAST, '') === '## H\n', `got ${JSON.stringify(write(LAST, ''))}`);
  assert(!write(LAST, '').endsWith('\n\n'), 'trailing double newline survived');
});

// ---------------------------------------------------------------- restores
// What the new writer produces is what a read gives back: one pass is stable.
const CONV = '## H\n\nbody\n\n## Next\nb\n';

check('conventional captured body restores unchanged (and is a :no-op)', () => {
  assert(capture(CONV) === '\nbody\n\n', `captured ${JSON.stringify(capture(CONV))}`);
  assert(pureWrite(CONV, capture(CONV)) === CONV, 'conventional restore changed bytes');
  const code = codeOf(() => mops.resolve_ops(CONV, {
    'new-section-text': capture(CONV), heading: 'H',
  }));
  assert(code === 'no-op', `conventional restore should be :no-op, got ${code}`);
});

check('pure builder returns [] for identical text (why :no-op needs resolve-ops)', () => {
  const secs = mops.parse_sections(CONV);
  const ops = mops.section_replace_ops(CONV, secs, 'H', '\nbody\n\n', {});
  assert(Array.isArray(ops) && ops.length === 0, `expected [], got ${JSON.stringify(ops)}`);
});

check('no-blank captured body gains exactly one blank line on the first restore', () => {
  const captured = capture(MID);            // "body\n\n" — 0.2.2 flush shape
  assert(captured === 'body\n\n', `captured ${JSON.stringify(captured)}`);
  const first = write(MID, captured);
  assert(first === CONV, `first restore ${JSON.stringify(first)}`);
  assert(first.length === MID.length + 1, `first restore added ${first.length - MID.length} chars`);
});

check('second restore is :no-op through resolve-ops', () => {
  const captured = capture(MID);
  const first = write(MID, captured);
  const code = codeOf(() => mops.resolve_ops(first, {
    'new-section-text': capture(first), heading: 'H',
  }));
  assert(code === 'no-op', `second restore should be :no-op, got ${code}`);
});

const failed = results.filter(([, s]) => s !== 'PASS').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
