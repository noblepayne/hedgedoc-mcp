// model-subtree.mjs — pure subtree-read contract (WO-02).
// Runs against the compiled model modules: no socket, no boot, no note.
//   npx squint compile && node test/model-subtree.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';

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
check('tools/read-section adds writeRoundTrip only on the subtree branch', () => {
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
  assert(bodySrc.slice(condAt).includes(':writeRoundTrip false'), 'subtree branch lacks writeRoundTrip false');
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

const failed = results.filter(([, r]) => r === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
