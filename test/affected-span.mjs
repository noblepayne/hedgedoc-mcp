// affected-span.mjs — pure dry-run span/preview contract (WO-04).
// Runs against the compiled model modules: no socket, no boot, no note.
//   npx squint compile && node test/affected-span.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';
import * as tools from '../hedgedoc_mcp/tools.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const src = (p) => readFileSync(fileURLToPath(new URL(`../src/hedgedoc_mcp/${p}`, import.meta.url)), 'utf8');
// affected_span returns hyphenated keyword keys; keep them for preview_dry_run
// and expose short numeric fields for assertions.
function span(r) {
  return { 'old-start': r['old-start'], 'old-end': r['old-end'],
           'new-start': r['new-start'], 'new-end': r['new-end'],
           o0: r['old-start'], o1: r['old-end'], n0: r['new-start'], n1: r['new-end'] };
}
const preview = (r) => ({ text: r.preview, lines: r['preview-lines'], mode: r['preview-mode'],
                          total: r['preview-total-lines'], truncated: r['preview-truncated'] });

// ---------------------------------------------------------------- raw ops
check('raw ops: delete+insert spans are exact', () => {
  const s = span(mops.affected_span([['retain', 10], ['delete', 4], ['insert', 'XY'], ['retain', 5]]));
  assert(s.o0 === 10 && s.o1 === 14, `old [${s.o0},${s.o1}]`);
  assert(s.n0 === 10 && s.n1 === 12, `new [${s.n0},${s.n1}]`);
});
check('raw ops: pure insert has an empty old span', () => {
  const s = span(mops.affected_span([['retain', 3], ['insert', 'abc'], ['retain', 2]]));
  assert(s.o0 === 3 && s.o1 === 3, `old [${s.o0},${s.o1}]`);
  assert(s.n0 === 3 && s.n1 === 6, `new [${s.n0},${s.n1}]`);
});
check('raw ops: pure delete has an empty new span', () => {
  const s = span(mops.affected_span([['delete', 4], ['retain', 6]]));
  assert(s.o0 === 0 && s.o1 === 4, `old [${s.o0},${s.o1}]`);
  assert(s.n0 === 0 && s.n1 === 0, `new [${s.n0},${s.n1}]`);
});

// ---------------------------------------------------------------- fixture
// 9 logical lines; Alpha's body ends at the "## Beta" heading, which sits in
// the middle of the note, so "section end" and "note end" differ everywhere.
const doc = base.normalize('# Alpha\none\ntwo\nthree\n\n## Beta\nb1\nb2\n');
const alphaEnd = doc.indexOf('## Beta');

check('insert-lines: old span is a point, new span is the block', () => {
  const r = mops.insert_lines__GT_ops(doc, 3, 'INSERTED');
  const s = span(mops.affected_span(r.ops));
  assert(s.o0 === s.o1, 'insert old span is not a point');
  assert(s.n1 - s.n0 === base.utf16_length(base.normalize('INSERTED')),
    'new span does not cover the block');
  const p = preview(tools.preview_dry_run('region', mops.apply_ops(doc, r.ops), doc, s, 0));
  assert(p.text.includes('INSERTED'), `region missed the insert: ${JSON.stringify(p.text)}`);
});
check('delete-lines: old span is the removed lines, new span empty', () => {
  const r = mops.delete_lines__GT_ops(doc, 3, 2); // "two".."three"
  const s = span(mops.affected_span(r.ops));
  assert(s.n0 === s.n1, 'delete new span is not empty');
  assert(s.o1 > s.o0, 'old span empty');
  const p = preview(tools.preview_dry_run('region', mops.apply_ops(doc, r.ops), doc, s, 0));
  assert(p.text.includes('two') && p.text.includes('three'),
    `delete preview missed lines: ${JSON.stringify(p.text)}`);
});
check('replace-lines: spans are exactly the edited line', () => {
  const r = mops.replace_lines__GT_ops(doc, [{ line: 3, old: 'two', new: 'TWO!' }]);
  const s = span(mops.affected_span(r.ops));
  assert(s.o1 - s.o0 === 3, `old width ${s.o1 - s.o0}`);
  assert(s.n1 - s.n0 === 4, `new width ${s.n1 - s.n0}`);
  const p = preview(tools.preview_dry_run('region', mops.apply_ops(doc, r.ops), doc, s, s.o0));
  assert(p.text === '3 | TWO!', `region ${JSON.stringify(p.text)}`);
});

// ------------------------------------------------------- append + new-section
check('append-to-section previews its own block, not the note end', () => {
  const secs = mops.parse_sections(doc);
  const opList = mops.append_to_section_ops(doc, secs, 'Alpha', 'APPENDED', {});
  const s = span(mops.affected_span(opList));
  assert(s.o0 === alphaEnd && s.o1 === alphaEnd, `old [${s.o0},${s.o1}] != ${alphaEnd}`);
  const newDoc = mops.apply_ops(doc, opList);
  const p = preview(tools.preview_dry_run('region', newDoc, doc, s, s.o0));
  assert(p.text.includes('APPENDED'), `region missed the block: ${JSON.stringify(p.text)}`);
  assert(!p.text.includes('b1') && !p.text.includes('b2'),
    `region ran to the note end: ${JSON.stringify(p.text)}`);
  assert(p.lines['start-line'] <= p.lines['end-line'], 'bad preview-lines');
});
check('new-section-text region and tail show the section end', () => {
  const secs = mops.parse_sections(doc);
  const body = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
  const opList = mops.section_replace_ops(doc, secs, 'Beta', body, {});
  const s = span(mops.affected_span(opList));
  const newDoc = mops.apply_ops(doc, opList);
  const reg = preview(tools.preview_dry_run('region', newDoc, doc, s, s.o0));
  const tail = preview(tools.preview_dry_run('tail', newDoc, doc, s, s.o0));
  assert(reg.text.includes('row 30'), `region missed the last body line: ${JSON.stringify(reg.text)}`);
  assert(tail.text.includes('row 30'), `tail missed the last body line: ${JSON.stringify(tail.text)}`);
  assert(tail.text.trim().split('\n').length <= 12,
    `tail is not the last 12 lines: ${JSON.stringify(tail.text)}`);
  assert(tail.lines['end-line'] === reg.lines['end-line'], 'tail end != region end');
  assert(tail.total === reg.total, `total mismatch ${tail.total} vs ${reg.total}`);
});

// ---------------------------------------------------------------- caps
const bigBody = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const bigRepl = Array.from({ length: 250 }, (_, i) => `row ${i + 1}`).join('\n') + '\n';
const bigDoc = base.normalize('# Big\n' + bigBody + '## After\nz\n');
check('region cap: 200 lines max, total reports the whole range', () => {
  const secs = mops.parse_sections(bigDoc);
  const opList = mops.section_replace_ops(bigDoc, secs, 'Big', bigRepl, {});
  const s = span(mops.affected_span(opList));
  const newDoc = mops.apply_ops(bigDoc, opList);
  const p = preview(tools.preview_dry_run('region', newDoc, bigDoc, s, s.o0));
  const kept = p.text.split('\n').length;
  assert(kept <= 200, `preview has ${kept} lines`);
  assert(p.total >= 250, `total-lines ${p.total} not the pre-truncation range`);
  assert(p.truncated === true, 'truncation not reported');
  assert(base.utf16_length(p.text) <= 4000, `preview is ${base.utf16_length(p.text)} units`);
});
check('region cap: 4000 UTF-16 units wins on long lines', () => {
  const longBody = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(300, 'x')).join('\n') + '\n';
  const longRepl = Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(300, 'y')).join('\n') + '\n';
  const d = base.normalize('# L\n' + longBody + '## After\nz\n');
  const secs = mops.parse_sections(d);
  const opList = mops.section_replace_ops(d, secs, 'L', longRepl, {});
  const s = span(mops.affected_span(opList));
  const newDoc = mops.apply_ops(d, opList);
  const p = preview(tools.preview_dry_run('region', newDoc, d, s, s.o0));
  assert(p.text.split('\n').length < 40, 'unit cap did not bite');
  assert(base.utf16_length(p.text) <= 4000, `preview is ${base.utf16_length(p.text)} units`);
  assert(p.truncated === true, 'truncation not reported');
});
check('default mode is window and stays small around the target', () => {
  const s = span(mops.affected_span([['retain', alphaEnd], ['insert', 'X\n'], ['retain', 1]]));
  const p = preview(tools.preview_dry_run(null, doc, doc, s, alphaEnd));
  assert(p.mode === 'window', `mode ${p.mode}`);
  assert(['start-line', 'end-line'].every(k => Number.isInteger(p.lines[k])),
    `bad preview-lines ${JSON.stringify(p.lines)}`);
  assert(p.text.split('\n').length <= 13, 'window grew');
});
check('tail keeps at most 12 lines even on a huge range', () => {
  const secs = mops.parse_sections(bigDoc);
  const opList = mops.section_replace_ops(bigDoc, secs, 'Big', bigRepl, {});
  const s = span(mops.affected_span(opList));
  const newDoc = mops.apply_ops(bigDoc, opList);
  const p = preview(tools.preview_dry_run('tail', newDoc, bigDoc, s, s.o0));
  assert(p.text.split('\n').length <= 12, `tail has ${p.text.split('\n').length} lines`);
  assert(p.text.includes('row 250'), 'tail did not reach the end');
  assert(p.total >= 250, 'tail total is not the full range');
  assert(p.truncated === true, 'tail truncation not reported');
});

// ------------------------------------------------------- wiring contracts
check('dry-run result keeps written false and never sets new-rev', () => {
  const t = src('tools.cljs');
  const i = t.indexOf('(when dry-run?');
  const block = t.slice(i, i + 1400);
  assert(/:written false/.test(block), 'dry-run lost written false');
  assert(!/:new-rev/.test(block), 'dry-run branch sets new-rev');
  assert(/preview-dry-run/.test(block), 'dry-run did not route through preview-dry-run');
});
check('schema declares preview on exactly the five dry-run write tools', () => {
  const s = src('schema.cljs');
  const names = [...s.matchAll(/\{:name "([^"]+)"([\s\S]*?)(?=\{:name "|$)/g)]
    .filter(m => m[2].includes(':preview {:enum ["window" "region" "tail"]'))
    .map(m => m[1]).sort();
  assert(JSON.stringify(names) ===
    JSON.stringify(['append-to-section', 'apply-ops', 'delete-lines', 'insert-lines', 'replace-lines']),
    `preview tools: ${names}`);
});
check('all five handlers forward preview', () => {
  const c = src('core.cljs');
  const n = (c.match(/:preview \(:preview args\)/g) || []).length;
  assert(n === 5, `preview forwarded ${n} times, expected 5`);
});
check('preview-chars is gone (no dead key)', () => {
  assert(!src('tools.cljs').includes('preview-chars'), 'preview-chars still referenced');
});

const failed = results.filter(r => r[1] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
