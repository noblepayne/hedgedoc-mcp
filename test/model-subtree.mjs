// model-subtree.mjs — pure subtree-read contract (WO-02).
// Runs against the compiled model modules: no socket, no boot, no note.
//   npx squint compile && node test/model-subtree.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atom, deref } from 'squint-cljs/src/squint/core.js';
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';
import * as tools from '../hedgedoc_mcp/tools.mjs';
import * as st from '../hedgedoc_mcp/state.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const errData = (e) => e && (e._data || e.data) || e;
function codeOf(fn) {
  try { fn(); } catch (e) { return errData(e).code; }
  return null;
}
function dataOf(fn) {
  try { fn(); } catch (e) { return errData(e); }
  return null;
}
const TICK = '\x60'.repeat(3);
const body = (doc, r) => doc.slice(r.start, r.end);

// ---------------------------------------------------------------- fixture
const raw = readFileSync(fileURLToPath(new URL('./fixtures/source.md', import.meta.url)), 'utf8');
const doc = base.normalize(raw);
const secs = mops.parse_sections(doc);

check('fixture front matter: first section is the H1, YAML is not a section', () => {
  assert(secs.length > 100, `too few sections: ${secs.length}`);
  assert(secs[0].level === 1 && secs[0].heading === 'EXAMPLE 000', `first=${JSON.stringify(secs[0])}`);
  assert(secs[0].start > 0, 'H1 should start after the front matter');
  assert(!secs.some(s => /^tags\s*:/i.test(s.heading)), 'front matter leaked as a heading');
});

check('fixture: H1 subtree runs through children to doc end', () => {
  const sub = mops.subtree_range(secs, doc, 'EXAMPLE 000', { level: 1 });
  const plain = mops.read_section(secs, doc, 'EXAMPLE 000', {});
  const subContent = body(doc, sub);
  assert(sub.start === plain.start, 'subtree start moved');
  assert(subContent.startsWith(plain.content), 'subtree must extend the default body');
  assert(subContent.includes('#### SPONSORS'), 'child heading missing from H1 subtree');
  assert(subContent.includes('### Filler 120'), 'deep child missing from H1 subtree');
  assert(sub.end === doc.length, `H1 subtree must end at doc end, got ${sub.end}/${doc.length}`);
  assert(!subContent.includes('tags: EXAMPLE'), 'front matter leaked into the subtree');
});

check('fixture: nested child is included and the subtree stops at the parent peer', () => {
  const sub = mops.subtree_range(secs, doc, 'Pre-Pre-Show', { level: 2 });
  const plain = mops.read_section(secs, doc, 'Pre-Pre-Show', {});
  const want = '### Segment One\n+ Synthetic talking point A.\n+ Synthetic talking point B.\n\n';
  assert(plain.content === '', `default read should stop at the child heading, got ${JSON.stringify(plain.content)}`);
  assert(body(doc, sub) === want, `subtree body=${JSON.stringify(body(doc, sub))}`);
  assert(doc.slice(sub.end).startsWith('## Pre-Show'), 'subtree must stop at the next level-2 heading');
});

check('fixture: last section ends at doc end', () => {
  const sub = mops.subtree_range(secs, doc, 'Filler 120', { level: 3 });
  const plain = mops.read_section(secs, doc, 'Filler 120', {});
  assert(sub.end === doc.length, `end=${sub.end}/${doc.length}`);
  assert(body(doc, sub) === '+ Synthetic filler line 120.\n', `content=${JSON.stringify(body(doc, sub))}`);
  assert(plain.content === body(doc, sub), 'leaf section: default and subtree must agree');
});

check('fixture: default read keeps exactly {start,end,content} and the body only', () => {
  const plain = mops.read_section(secs, doc, 'Pre-Pre-Show', {});
  assert(JSON.stringify(Object.keys(plain).sort()) === JSON.stringify(['content', 'end', 'start']),
    `keys=${Object.keys(plain)}`);
  const anchored = mops.section_anchor(secs, doc, 'Pre-Pre-Show', { level: 2 });
  assert(plain.start === anchored.start && plain.end === anchored.end, 'read-section drifted from section-anchor');
  assert(plain.content === '', 'default read must not include the child heading');
});

// ---------------------------------------------------------------- synthetic edge cases
const fenceDoc = base.normalize(`## Parent\nintro\n${TICK}\n## Fake in fence\n${TICK}\nafter\n## Real\nreal body\n`);
const fenceSecs = mops.parse_sections(fenceDoc);

check('a heading inside a backtick fence does not terminate the subtree', () => {
  const names = fenceSecs.map(s => s.heading).join(',');
  assert(names === 'Parent,Real', `sections=${names}`);
  const sub = mops.subtree_range(fenceSecs, fenceDoc, 'Parent', { level: 2 });
  const subContent = body(fenceDoc, sub);
  assert(subContent.includes('## Fake in fence'), 'fenced heading text must stay in the body');
  assert(subContent.includes('after'), 'body after the fence must stay in the subtree');
  assert(!subContent.includes('real body'), 'subtree must end at the real level-2 heading');
  assert(codeOf(() => mops.section_anchor(fenceSecs, fenceDoc, 'Fake in fence', {})) === 'missing-heading',
    'fenced heading must not be a section');
});

const eofDoc = base.normalize('# Top\nbody\n## Last\n');

check('heading at EOF returns an empty subtree', () => {
  const secs2 = mops.parse_sections(eofDoc);
  const sub = mops.subtree_range(secs2, eofDoc, 'Last', { level: 2 });
  assert(sub.start === eofDoc.length && sub.end === eofDoc.length,
    `range=${sub.start}..${sub.end}/${eofDoc.length}`);
  assert(body(eofDoc, sub) === '', `content=${JSON.stringify(body(eofDoc, sub))}`);
});

const dupDoc = base.normalize('# Doc\n## Notes\nouter one\n### Notes\ninner\n## Notes\nouter two\n## Next\nnext body\n');
// Squint compiles (assoc seen k ...) with a literal key; parse-sections must
// still report occurrence 0, 1 for same-level duplicates.
const sameDupDoc = base.normalize('# X\n\na\n\n# X\n\nb\n');
const sameDupSecs = mops.parse_sections(sameDupDoc);
check('parse-sections occurrence increments for same-level duplicates', () => {
  assert(sameDupSecs.length === 2, `count=${sameDupSecs.length}`);
  assert(sameDupSecs[0].occurrence === 0 && sameDupSecs[1].occurrence === 1,
         `occurrences=${sameDupSecs.map((s) => s.occurrence)}`);
});

const dupSecs = mops.parse_sections(dupDoc);

check('same-name headings at different levels: level filters before occurrence', () => {
  const outer = mops.section_anchor(dupSecs, dupDoc, 'Notes', { level: 2, occurrence: 0 });
  const inner = mops.section_anchor(dupSecs, dupDoc, 'Notes', { level: 3 });
  const second = mops.section_anchor(dupSecs, dupDoc, 'Notes', { level: 2, occurrence: 1 });
  assert(body(dupDoc, outer) === 'outer one\n', `outer=${JSON.stringify(body(dupDoc, outer))}`);
  assert(body(dupDoc, inner) === 'inner\n', `inner=${JSON.stringify(body(dupDoc, inner))}`);
  assert(body(dupDoc, second) === 'outer two\n', `occurrence after filter=${JSON.stringify(body(dupDoc, second))}`);
  const sub = mops.subtree_range(dupSecs, dupDoc, 'Notes', { level: 2, occurrence: 0 });
  assert(body(dupDoc, sub) === 'outer one\n### Notes\ninner\n',
    `parent subtree=${JSON.stringify(body(dupDoc, sub))}`);
});

check('level duplicate detection runs after the filter; no level still errors', () => {
  const blind = dataOf(() => mops.section_anchor(dupSecs, dupDoc, 'Notes', {}));
  assert(blind.code === 'duplicate-heading', `code=${blind.code}`);
  assert(blind.candidates.length === 3, `blind candidates=${JSON.stringify(blind.candidates)}`);
  const atLevel = dataOf(() => mops.section_anchor(dupSecs, dupDoc, 'Notes', { level: 2 }));
  assert(atLevel.code === 'duplicate-heading', `level code=${atLevel.code}`);
  assert(atLevel.candidates.length === 2 && atLevel.candidates.every(c => c.level === 2),
    `level candidates=${JSON.stringify(atLevel.candidates)}`);
});

check('a missing level is missing-heading with candidates, never a fallback', () => {
  const d = dataOf(() => mops.section_anchor(dupSecs, dupDoc, 'Notes', { level: 4 }));
  assert(d.code === 'missing-heading', `code=${d.code}`);
  assert(d.level === 4, `level=${d.level}`);
  assert(Array.isArray(d.candidates) && d.candidates.map(c => c.level).join(',') === '2,3,2',
    `candidates=${JSON.stringify(d.candidates)}`);
  assert(codeOf(() => mops.section_anchor(dupSecs, dupDoc, 'Nope', { level: 2 })) === 'missing-heading',
    'unknown heading at a level must still be missing-heading');
});

const indentedDoc = base.normalize('## Parent\nbody\n  ## Indented\nstill body\n## Real\nx\n');

check('indented ATX heading is invisible: body continues past it', () => {
  const secs2 = mops.parse_sections(indentedDoc);
  assert(secs2.map(s => s.heading).join(',') === 'Parent,Real', `sections=${secs2.map(s => s.heading)}`);
  const sub = mops.subtree_range(secs2, indentedDoc, 'Parent', { level: 2 });
  assert(body(indentedDoc, sub) === 'body\n  ## Indented\nstill body\n',
    `content=${JSON.stringify(body(indentedDoc, sub))}`);
  assert(codeOf(() => mops.section_anchor(secs2, indentedDoc, 'Indented', {})) === 'missing-heading',
    'indented heading must not be a section');
});

const tildeDoc = base.normalize('## Parent\nbody\n~~~\n## Fake\n~~~\n## Real\nx\n');

check('~~~ is not a fence: a heading inside it terminates the subtree', () => {
  const secs2 = mops.parse_sections(tildeDoc);
  assert(secs2.map(s => s.heading).join(',') === 'Parent,Fake,Real', `sections=${secs2.map(s => s.heading)}`);
  const sub = mops.subtree_range(secs2, tildeDoc, 'Parent', { level: 2 });
  assert(body(tildeDoc, sub) === 'body\n~~~\n', `content=${JSON.stringify(body(tildeDoc, sub))}`);
  assert(!body(tildeDoc, sub).includes('## Fake'), 'documented limitation: ~~~ does not protect a heading');
});

// ---------------------------------------------------------------- wiring contracts
const toolsSrc = readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/tools.cljs', import.meta.url)), 'utf8');
check('tools/read-section adds writeRoundTrip true and the anchor only on the subtree branch', () => {
  const start = toolsSrc.indexOf('(defn read-section');
  const end = toolsSrc.indexOf(';; ---------- preview + line helpers');
  assert(start >= 0 && end > start, 'read-section not found');
  const bodySrc = toolsSrc.slice(start, end);
  const condAt = bodySrc.indexOf('(cond->');
  assert(condAt > 0, 'expected a cond-> in read-section');
  assert(bodySrc.includes('{:keys [heading occurrence level includeSubsections]}'),
    'level/includeSubsections destructured out');
  assert(!bodySrc.slice(0, condAt).includes(':writeRoundTrip'),
    'writeRoundTrip must not be unconditional');
  assert(bodySrc.slice(condAt).includes(':writeRoundTrip true'), 'subtree branch lacks writeRoundTrip true');
  for (const k of [':heading heading', ':level level', ':occurrence occurrence',
                   ':includeSubsections true']) {
    assert(bodySrc.slice(condAt).includes(k), `subtree branch does not echo ${k}`);
  }
  assert(bodySrc.slice(condAt).includes(':hint'), 'subtree branch lacks the hint');
});

const coreSrc = readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/core.cljs', import.meta.url)), 'utf8');
check('handle-read-section forwards level/includeSubsections and bounds level 1..6', () => {
  const start = coreSrc.indexOf('(defn- handle-read-section');
  const end = coreSrc.indexOf('(defn- handle-read-note');
  assert(start >= 0 && end > start, 'handler not found');
  const handler = coreSrc.slice(start, end);
  assert(handler.includes(':level (checked-level args)'), 'level not forwarded');
  assert(handler.includes(':includeSubsections (true? (:includeSubsections args))'), 'includeSubsections not forwarded');
  const ls = coreSrc.indexOf('(defn- checked-level');
  const levelFn = coreSrc.slice(ls, start);
  assert(levelFn.includes('(< v 1)') && levelFn.includes('(> v 6)'), 'level bounds missing');
});

const schemaSrc = readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/schema.cljs', import.meta.url)), 'utf8');
check('read-section schema declares both new arguments', () => {
  assert(schemaSrc.includes(':includeSubsections {:type "boolean" :default false}'),
    'includeSubsections schema missing');
  assert(schemaSrc.includes(':level {:type "integer" :minimum 1 :maximum 6}'),
    'level schema missing');
});

// ---------------------------------------------------------------- WO-08 write contracts
// A show-doc parent with one child and a following sibling.
const wdoc = base.normalize('## P\nintro\n\n### C1\nold child\n\n## S\ns body\n');
const wsecs = mops.parse_sections(wdoc);
const CHILD_AT = wdoc.indexOf('old child');

function fakeEnv(content) {
  const state = atom(st.make_initial('n', 3, content, 0));
  const snap = st.snapshot_for_cas(state);
  const boxes = { sent: [], state, snap, presence: { users: [], selections: [] } };
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
  return { env, boxes, snap };
}

check('subtree append lands after the last child and keeps the blank line', () => {
  const range = mops.write_range(wsecs, wdoc, 'P', { level: 2, includeSubsections: true });
  assert(range.end === wdoc.indexOf('## S'), `range end=${range.end}`);
  const ops = mops.append_to_section_ops(wdoc, wsecs, 'P', '+ A\n',
    { level: 2, includeSubsections: true });
  const out = mops.apply_ops(wdoc, ops);
  assert(out === '## P\nintro\n\n### C1\nold child\n\n+ A\n\n## S\ns body\n',
    `append=${JSON.stringify(out)}`);
  assert(!out.includes('+ A\n## S'), 'append lost the blank line before the next sibling');
});

check('subtree replace removes the children and keeps the heading line', () => {
  const ops = mops.section_replace_ops(wdoc, wsecs, 'P', 'NEW body\n',
    { level: 2, includeSubsections: true });
  const out = mops.apply_ops(wdoc, ops);
  assert(out === '## P\n\nNEW body\n\n## S\ns body\n', `replace=${JSON.stringify(out)}`);
  assert(out.startsWith('## P\n'), 'heading line was not preserved');
  assert(!out.includes('### C1') && !out.includes('old child'), 'children survived a subtree replace');
});

check('level-qualified same-name write hits only the matching subtree', () => {
  const dup = base.normalize('## Notes\na body\n\n### Notes\nb body\n\n## Tail\nt\n');
  const dsecs = mops.parse_sections(dup);
  const app = mops.apply_ops(dup, mops.append_to_section_ops(dup, dsecs, 'Notes', 'ADDED\n',
    { level: 3, includeSubsections: true }));
  assert(app === '## Notes\na body\n\n### Notes\nb body\n\nADDED\n\n## Tail\nt\n',
    `level append=${JSON.stringify(app)}`);
  const rep = mops.apply_ops(dup, mops.section_replace_ops(dup, dsecs, 'Notes', 'inner new\n',
    { level: 3 }));
  assert(rep === '## Notes\na body\n\n### Notes\n\ninner new\n\n## Tail\nt\n',
    `level replace=${JSON.stringify(rep)}`);
});

check('flag-off output equals the WO-07 writer (not 0.2.2)', () => {
  const leaf = base.normalize('## H\nbody\n\n## Next\nb\n');
  const lsecs = mops.parse_sections(leaf);
  const plainRep = mops.apply_ops(leaf, mops.section_replace_ops(leaf, lsecs, 'H', '- item\n', {}));
  const flagsRep = mops.apply_ops(leaf, mops.section_replace_ops(leaf, lsecs, 'H', '- item\n',
    { includeSubsections: false, level: 2 }));
  assert(plainRep === '## H\n\n- item\n\n## Next\nb\n', `WO-07 shape drifted: ${JSON.stringify(plainRep)}`);
  assert(flagsRep === plainRep, 'explicit false flag changed the leaf replace shape');
  const plainApp = mops.apply_ops(leaf, mops.append_to_section_ops(leaf, lsecs, 'H', 'X\n', {}));
  const flagsApp = mops.apply_ops(leaf, mops.append_to_section_ops(leaf, lsecs, 'H', 'X\n',
    { includeSubsections: false, level: 2 }));
  assert(plainApp === '## H\nbody\n\nX\n\n## Next\nb\n', `leaf append drifted: ${JSON.stringify(plainApp)}`);
  assert(flagsApp === plainApp, 'explicit false flag changed the leaf append shape');
  assert(plainRep !== '## H\n- item\n\n## Next\nb\n', 'leaf replace regressed to the 0.2.2 flush body');
});

check('read-section echoes the write anchor and keeps the default shape', () => {
  const { env } = fakeEnv(wdoc);
  const sub = tools.read_section(env, { heading: 'P', level: 2, occurrence: 0, includeSubsections: true });
  assert(sub.writeRoundTrip === true, `writeRoundTrip=${sub.writeRoundTrip}`);
  assert(sub.heading === 'P' && sub.level === 2 && sub.occurrence === 0
    && sub.includeSubsections === true, `anchor=${JSON.stringify(sub)}`);
  assert(typeof sub.hint === 'string' && sub.hint.length > 0, 'no subtree hint');
  assert(sub.start === 5 && sub.content.includes('### C1'), 'subtree slice changed');
  const plain = tools.read_section(env, { heading: 'P', level: 2 });
  assert(JSON.stringify(Object.keys(plain).sort()) === JSON.stringify(['content', 'end', 'hash', 'rev', 'start']),
    `default read keys=${Object.keys(plain)}`);
  assert(plain.writeRoundTrip === undefined, 'writeRoundTrip leaked into a default read');
});

check('subtree append dry-run writes nothing and keeps the resolved range', () => {
  const { env, boxes, snap } = fakeEnv(wdoc);
  let d = null;
  try {
    tools.append_to_section(env, { heading: 'P', text: '+ A\n',
      'base-rev': snap.rev, 'base-hash': snap.hash,
      dryRun: true, includeSubsections: true, level: 2, preview: 'region' });
  } catch (e) { d = errData(e); }
  assert(d && d.code === 'dry-run-preview', `dry-run code=${d && d.code}`);
  assert(d.written === false, 'dry-run did not report written false');
  assert(d['new-rev'] === undefined, 'dry-run set new-rev');
  assert(boxes.sent.length === 0, `dry-run emitted ${boxes.sent.length} op(s)`);
  assert(deref(boxes.state).rev === snap.rev, 'dry-run moved the revision');
  assert(d.ops[0][0] === 'retain' && d.ops[0][1] === wdoc.indexOf('## S'),
    `append did not start from the subtree end: ${JSON.stringify(d.ops[0])}`);
  assert(String(d.preview).includes('+ A'), `region preview missed the block: ${JSON.stringify(d.preview)}`);
});

check('subtree append target feeds overlap-check (child selection aborts)', () => {
  const { env, boxes, snap } = fakeEnv(wdoc);
  boxes.presence = { users: [], selections: [{ rev: snap.rev, start: CHILD_AT, end: CHILD_AT + 9 }] };
  let code = null;
  try {
    tools.append_to_section(env, { heading: 'P', text: '+ A\n',
      'base-rev': snap.rev, 'base-hash': snap.hash,
      includeSubsections: true, level: 2 });
  } catch (e) { code = errData(e).code; }
  assert(code === 'overlap-abort', `child selection did not abort: ${code}`);
  assert(boxes.sent.length === 0, 'overlap-abort still emitted');
});

check('handlers forward the flags and reject raw ops + flags', () => {
  const coreSrc2 = readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/core.cljs', import.meta.url)), 'utf8');
  const a0 = coreSrc2.indexOf('(defn- handle-apply-ops');
  const a1 = coreSrc2.indexOf('(defn- handle-append-to-section');
  const a2 = coreSrc2.indexOf('(defn- handle-set-note');
  assert(a0 >= 0 && a1 > a0 && a2 > a1, 'handlers not found');
  const applyH = coreSrc2.slice(a0, a1);
  const appendH = coreSrc2.slice(a1, a2);
  assert(applyH.includes('has-subtree-flag?')
    && applyH.includes('(contains? args :includeSubsections)')
    && applyH.includes('(contains? args :level)'), 'raw ops + flags not detected');
  assert(/\(when \(and has-ops\? has-subtree-flag\?\)[\s\S]*?:bad-args/.test(applyH),
    'raw ops + flags not rejected as bad-args');
  for (const h of [applyH, appendH]) {
    assert(h.includes(':includeSubsections (true? (:includeSubsections args))'),
      'includeSubsections not forwarded');
    assert(h.includes(':level (checked-level args)'), 'level not forwarded via checked-level');
  }
});

check('schema advertises subtree flags and drops the read-only claim', () => {
  const blockOf = (name) => {
    const i = schemaSrc.indexOf(`{:name "${name}"`);
    const j = schemaSrc.indexOf('{:name "', i + 1);
    assert(i >= 0, `schema ${name} missing`);
    return schemaSrc.slice(i, j < 0 ? schemaSrc.length : j);
  };
  for (const name of ['apply-ops', 'append-to-section']) {
    const b = blockOf(name);
    assert(b.includes(':includeSubsections {:type "boolean" :default false}'),
      `${name} lacks includeSubsections`);
    assert(b.includes(':level {:type "integer" :minimum 1 :maximum 6}'), `${name} lacks level 1..6`);
  }
  const read = blockOf('read-section');
  assert(read.includes('writeRoundTrip true'), 'read-section still says writeRoundTrip false');
  assert(!read.includes('writeRoundTrip false'), 'stale writeRoundTrip false description');
  assert(!blockOf('apply-ops').includes('BODY only'), 'stale BODY-only description');
  assert(blockOf('append-to-section').includes('includeSubsections true'), 'append description not updated');
});

const failed = results.filter(([, r]) => r === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
