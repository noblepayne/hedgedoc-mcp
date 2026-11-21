// pbt-4-replace-lines.mjs — properties for the line-oriented edit builder.
// Run: node test/pbt-4-replace-lines.mjs [seed] [runs]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const fc = require('fast-check');
import { replace_lines__GT_ops, apply_ops } from '../hedgedoc_mcp/model_ops.mjs';

const SEED = Number(process.argv[2] ?? process.env.PBT_SEED ?? (Date.now() % 2147483647));
const RUNS = Number(process.argv[3] ?? 500);

const line = fc.string({ minLength: 0, maxLength: 20 }).map(s => s.replace(/[\r\n]/g, ''));
const docLines = fc.array(line, { minLength: 1, maxLength: 12 });
const docArb = docLines.map(ls => {
  const clean = [...ls];
  while (clean.length && clean[clean.length - 1] === '') clean.pop();
  const final = clean.length ? clean : [''];
  return { ls: final, text: final.join('\n') + '\n' };
});

function editsFor(ls) {
  return fc.uniqueArray(fc.integer({ min: 1, max: ls.length }), { minLength: 1, maxLength: Math.min(4, ls.length) })
    .chain(nums => fc.tuple(
      fc.constant(nums),
      fc.array(line, { minLength: nums.length, maxLength: nums.length })
    ))
    .map(([nums, news]) => nums.map((n, i) => ({ line: n, old: ls[n - 1], new: news[i] })));
}
const docEditArb = docArb.chain(d => editsFor(d.ls).map(edits => ({ d, edits })))
  .filter(({ d, edits }) => edits.some(e => e.new !== e.old)
    // a blank final line is collapsed by document normalization; not a line-edit case
    && !edits.some(e => e.line === d.ls.length && e.new === ''));

function expected(ls, edits) {
  const out = ls.slice();
  for (const e of [...edits].sort((a, b) => b.line - a.line)) out[e.line - 1] = e.new;
  return out.join('\n') + '\n';
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const results = [];
function prop(name, arb, fn) {
  const r = fc.assert(fc.property(arb, fn), { numRuns: RUNS, seed: SEED });
  results.push([name, r === undefined ? 'PASS' : 'FAIL']);
  console.log(`[pbt-4] ${name}: PASS (runs=${RUNS})`);
}

// 1. ops reproduce the expected document exactly
prop('apply-ops == expected', docEditArb, ({ d, edits }) => {
  const { ops } = replace_lines__GT_ops(d.text, edits);
  assert(apply_ops(d.text, ops) === expected(d.ls, edits), 'mismatch');
});

// 2. batch bottom-up equals sequential single-line edits
prop('batch == sequential', docEditArb, ({ d, edits }) => {
  const { ops } = replace_lines__GT_ops(d.text, edits);
  let text = d.text;
  const ls = d.ls.slice();
  for (const e of [...edits].filter(e => e.new !== e.old).sort((a, b) => b.line - a.line)) {
    const one = replace_lines__GT_ops(text, [{ line: e.line, old: ls[e.line - 1], new: e.new }]);
    text = apply_ops(text, one.ops);
    ls[e.line - 1] = e.new;
  }
  assert(apply_ops(d.text, ops) === text, 'sequential mismatch');
});

// 3. wrong :old always rejects with line-mismatch
prop('mismatch rejects', docArb.chain(d => fc.integer({ min: 1, max: d.ls.length }).map(n => ({ d, n }))), ({ d, n }) => {
  const bogus = d.ls[n - 1] + 'x';
  try { replace_lines__GT_ops(d.text, [{ line: n, old: bogus, new: 'y' }]); }
  catch (e) { const c = e._data?.code ?? e.data?.code; assert(c === 'line-mismatch', 'wrong code ' + c); return true; }
  throw new Error('did not throw');
});

// 4. out-of-range rejects
prop('range rejects', docArb.chain(d => fc.integer({ min: -20, max: 40 }).map(n => ({ d, n }))
  .filter(({ d, n }) => n < 1 || n > d.ls.length)), ({ d, n }) => {
  try { replace_lines__GT_ops(d.text, [{ line: n, old: 'x', new: 'y' }]); }
  catch (e) { const c = e._data?.code ?? e.data?.code; assert(c === 'line-out-of-range', 'wrong code ' + c); return true; }
  throw new Error('did not throw');
});

console.log(`[pbt-4] summary: ${results.filter(r => r[1] === 'PASS').length}/${results.length} passed`);
