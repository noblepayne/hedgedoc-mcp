// pbt-3-invariants.mjs — slice 3: serialization roundtrip, position monotonicity,
// weak intention, every-run invariants. Pure only, no server.
//
// Contracts assumed:
//   - docArb (from ./pbt-1-gens.mjs) is a fast-check Arbitrary yielding either a
//     normalized doc string or an object with a string .content/.text field.
//   - Pure calcs imported from hedgedoc_mcp/model.mjs + model_ops.mjs.
//
// Run: node pbt-3-invariants.mjs [seed]
//   PBT_SEED env also honored. numRuns=1000 per property, seed logged.
import { docArb } from './pbt-1-gens.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const fc = require('fast-check');

import {
  normalize, utf16_length, trailing_nl_valid_QMARK_,
} from '../hedgedoc_mcp/model.mjs';
import {
  apply_ops, content__GT_ops, max_content_units,
  fence_odd_QMARK_, snap_back,
} from '../hedgedoc_mcp/model_ops.mjs';

const NUM_RUNS = 1000;
const SEED = Number(process.argv[2] ?? process.env.PBT_SEED ?? (Date.now() % 2147483647));

// --- small helpers (pure) -------------------------------------------------
function asText(sample) {
  if (typeof sample === 'string') return sample;
  if (sample && typeof sample.content === 'string') return sample.content;
  if (sample && typeof sample.text === 'string') return sample.text;
  return String(sample);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function countPicks(s) {
  let n = 0;
  for (const line of s.split('\n')) if (/^###\s*\[Pick:/.test(line)) n++;
  return n;
}
// Map an old-doc anchor through an op list (left-bias at insert points:
// anchor exactly at an insert point stays before the inserted text).
function mapPos(ops, pos) {
  let o = 0, n = 0;
  for (const step of ops) {
    const op = step[0], a = step[1];
    if (op === 'retain') {
      if (pos < o + a) return n + (pos - o);
      o += a; n += a;
    } else if (op === 'delete') {
      if (pos < o + a) return n; // inside deleted span: collapses to delete point
      o += a;
    } else if (op === 'insert') {
      if (pos > o) n += a.length;
    } else {
      throw new Error(`unknown op ${op}`);
    }
  }
  return n + (pos - o); // trailing tail is retained implicitly by apply_ops
}
function summarizeOps(ops) {
  return ops.map(([op, a]) => (op === 'insert' ? `insert:${a.length}u` : `${op}:${a}`)).join(' ');
}
function trailingNlRun(s) {
  const m = s.match(/\n+$/);
  return m ? m[0].length : 0;
}

// --- (1) serialization roundtrip: fixed edge cases from SPEC --------------
// CRLF->LF, lone-CR->LF, BOM stripped, exactly-one trailing \n,
// UTF-16 length pinned (s.length === utf16_length), emoji/ZWJ/combining.
const EDGE_CASES = [
  ['', '\n'],
  ['\n', '\n'],
  ['hello', 'hello\n'],
  ['a\n\n\n', 'a\n'],
  ['a\r\nb\r\n', 'a\nb\n'],
  ['a\rb\r', 'a\nb\n'],
  ['a\r\nb\rc\nd\n', 'a\nb\nc\nd\n'],
  ['﻿hello\n', 'hello\n'],           // BOM stripped
  ['﻿a\r\nb\r', 'a\nb\n'],           // BOM + CRLF + lone CR
  ['😀\n', '😀\n'],                   // emoji: 2 UTF-16 units + \n
  ['a😀b\n', 'a😀b\n'],
  ['👨‍👩‍👧\n', '👨‍👩‍👧\n'], // ZWJ sequence (8 units + \n = 9)
  ['é\n', 'é\n'],                     // combining mark
  ['😀\r\n🎉\rX\n', '😀\n🎉\nX\n'],   // CRLF-mixed with emoji
  ['a\r\n😀\r\n', 'a\n😀\n'],
  ['line1\nline2', 'line1\nline2\n'],
  ['```nix\nx = 1;\n```\n', '```nix\nx = 1;\n```\n'],
];
function checkSerializationEdgeCases() {
  let n = 0;
  for (const [raw, expected] of EDGE_CASES) {
    const once = normalize(raw);
    assert(once === expected, `normalize(${JSON.stringify(raw)}) = ${JSON.stringify(once)}, want ${JSON.stringify(expected)}`);
    assert(normalize(once) === once, `not idempotent on ${JSON.stringify(once)}`);
    assert(trailing_nl_valid_QMARK_(once) === true, `trailing-nl invalid on ${JSON.stringify(once)}`);
    assert(!once.endsWith('\n\n'), `double trailing newline on ${JSON.stringify(once)}`);
    assert(once.length === utf16_length(once), `UTF-16 length mismatch on ${JSON.stringify(once)}`);
    n++;
  }
  // pinned UTF-16 unit counts (Counter-examples if JS ever stops being UTF-16)
  assert(utf16_length('😀\n') === 3, 'emoji is 2 UTF-16 units');
  assert(utf16_length('👨‍👩‍👧\n') === 9, 'ZWJ family is 8 UTF-16 units + nl');
  assert(utf16_length('é\n') === 3, 'combining mark adds a unit');
  return { name: 'serialization/edge-cases', runs: n, failures: 0 };
}

// --- (4) every-run invariants ---------------------------------------------
// Applied to every generated doc: apply never throws on valid ops,
// exactly-one trailing \n, Picks count vs target, fence parity vs target,
// length bound, UTF-16 length pinned.
function checkEveryRunInvariants(base, target, label) {
  const ops = content__GT_ops(base, target);
  let result;
  try {
    result = apply_ops(base, ops);
  } catch (e) {
    throw new Error(`${label}: apply threw on valid ops (${summarizeOps(ops)}): ${e.message}`);
  }
  assert(result === target, `${label}: roundtrip mismatch`);
  assert(trailing_nl_valid_QMARK_(result) === true, `${label}: trailing-nl broken`);
  assert(!result.endsWith('\n\n') && result.endsWith('\n'), `${label}: not exactly-one trailing nl`);
  assert(countPicks(result) === countPicks(target), `${label}: Picks count changed`);
  assert(fence_odd_QMARK_(result) === fence_odd_QMARK_(target), `${label}: fence parity changed`);
  assert(utf16_length(result) <= max_content_units, `${label}: over length cap`);
  assert(result.length === utf16_length(result), `${label}: UTF-16 length unpinned`);
  return ops;
}
const PICKS_DOC = normalize('# Show\n\n### [Pick: foo](https://example.com/foo)\n\n```nix\nx = 1;\n```\n');
function checkPicksFixture() {
  // roundtrip preserves Picks + fence on a fixed Picks-bearing doc
  checkEveryRunInvariants(PICKS_DOC, PICKS_DOC + 'extra line\n', 'picks-fixture/append');
  checkEveryRunInvariants(PICKS_DOC, normalize('# Show\n\n### [Pick: foo](https://example.com/foo)\n\ntail\n'), 'picks-fixture/rewrite-tail');
  assert(countPicks(PICKS_DOC) === 1, 'fixture must carry exactly one Pick');
  assert(fence_odd_QMARK_(PICKS_DOC) === false, 'fixture fence must be balanced');
}

// --- runners ---------------------------------------------------------------
function runFc(name, arb, pred) {
  try {
    fc.assert(fc.property(arb, (...args) => { pred(...args); }), { numRuns: NUM_RUNS, seed: SEED });
    return { name, runs: NUM_RUNS, failures: 0 };
  } catch (e) {
    return { name, runs: NUM_RUNS, failures: 1, error: String(e && e.message ? e.message : e).slice(0, 500) };
  }
}

export function runAll() {
  const results = [];
  // fixed edge cases first (always run, seed-independent)
  results.push(checkSerializationEdgeCases());
  checkPicksFixture();

  // (1) serialization roundtrip over generated docs + raw strings
  results.push(runFc('serialization/generated-idempotent', docArb, (raw) => {
    const d = asText(raw);
    const once = normalize(d);
    assert(normalize(once) === once, 'normalize not idempotent');
    assert(trailing_nl_valid_QMARK_(once) === true, 'trailing-nl invalid');
    assert(once.length === utf16_length(once), 'UTF-16 length unpinned');
  }));
  results.push(runFc('serialization/raw-strings', fc.string({ maxLength: 200 }), (raw) => {
    const once = normalize(raw);
    assert(normalize(once) === once, 'normalize not idempotent on raw string');
    assert(trailing_nl_valid_QMARK_(once) === true, 'trailing-nl invalid on raw string');
    assert(once.length === utf16_length(once), 'UTF-16 length unpinned on raw string');
  }));

  // (2) position-mapping monotonicity: anchors before op unchanged, after shift by delta.
  // mapPos uses left-bias at insert points (anchor exactly at the point stays).
  results.push(runFc('position-monotonicity/insert', fc.tuple(docArb, fc.nat(), fc.nat()), ([raw, k1, k2]) => {
    const base = normalize(asText(raw));
    const len = utf16_length(base);
    if (len < 2) return; // degenerate doc: nothing to map
    const p = snap_back(base, k1 % (len + 1));
    const ins = `PBT-INS-${k2 % 997}😀`;
    const ops = p > 0 ? [['retain', p], ['insert', ins]] : [['insert', ins]];
    const splice = base.slice(0, p) + ins + base.slice(p); // pre-normalization splice
    const after = apply_ops(base, ops);
    assert(after === normalize(splice), `apply != normalized splice (p=${p})`);
    const collapse = trailingNlRun(splice) - 1; // chars apply's exactly-one-nl trims
    assert(utf16_length(after) === splice.length - collapse, 'length mismatch vs splice');
    const delta = ins.length;
    const anchors = [...new Set([0, Math.max(0, p - 1), p, Math.min(len, p + 1), len])].sort((a, b) => a - b);
    const mapped = anchors.map((a) => mapPos(ops, a));
    for (let i = 0; i + 1 < anchors.length; i++) {
      assert(mapped[i] <= mapped[i + 1], `not monotone: ${anchors[i]}->${mapped[i]}, ${anchors[i + 1]}->${mapped[i + 1]}`);
    }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const want = a < p ? a : (a === p ? p : a + delta); // left-bias tie-break at p
      assert(mapped[i] === want, `anchor ${a} mapped to ${mapped[i]}, want ${want} (p=${p} delta=${delta})`);
    }
    assert(mapPos(ops, 0) === 0, 'anchor 0 moved');
  }));
  results.push(runFc('position-monotonicity/delete', fc.tuple(docArb, fc.nat(), fc.nat()), ([raw, k1, k2]) => {
    const base = normalize(asText(raw));
    const len = utf16_length(base);
    if (len < 3) return;
    const p = snap_back(base, k1 % len);
    const maxD = len - p;
    if (maxD < 1) return;
    let d = 1 + (k2 % Math.min(maxD, 20));
    // keep the final \n: never delete through the last unit
    if (p + d >= len) d = len - p - 1;
    if (d < 1) return;
    d = snap_back(base, p + d) - p; // endpoint must also be a safe cut (emoji/ZWJ)
    if (d < 1) return;
    const ops = p > 0 ? [['retain', p], ['delete', d]] : [['delete', d]];
    const splice = base.slice(0, p) + base.slice(p + d);
    const after = apply_ops(base, ops);
    assert(after === normalize(splice), `apply != normalized splice (p=${p} d=${d})`);
    const collapse = trailingNlRun(splice) - 1;
    assert(utf16_length(after) === splice.length - collapse, 'length mismatch vs splice');
    const anchors = [...new Set([0, p, Math.min(len, p + d), Math.min(len, p + d + 1), len])].sort((a, b) => a - b);
    const mapped = anchors.map((a) => mapPos(ops, a));
    for (let i = 0; i + 1 < anchors.length; i++) {
      assert(mapped[i] <= mapped[i + 1], `not monotone: ${anchors[i]}->${mapped[i]}, ${anchors[i + 1]}->${mapped[i + 1]}`);
    }
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const want = a <= p ? a : (a < p + d ? p : a - d); // inside-span collapses to p
      assert(mapped[i] === want, `anchor ${a} mapped to ${mapped[i]}, want ${want} (p=${p} d=${d})`);
    }
  }));

  // (3) weak intention: disjoint inserts both appear verbatim in converged doc
  results.push(runFc('weak-intention/disjoint', fc.tuple(docArb, fc.nat(), fc.nat()), ([raw, k1, k2]) => {
    const base = normalize(asText(raw));
    const len = utf16_length(base);
    if (len < 2) return;
    let pa = snap_back(base, k1 % (len + 1));
    let pb = snap_back(base, k2 % (len + 1));
    if (pa === pb) pb = snap_back(base, (k2 + 7) % (len + 1)); // retry offset; may still tie -> tie case below
    const sA = 'PBT-WEAK-A-7f3a';
    const sB = 'PBT-WEAK-B-9c1e';
    const insAt = (p, s) => (p > 0 ? [['retain', p], ['insert', s]] : [['insert', s]]);
    const shift = (ops, at, by) => ops.map(([op, a]) => (op === 'retain' && at <= a ? [op, a + by] : [op, a]));
    if (pa !== pb) {
      const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
      const slo = pa < pb ? sA : sB, shi = pa < pb ? sB : sA;
      const c1 = apply_ops(apply_ops(base, insAt(lo, slo)), shift(insAt(hi, shi), hi, slo.length));
      const c2 = apply_ops(apply_ops(base, insAt(hi, shi)), insAt(lo, slo));
      assert(c1 === c2, `disjoint inserts did not converge (${pa},${pb})`);
      assert(c1.includes(sA) && c1.includes(sB), 'converged doc lost an insert');
    } else {
      // same anchor: tie-break keeps both verbatim (order may differ by side)
      const c1 = apply_ops(apply_ops(base, insAt(pa, sA)), shift(insAt(pb, sB), pb, sA.length));
      assert(c1.includes(sA) && c1.includes(sB), 'tie-break lost an insert');
    }
  }));

  // (4) every-run invariants on generated docs
  results.push(runFc('every-run/append-line', fc.tuple(docArb, fc.nat()), ([raw, k]) => {
    const base = normalize(asText(raw));
    const target = normalize(base + `pbt-extra-${k % 1000}\n`);
    checkEveryRunInvariants(base, target, 'every-run/append-line');
  }));
  results.push(runFc('every-run/rewrite-head', fc.tuple(docArb, fc.nat()), ([raw, k]) => {
    const base = normalize(asText(raw));
    const cut = snap_back(base, k % (utf16_length(base) + 1));
    const target = normalize(`pbt-head-${k % 1000}\n` + base.slice(cut));
    checkEveryRunInvariants(base, target, 'every-run/rewrite-head');
  }));

  assert(max_content_units === 102400, `length-cap pin moved: ${max_content_units}`);
  return { seed: SEED, numRuns: NUM_RUNS, results };
}

export function formatSummary({ seed, numRuns, results }) {
  const total = results.reduce((a, r) => a + r.runs, 0);
  const failed = results.filter((r) => r.failures > 0);
  const lines = [
    `pbt-3-invariants: ${results.length} properties, ${total} runs total (${numRuns}/property), seed=${seed}`,
    ...results.map((r) => `  ${r.failures ? 'FAIL' : 'ok'}   ${r.name} (${r.runs} runs)${r.error ? ' :: ' + r.error : ''}`),
    failed.length ? `RESULT: FAIL (${failed.length} failing)` : 'RESULT: PASS',
  ];
  return { text: lines.join('\n'), failed: failed.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const summary = formatSummary(runAll());
    console.log(summary.text);
    process.exitCode = summary.failed ? 1 : 0;
  } catch (e) {
    console.log(`pbt-3-invariants seed=${SEED} RESULT: FAIL (harness threw: ${String(e && e.message ? e.message : e).slice(0, 300)})`);
    process.exitCode = 1;
  }
}
