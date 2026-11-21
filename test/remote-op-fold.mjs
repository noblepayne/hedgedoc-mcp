// remote-op-fold.mjs — folding a human's operation must not die on the
// server's trailing-newline tail, and core must actually import model_ops.
// Regression for: core.cljs used ops/apply-ops without requiring the ns, so
// the first remote keystroke threw ReferenceError -> resync -> rev -1 -> all
// writes blocked forever.
import { readFileSync } from 'node:fs';
import * as ops from '../hedgedoc_mcp/model_ops.mjs';
import * as m from '../hedgedoc_mcp/model.mjs';

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
const tailOf = (raw) => m.utf16_length(raw) - m.utf16_length(m.normalize(raw));

// 1. Remote op on a doc whose server form ends with extra newlines.
{
  const raw = 'a\n\n\n';              // normalized "a\n", tail 2
  const wire = [['retain', 1], ['insert', 'X'], ['retain', 3]];
  const out = ops.apply_ops_raw(raw, wire);
  check(out === 'aX\n\n\n', `fold preserves the tail (${JSON.stringify(out)})`);
  check(m.normalize(out) === 'aX\n', 'normalized content folds correctly');
  check(tailOf(out) === 2, 'tail recomputed as 2');
}

// 2. Middle insert.
{
  const out = ops.apply_ops_raw('abc\n', [['retain', 1], ['insert', 'X'], ['retain', 3]]);
  check(out === 'aXbc\n', `middle insert lands (${JSON.stringify(out)})`);
  check(tailOf(out) === 0, 'no tail invented');
}

// 3. Large read-only note: remote retention must not hit the write cap.
{
  const raw = 'a'.repeat(150000) + '\n';
  let ok = true;
  try { ops.apply_ops_raw(raw, [['retain', raw.length]]); } catch { ok = false; }
  check(ok, 'remote fold is not capped at 100KB');
}

// 4. Front matter is not markdown.
{
  const doc = '---\ntags: LUP\n# not a heading\n---\n# Real\n\nbody\n';
  const heads = ops.parse_sections(m.normalize(doc)).map((s) => s.heading);
  check(heads.length === 1 && heads[0] === 'Real', `front matter skipped (${JSON.stringify(heads)})`);
}

// 5. Trailing hashes need whitespace to close a heading.
{
  const c = ops.parse_sections(m.normalize('# C#\n\nx\n')).map((s) => s.heading);
  const d = ops.parse_sections(m.normalize('# C #\n\nx\n')).map((s) => s.heading);
  check(c[0] === 'C#', `C# keeps its hash (${JSON.stringify(c)})`);
  check(d[0] === 'C', `"C #" closes (${JSON.stringify(d)})`);
}

// 6. The compiled core must import model_ops.
{
  const src = readFileSync(new URL('../hedgedoc_mcp/core.mjs', import.meta.url), 'utf8');
  check(/import \* as ops from '\.\/model_ops\.mjs'/.test(src), 'core.mjs imports model_ops');
  check(src.includes('ops.apply_ops_raw'), 'core folds remote ops with apply_ops_raw');
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
