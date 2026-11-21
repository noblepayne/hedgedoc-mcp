// pbt-2-transform.mjs — slice 2: OT transform / retry / inversion / composition properties.
// Pure only. No server, no sockets. Runs under node.
//
//   node pbt-2-transform.mjs [--runs N] [--seed S]
//
// Imports generators from slice 1 (./pbt-1-gens.mjs) and pure calcs compiled
// from Squint (hedgedoc_mcp/model.mjs + model_ops.mjs).
//
// ---- GEN CONTRACT (expected of slice 1) ----
//   docArb       : fast-check arbitrary yielding doc strings (trailing "\n"
//                  per HedgeDoc invariant; we normalize defensively anyway).
//   genPair(doc) : plain synchronous function of a NORMALIZED doc string,
//                  returning a concurrent op pair [A, B] built against doc.
//                  Each entry is either { opId: string, ops: [...] } or a bare
//                  ops array (opIds are then synthesized as "syn-0"/"syn-1").
//                  ops use the compiled shape: ["retain", n] / ["delete", n] /
//                  ["insert", str] (whatever content__GT_ops emits).
//
// ---- BUILD GAPS (missing exports in the compiled API — read before review) ----
//   GAP-1: hedgedoc_mcp/model_ops.mjs exports content__GT_ops + apply_ops but
//          NO invert / compose / transform. So properties (3) and (4) below pin
//          REFERENCE semantics implemented locally in this harness via endpoint
//          diffs (invertRef/composeRef). They do NOT exercise shipped invert /
//          compose code, because none exists. If production grows first-class
//          invert/compose, point these properties at those exports.
//   GAP-2: No opId-keyed log fold exists anywhere in compiled output, and the
//          server has no dedupe by design (src/hedgedoc_mcp/core.cljs: "opId is
//          client-only; the server has no dedupe"). Properties (1) and (2) pin
//          the client-side exactly-once fold (foldLog) that production retry
//          code (tools.cljs emit-with-cas!) must implement.
//   GAP-3: No transform export exists, so the TP1 convergence property from
//          council-pbt.md cannot be written against shipped code yet; (4) covers
//          the sequential composition half only.
//
// Properties:
//   (1) retry-dedupe    — same opId applied twice == once; adjacent ([A,A])
//                         AND non-adjacent ([A,B,A']) dup in op log.
//   (2) distinct-append — different opIds both apply (guards over-dedupe).
//   (3) inversion       — apply(invert(op,d), apply(op,d)) == d.
//   (4) composition     — apply(compose(o1,o2),d) == apply(apply(o1,d),o2).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fc = require("fast-check");
import { content__GT_ops, apply_ops } from "../hedgedoc_mcp/model_ops.mjs";
import { normalize } from "../hedgedoc_mcp/model.mjs";
import { docArb, genPairFn as genPair } from "./pbt-1-gens.mjs";

// ---------- tiny CLI: --runs N --seed S ----------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const NUM_RUNS = Math.max(1, parseInt(opt("--runs", "1000"), 10) || 1000);
const SEED = (opt("--seed", null) === null ? Date.now() : parseInt(opt("--seed", "0"), 10)) | 0;
console.log(`[pbt-2] runs=${NUM_RUNS} seed=${SEED}`);

// ---------- harness-local reference implementations (see GAP-1 / GAP-2) ----------
const isOpsArray = (v) =>
  Array.isArray(v) && v.every((op) => Array.isArray(op) && typeof op[0] === "string");

// Normalize a genPair entry to { opId, ops }. Bare ops arrays get synthetic ids.
function normEntry(e, fallbackId) {
  if (isOpsArray(e)) return { opId: fallbackId, ops: e };
  if (e && typeof e.opId === "string" && isOpsArray(e.ops)) return { opId: e.opId, ops: e.ops };
  throw new Error(`[pbt-2] genPair entry has unexpected shape: ${JSON.stringify(e)?.slice(0, 200)}`);
}

// Resolve genPair(doc) -> [entryA, entryB], tolerating {a,b} / {o1,o2} wrappers.
function resolvePair(doc) {
  const r = genPair(doc);
  const arr = Array.isArray(r) ? r : r && (r.a !== undefined ? [r.a, r.b] : [r.o1, r.o2]);
  if (!arr || arr.length < 2) throw new Error("[pbt-2] genPair(doc) must return a pair [A, B]");
  const A = normEntry(arr[0], "syn-0");
  let B = normEntry(arr[1], "syn-1");
  if (B.opId === A.opId) B = { ...B, opId: `${B.opId}#b` }; // keep (2) non-vacuous
  return [A, B];
}

// Exactly-once fold over an op log: first opId wins, redeliveries skipped.
function foldLog(doc, entries) {
  const seen = new Set();
  let d = doc;
  for (const e of entries) {
    if (seen.has(e.opId)) continue;
    seen.add(e.opId);
    d = apply_ops(d, e.ops);
  }
  return d;
}

// invertRef(op, preDoc): endpoint-diff inverse. Requires preDoc (pre-image).
const invertRef = (op, preDoc) => content__GT_ops(apply_ops(preDoc, op), preDoc);
// composeRef(o1, o2, preDoc): single diff equivalent to o1 then o2.
const composeRef = (o1, o2, preDoc) =>
  content__GT_ops(preDoc, apply_ops(apply_ops(preDoc, o1), o2));

const eq = (a, b) => a === b;
const show = (s) => JSON.stringify(String(s).slice(0, 160));

// ---------- properties ----------
function propRetryDedupe() {
  return fc.property(docArb, (raw) => {
    if (typeof raw !== "string") throw new Error("[pbt-2] docArb must yield strings");
    const d0 = normalize(raw);
    const [A, B] = resolvePair(d0);
    const d1 = apply_ops(d0, A.ops);

    // (1a) adjacent dup: [A, A] folds to single apply.
    const adj = foldLog(d0, [A, A]);
    if (!eq(adj, d1)) throw new Error(`[retry-adjacent] fold != once: ${show(adj)} vs ${show(d1)}`);

    // (1b) non-adjacent dup: [A, B', A] where B' is B's effect re-based onto d1.
    const targetB = apply_ops(d0, B.ops); // B's intended effect, computed on its base
    const Bseq = { opId: B.opId, ops: content__GT_ops(d1, targetB) };
    const d2 = apply_ops(d1, Bseq.ops);
    const nonAdj = foldLog(d0, [A, Bseq, A]);
    if (!eq(nonAdj, d2))
      throw new Error(`[retry-nondup] fold != once-each: ${show(nonAdj)} vs ${show(d2)}`);
    return true;
  });
}

function propDistinctAppend() {
  return fc.property(docArb, (raw) => {
    if (typeof raw !== "string") throw new Error("[pbt-2] docArb must yield strings");
    const d0 = normalize(raw);
    const [A, B] = resolvePair(d0);
    if (A.opId === B.opId) throw new Error("[distinct] opIds collide after dedupe guard");
    const d1 = apply_ops(d0, A.ops);
    const targetB = apply_ops(d0, B.ops);
    const Bseq = { opId: B.opId, ops: content__GT_ops(d1, targetB) };
    const d2 = apply_ops(d1, Bseq.ops);
    const folded = foldLog(d0, [A, Bseq]);
    if (!eq(folded, d2)) throw new Error(`[distinct] both-apply mismatch: ${show(folded)} vs ${show(d2)}`);
    // Over-dedupe guard: distinct ids must not collapse to a single apply, unless
    // the pair genuinely converges (A,B same net effect) — then the guard is vacuous.
    if (!eq(d2, d1) && eq(folded, d1))
      throw new Error("[distinct] second opId dropped: over-dedupe");
    return true;
  });
}

function propInversion() {
  return fc.property(docArb, (raw) => {
    if (typeof raw !== "string") throw new Error("[pbt-2] docArb must yield strings");
    const d0 = normalize(raw);
    const [A] = resolvePair(d0);
    const d1 = apply_ops(d0, A.ops);
    const inv = invertRef(A.ops, d0);
    const back = apply_ops(d1, inv);
    if (!eq(back, d0)) throw new Error(`[invert] no roundtrip: ${show(back)} vs ${show(d0)}`);
    return true;
  });
}

function propComposition() {
  return fc.property(docArb, (raw) => {
    if (typeof raw !== "string") throw new Error("[pbt-2] docArb must yield strings");
    const d0 = normalize(raw);
    const [A, B] = resolvePair(d0);
    const d1 = apply_ops(d0, A.ops);
    const targetB = apply_ops(d0, B.ops);
    const o2 = content__GT_ops(d1, targetB);
    const d2 = apply_ops(d1, o2);
    const composed = composeRef(A.ops, o2, d0);
    const viaComposed = apply_ops(d0, composed);
    if (!eq(viaComposed, d2))
      throw new Error(`[compose] mismatch: ${show(viaComposed)} vs ${show(d2)}`);
    return true;
  });
}

// ---------- runner: per-property fc.check, summary, non-zero exit on failure ----------
const PROPS = [
  ["retry-dedupe", propRetryDedupe],
  ["distinct-append", propDistinctAppend],
  ["inversion", propInversion],
  ["composition", propComposition],
];

let failures = 0;
for (let i = 0; i < PROPS.length; i++) {
  const [name, makeProp] = PROPS[i];
  const seed = (SEED + i * 7919) | 0;
  let res;
  try {
    res = fc.check(makeProp(), { numRuns: NUM_RUNS, seed });
  } catch (e) {
    console.log(`[pbt-2] ${name}: HARNESS ERROR seed=${seed}: ${e?.message ?? e}`);
    failures++;
    continue;
  }
  if (res.failed) {
    failures++;
    console.log(`[pbt-2] ${name}: FAIL seed=${seed} runs=${res.numRuns}`);
    const ce = res.counterexample;
    if (ce && ce[0] !== undefined)
      console.log(`[pbt-2]   counterexample doc: ${show(ce[0])}`);
    if (res.error) console.log(`[pbt-2]   error: ${String(res.error?.message ?? res.error).slice(0, 300)}`);
  } else {
    console.log(`[pbt-2] ${name}: PASS runs=${res.numRuns} seed=${seed}`);
  }
}
console.log(`[pbt-2] summary: ${PROPS.length - failures}/${PROPS.length} properties passed (runs=${NUM_RUNS} baseSeed=${SEED})`);
process.exit(failures === 0 ? 0 : 1);
