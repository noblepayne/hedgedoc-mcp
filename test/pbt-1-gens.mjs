// pbt-1-gens.mjs — PBT slice 1: LUP-688-weighted generators + TP1 + same-anchor tie-break.
// Pure only: exercises compiled Squint calcs in hedgedoc_mcp/{model,model_ops}.mjs.
// Exports { docArb, genPair } (+ helpers) for later slices. Runner at bottom.
// Usage: NUMRUNS=1000 SEED=123 node test/pbt-1-gens.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fc = require('fast-check');
import * as base from '../hedgedoc_mcp/model.mjs';
import * as mops from '../hedgedoc_mcp/model_ops.mjs';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const TICK = '\x60'.repeat(3); // avoid backtick soup in this source

// ---------------------------------------------------------------- LUP-688 text atoms
const WORDS = ('episode feedback boost sats fountain matrix nix flake kernel rust ledger harbor signal packet ' +
  'latency build release notes topic guest host lightning value split chapter transcript cache mirror wire mesh ' +
  'tuple offset retain grapheme trailing newline socket revision snapshot section heading quote bullet fence code ' +
  'block show news meta frontmatter boosts stream zap podcast index relay node graph store hash digest verify poll ' +
  'append replace abort retry scope cursor presence remote idle velocity opid dedupe invert pin cache hydra colony').split(' ');
const NEWS_TITLES = ['Kernel 6.14 lands', 'Flakes stabilize inputs', 'Rust coreutils 1.0', 'Fountain tops chart',
  'Socket retry wins', 'Snapshot GC behavior', 'Nix cache hits record', 'Latency myths busted',
  'Mesh news roundup', 'Value splits explained', 'Chapter marks deep-dive', 'Transcript tricks',
  'Cache money special', 'Mirror mirror online', 'Offsets and anchors', 'Retain delete repeat'];
const PICK_TITLES = ['Signal Mesh', 'Fountain 1.2', 'Nix Flakes 101', 'Rust for Podcasts', 'Ledger Live',
  'Harbor Lights', 'Packet Radio', 'Latency Zero', 'Kernel Panic', 'Value Splits', 'Chapter Marks',
  'Transcript Tricks', 'Cache Money', 'Mirror Mirror', 'Offsets and Anchors', 'Retain Delete',
  'Grapheme Safe', 'Trailing Newlines', 'Socket Science', 'Revision Games', 'Snapshot Logic'];
// Correct spelling dominates; typo variants exercise normalized-kind anchors + duplicate-heading paths.
const PICKS_HEADINGS = ['## picks', '## picks', '## picks', '## picks', '## picks', '## picks',
  '## Picks', '## Picks', '## PICKS', '##  picks', '## picks #', '## pick', '## Picks ',
  '## piks', '## pikcs', '## Pickss'];
const META_LINES = ['#### Show: Linux Unplugged', '#### Episode: 688', '#### Date: 2026-11-07',
  '#### Hosts: Chris, Wes', '#### Tags: nix, podcasting-2.0'];
const FRONTMATTER = ['---', 'title: LUP 688 show notes', 'episode: 688', '---'].join('\n');
const NIX_FRAGS = ['{ pkgs, ... }:', '  environment.systemPackages = [', '    pkgs.ffmpeg',
  '    pkgs.yt-dlp', '    pkgs.socat', '  ];', '# pin nixpkgs, mind the binary cache',
  '  services.nextcloud.enable = true;', '  networking.hostName = "lup";', '  system.stateVersion = "25.05";'];
const UNI_LINES = ['- emoji check \u{1F600} done', '- zwj family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} ok',
  '- combining e\u0301lan vital', '- precomposed \u00FCnicode caf\u00E9', '- CJK \u65E5\u672C\u8A9E\u30C6\u30B9\u30C8',
  '- trademark \u2122 and na\u00EFve', '- zalgo-lite a\u0301b\u0302c\u0303'];
const APPS = ['Fountain', 'Podverse', 'Castamatic', 'Breez', 'TrueFans'];
const SATS = ['21', '210', '2100', '21000', '100000'];

const wordsArb = (n, m) => fc.array(fc.constantFrom(...WORDS), { minLength: n, maxLength: m }).map(w => w.join(' '));
const markerArb = fc.constantFrom('-', '-', '-', '+', '+', '*');
const bulletLineArb = fc.tuple(markerArb, wordsArb(2, 9)).map(([mk, t]) => `${mk} ${t}`);
const quoteArb = wordsArb(3, 12).map(t => `> ${t}`);
const newsArb = fc.constantFrom(...NEWS_TITLES).map(t => `### ${t}`);
const metaArb = fc.constantFrom(...META_LINES);
const paraArb = wordsArb(4, 14);
const unicodeArb = fc.constantFrom(...UNI_LINES);
const boostArb = fc.tuple(
  fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
    { minLength: 6, maxLength: 10 }).map(c => c.join('')),
  fc.constantFrom(...SATS), fc.constantFrom(...APPS), wordsArb(1, 4)
).map(([id, sats, app, note]) => `- \u26A1 boost https://fountain.fm/ep/${id} ${sats} sats via ${app} ${note}`);
const pickEntryArb = fc.tuple(fc.constantFrom(...PICK_TITLES),
  fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }).map(w => w.join('-'))
).map(([t, slug]) => `### [Pick: ${t}](https://example.com/${slug})`);
const fenceBlockArb = fc.array(fc.constantFrom(...NIX_FRAGS), { minLength: 1, maxLength: 6 })
  .map(lines => [`${TICK}nix`, ...lines, TICK].join('\n'));
// Block mix: bullets+quotes+news heavy (LUP-688 shape), fences/boosts/picks present, unicode edges rare.
const blockArb = fc.constantFrom(
  'b', 'b', 'b', 'q', 'q', 'n', 'n', 'p', 'p', 'boost', 'pick', 'fence', 'uni', 'meta'
).chain(tag => {
  switch (tag) {
    case 'b': return bulletLineArb;
    case 'q': return quoteArb;
    case 'n': return newsArb;
    case 'boost': return boostArb;
    case 'pick': return pickEntryArb;
    case 'fence': return fenceBlockArb;
    case 'uni': return unicodeArb;
    case 'meta': return metaArb;
    default: return paraArb;
  }
});
const picksHeadingArb = fc.constantFrom(...PICKS_HEADINGS);

// Insert snippets: fence-free by construction (no backtick in alphabet), 1-3 lines,
// always newline-terminated so line-start inserts never glue onto a toggle line.
const snippetArb = fc.tuple(
  fc.tuple(markerArb, wordsArb(2, 9)).map(([mk, t]) => `${mk} ${t}`),
  fc.array(blockArb, { minLength: 0, maxLength: 2 })
).map(([first, rest]) => [first, ...rest.filter(b => !b.includes(TICK))].join('\n') + '\n');

// ---------------------------------------------------------------- docArb
// Skeleton guarantees picks-variant heading + nix fence (SPEC: Picks+fence in >80%).
export const docArb = fc.tuple(
  fc.array(blockArb, { minLength: 8, maxLength: 30 }),
  picksHeadingArb,
  fc.array(blockArb, { minLength: 8, maxLength: 30 }),
  fenceBlockArb,
  fc.array(blockArb, { minLength: 4, maxLength: 16 })
).map(([pre, ph, body, fence, tail]) =>
  base.normalize([FRONTMATTER, '#### Show: Linux Unplugged', ...pre, ph, ...body, fence, ...tail].join('\n')));

// Picks-entry counter for later slices (LUP `### [Pick: x](url)` links).
export function countPicks(doc) { const m = doc.match(/\[Pick:/g); return m ? m.length : 0; }

// ---------------------------------------------------------------- anchors
// Anchor kinds: BOF / EOF / Picks±3 lines / fence-boundary / uniform(safe-snapped).
export function anchorsFor(doc) {
  const n = base.utf16_length(doc);
  const rawLines = doc.split('\n');
  const body = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
  const lineStarts = [];
  const lineLens = [];
  let off = 0;
  for (const ln of body) { lineStarts.push(off); lineLens.push(base.utf16_length(ln)); off += lineLens[lineLens.length - 1] + 1; }
  const lineIdxOf = (o) => { let i = 0; for (let k = 0; k < lineStarts.length; k++) if (lineStarts[k] <= o) i = k; return i; };
  const fenceIdx = [];
  body.forEach((ln, i) => { if (/^ {0,3}```/.test(ln)) fenceIdx.push(i); });
  const fenceStarts = fenceIdx.map(i => lineStarts[i]);
  let sections = [];
  try { sections = Array.from(mops.parse_sections(doc) || []); } catch { sections = []; }
  // Picks-family: correct spelling + typo variants (level-2 skeleton heading always qualifies).
  const isPicksFam = (s) => s && (s.level === 2 || /^(picks?|pikcs|piks|pickss)$/.test(s.normalized || ''));
  const picks = sections.find(s => s.normalized === 'picks')
    ?? sections.find(s => isPicksFam(s))
    ?? null;
  const picksCands = [];
  if (picks && lineStarts.length) {
    const ls = new Set();
    for (const baseOff of [picks.start, picks.end]) {
      const li = lineIdxOf(Math.min(baseOff, n));
      for (let d = -3; d <= 3; d++) {
        const j = li + d;
        if (j >= 0 && j < lineStarts.length) ls.add(lineStarts[j]);
      }
    }
    picksCands.push(...ls);
  }
  const fenceCands = [];
  fenceIdx.forEach(i => {
    fenceCands.push(lineStarts[i]);
    if (i + 1 < lineStarts.length) fenceCands.push(lineStarts[i + 1]);
  });
  return { n, lineStarts, lineLens, fenceStarts, fenceIdx, sections, picksCands, fenceCands };
}

// Line index containing off (-1 when off == EOF). Strictly-inside-toggle test keeps
// delete/replace boundaries and insert points from partially covering a ``` line:
// a partial toggle would change the toggle count without appearing in the deleted
// span, silently flipping fence parity.
export function toggleLineAt(A, off) {
  if (off >= A.n || !A.lineStarts.length) return -1;
  let li = 0;
  for (let k = 0; k < A.lineStarts.length; k++) if (A.lineStarts[k] <= off) li = k;
  return li;
}
export function strictlyInsideToggle(A, b) {
  const li = toggleLineAt(A, b);
  if (li < 0 || !A.fenceIdx.includes(li)) return -1;
  const ls = A.lineStarts[li];
  return (b > ls && b < ls + A.lineLens[li]) ? li : -1;
}
// End boundary vs toggle lines: end at-or-inside a toggle line (start > pos) must
// swallow the whole toggle line, else the toggle loses its preceding newline and
// glues to the prefix remainder. Returns adjusted end (may equal input).
export function clearToggleEnd(A, pos, end) {
  const at = (e) => {
    if (e <= pos) return -1;
    const qi = toggleLineAt(A, e);
    if (qi >= 0 && A.fenceIdx.includes(qi) && A.lineStarts[qi] === e) return qi;
    return strictlyInsideToggle(A, e);
  };
  let g = 0, tl = at(end), e = end;
  while (tl >= 0 && g++ < 50) {
    e = (tl + 1 < A.lineStarts.length) ? A.lineStarts[tl + 1] : A.n;
    tl = at(e);
  }
  return g >= 50 ? -1 : e;
}

function anchorArbFor(A) {
  const kinds = ['bof',
    'eof', 'eof',
    'picks', 'picks', 'picks', 'picks',
    'fence', 'fence', 'fence',
    'uniform', 'uniform', 'uniform', 'uniform'];
  return fc.tuple(
    fc.constantFrom(...kinds),
    fc.integer({ min: 0, max: Math.max(0, A.n) }),
    fc.integer({ min: 0, max: Math.max(0, A.picksCands.length - 1) }),
    fc.integer({ min: 0, max: Math.max(0, A.fenceCands.length - 1) })
  ).map(([k, u, pi, fi]) => {
    switch (k) {
      case 'bof': return { kind: 'bof', off: 0 };
      case 'eof': return { kind: 'eof', off: A.n };
      case 'picks': return { kind: 'picks', off: A.picksCands.length ? A.picksCands[pi % A.picksCands.length] : 0 };
      case 'fence': return { kind: 'fence', off: A.fenceCands.length ? A.fenceCands[fi % A.fenceCands.length] : A.n };
      default: return { kind: 'uniform', off: mops.snap_back ? mops.snap_back(A.doc, u) : u };
    }
  });
}

// ---------------------------------------------------------------- ops
// Harness op: { anchor, kind, pos, del, ins }. pos/del in UTF-16 units, cuts snapped.
function balanceEnd(doc, A, pos, end) {
  let e = end, guard = 0;
  while (mops.fence_odd_QMARK_(doc.slice(pos, e))) {
    if (++guard > 50) return -1;
    const nxt = A.fenceStarts.find(s => s >= e);
    if (nxt == null) return -1;
    const li = A.lineStarts.indexOf(nxt);
    e = (li >= 0 && li + 1 < A.lineStarts.length) ? A.lineStarts[li + 1] : base.utf16_length(doc);
    if (e <= pos) return -1;
  }
  return e;
}

// Insert op constructor shared by buildOp and tieArb (identical rules both places).
// Two trailing-edge rules keep apply_ops' ensure_one_trailing_nl length-exact:
// (1) never split a ``` line (relocate to its start); (2) never insert at n-1,
// which would glue ins's trailing \n onto the doc-final \n and get stripped.
function insertOp(doc, A, anchor, text) {
  const n = base.utf16_length(doc);
  const ins = text.endsWith('\n') ? text : text + '\n';
  let pos = mops.snap_back(doc, Math.min(anchor.off, n));
  const tli = strictlyInsideToggle(A, pos);
  if (tli >= 0) pos = A.lineStarts[tli];
  if (pos === n - 1 && n > 0) pos = n; // rule (2)
  return { anchor: anchor.kind, kind: 'insert', pos, del: 0, ins };
}

function buildOp(doc, A, anchor, kind, spanLen, text) {
  const n = base.utf16_length(doc);
  if (kind === 'insert') return insertOp(doc, A, anchor, text);
  // Delete/replace: fixpoint over (a) shrink start off partial toggle lines,
  // (b) swallow toggle lines at the end boundary (else the toggle loses its
  // preceding \n and glues to the prefix), (c) extend end==n-1 to n (else the
  // trailing \n\n gets stripped by ensure_one_trailing_nl), (d) balanceEnd to
  // even toggle count. (b) and (d) interact — balanceEnd can land exactly on a
  // toggle start — so loop to a fixpoint. All steps monotone non-decreasing.
  let pos = mops.snap_back(doc, Math.min(anchor.off, n));
  const ins = text.endsWith('\n') ? text : text + '\n';
  const fallback = () => insertOp(doc, A, { kind: anchor.kind, off: pos }, ins);
  const li = strictlyInsideToggle(A, pos);
  if (li >= 0) pos = (li + 1 < A.lineStarts.length) ? A.lineStarts[li + 1] : n;
  let end = mops.snap_fwd(doc, Math.min(n, pos + Math.max(1, spanLen)));
  let settled = false;
  for (let g = 0; g < 100 && !settled; g++) {
    end = clearToggleEnd(A, pos, end);
    if (end < 0 || end <= pos) return fallback();
    if (end === n - 1) end = n; // rule (c)
    const e2 = balanceEnd(doc, A, pos, end);
    if (e2 < 0) return fallback();
    settled = (e2 === end);
    end = e2;
  }
  if (!settled) return fallback();
  if (kind === 'delete') return { anchor: anchor.kind, kind, pos, del: end - pos, ins: '' };
  return { anchor: anchor.kind, kind: 'replace', pos, del: end - pos, ins };
}

export function opArbFor(doc, A = anchorsFor(doc)) {
  A.doc = doc; // stashed for uniform snap
  const kinds = ['insert', 'insert', 'insert', 'insert', 'insert',
    'delete', 'delete', 'replace', 'replace', 'replace'];
  return fc.tuple(anchorArbFor(A), fc.constantFrom(...kinds),
    fc.integer({ min: 1, max: 400 }), snippetArb)
    .map(([a, k, L, t]) => buildOp(doc, A, a, k, L, t));
}

export function opPairArb(doc, A = anchorsFor(doc)) {
  return fc.tuple(opArbFor(doc, A), opArbFor(doc, A));
}

// { doc, a, b }: concurrent pair from the SAME base doc.
export const genPair = docArb.chain(doc => {
  const A = anchorsFor(doc);
  return opPairArb(doc, A).map(([a, b]) => ({ doc, a, b }));
});

// Dedicated same-anchor double-insert arbitrary (tie-break coverage by construction).
export const tieArb = docArb.chain(doc => {
  const A = anchorsFor(doc);
  A.doc = doc;
  return fc.tuple(anchorArbFor(A), snippetArb, snippetArb)
    .map(([a, t1, t2]) => ({ doc, a: insertOp(doc, A, a, t1), b: insertOp(doc, A, a, t2) }));
});

// Wire form for compiled apply_ops: [["retain",n],["delete",n],["insert",s]] (strings, not keywords).
export function toWire(op) {
  const w = [];
  if (op.pos > 0) w.push(['retain', op.pos]);
  if (op.del > 0) w.push(['delete', op.del]);
  if (op.ins !== '') w.push(['insert', op.ins]);
  return w;
}
export function applyOp(doc, op) { return mops.apply_ops(doc, toWire(op)); }
const ulen = (s) => base.utf16_length(s);

// ---------------------------------------------------------------- OT: transform + tie-break (harness-side; pure calcs have no transform)
// xform(X, Y): X rebased past already-applied concurrent Y (same base).
// => { status:'ok', op } | { status:'tie' } (same-anchor double insert) | { status:'conflict' }
export function xform(X, Y) {
  // Same-anchor double insert MUST be checked before the shift guards below:
  // Y.pos + Y.del <= X.pos is true at equality and would otherwise shadow the tie.
  if (X.del === 0 && Y.del === 0 && X.pos === Y.pos) return { status: 'tie' };
  const yl = ulen(Y.ins), shift = yl - Y.del;
  if (Y.pos + Y.del <= X.pos) return { status: 'ok', op: { ...X, pos: X.pos + shift } };
  if (Y.pos >= X.pos + X.del) return { status: 'ok', op: { ...X } };
  if (X.del === 0 && Y.del === 0 && X.pos === Y.pos) return { status: 'tie' };
  return { status: 'conflict' };
}

// Total, deterministic, antisymmetric order for same-anchor inserts (pure fn of op contents).
export function orderOps(a, b) {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  const rk = o => (o.del > 0 ? (o.ins !== '' ? 1 : 0) : 2);
  if (rk(a) !== rk(b)) return rk(a) < rk(b) ? -1 : 1;
  if (a.ins !== b.ins) return a.ins < b.ins ? -1 : 1;
  if (a.del !== b.del) return a.del < b.del ? -1 : 1;
  return 0;
}
function tieShift(insOp, other) {
  // Rebase insOp past same-anchor insert other per orderOps.
  const c = orderOps(insOp, other);
  if (c <= 0) return { ...insOp };
  return { ...insOp, pos: insOp.pos + ulen(other.ins) };
}
export function rangesOverlap(a, b) { return a.pos < b.pos + b.del && b.pos < a.pos + a.del; }

// ---------------------------------------------------------------- verdicts
// Every-run structural invariants that hold by construction: apply never throws
// (solo applies below), exactly-one trailing \n, fence parity even, length bound.
function checkInvariants(doc, label) {
  if (!base.trailing_nl_valid_QMARK_(doc)) throw new Error(`${label}: trailing-nl violated`);
  if (mops.fence_odd_QMARK_(doc)) throw new Error(`${label}: fence parity odd`);
  if (ulen(doc) > mops.max_content_units) throw new Error(`${label}: over 100KB cap`);
}

// TP1 convergence for one pair. Returns 'converged' | 'tie' | 'conflict'; throws on violation.
export function classifyPair({ doc, a, b }) {
  const soloA = applyOp(doc, a); checkInvariants(soloA, 'soloA');
  const soloB = applyOp(doc, b); checkInvariants(soloB, 'soloB');
  const bP = xform(b, a), aP = xform(a, b);
  if (bP.status === 'ok' && aP.status === 'ok') {
    const d1 = applyOp(soloA, bP.op); checkInvariants(d1, 'tp1-order1');
    const d2 = applyOp(soloB, aP.op); checkInvariants(d2, 'tp1-order2');
    if (d1 !== d2) {
      throw new Error(`TP1 divergence:\na=${JSON.stringify(a)}\nb=${JSON.stringify(b)}\n` +
        `d1=${JSON.stringify(d1.slice(0, 400))}\nd2=${JSON.stringify(d2.slice(0, 400))}`);
    }
    return 'converged';
  }
  if (bP.status === 'tie' && aP.status === 'tie') {
    if (orderOps(a, b) !== -orderOps(b, a)) throw new Error('tie-break not antisymmetric');
    if (orderOps(a, b) !== orderOps(a, b)) throw new Error('tie-break unstable');
    const m1 = applyOp(soloA, tieShift(b, a)); checkInvariants(m1, 'tie-order1');
    const m2 = applyOp(soloB, tieShift(a, b)); checkInvariants(m2, 'tie-order2');
    if (m1 !== m2) throw new Error(`tie-break arrival-dependent:\na=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`);
    return 'tie';
  }
  // At least one side untransformable: must be a genuine overlap, solo applies already clean.
  if (!rangesOverlap(a, b)) {
    throw new Error(`unexpected conflict on disjoint pair:\na=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`);
  }
  return 'conflict';
}

export const propTP1 = fc.property(genPair, (pair) => { classifyPair(pair); });
export const propTie = fc.property(tieArb, ({ doc, a, b }) => {
  if (orderOps(a, b) !== -orderOps(b, a)) throw new Error('tie: antisymmetry');
  const r1 = orderOps(a, b);
  if (orderOps(a, b) !== r1) throw new Error('tie: instability');
  const m1 = applyOp(applyOp(doc, a), tieShift(b, a));
  const m2 = applyOp(applyOp(doc, b), tieShift(a, b));
  checkInvariants(m1, 'tie-m1'); checkInvariants(m2, 'tie-m2');
  if (m1 !== m2) throw new Error('tie: arrival-dependent merge');
});

// ---------------------------------------------------------------- runner
function coverage() {
  const docs = fc.sample(docArb, 300);
  let picks = 0, fence = 0, both = 0, uni = 0, withPicks = 0;
  for (const d of docs) {
    const A = anchorsFor(d);
    const hasPicks = A.sections.some(s => s.level === 2 || /^(picks?|pikcs|piks|pickss)$/.test(s.normalized || ''));
    const hasFence = A.fenceStarts.length > 0;
    if (hasPicks) picks++;
    if (hasFence) fence++;
    if (hasPicks && hasFence) both++;
    if (/😀|\u200D|́|\u65E5/.test(d)) uni++;
    if (countPicks(d) > 0) withPicks++;
  }
  const pairs = fc.sample(genPair, 2000);
  const verdicts = { converged: 0, tie: 0, conflict: 0 };
  const anchors = {};
  for (const p of pairs) {
    verdicts[classifyPair(p)]++;
    for (const o of [p.a, p.b]) anchors[`${o.anchorKind ?? o.anchor}:${o.kind}`] = (anchors[`${o.anchorKind ?? o.anchor}:${o.kind}`] || 0) + 1;
  }
  return { nDocs: docs.length, picks, fence, both, uni, withPicks, nPairs: pairs.length, verdicts, anchors };
}

function main() {
  const NUMRUNS = parseInt(process.env.NUMRUNS ?? '1000', 10);
  const SEED = process.env.SEED ? parseInt(process.env.SEED, 10) : (Date.now() % 2147483647);
  console.log(`[pbt-1] seed=${SEED} numRuns=${NUMRUNS}`);
  const cov = coverage();
  const pct = (x, n) => `${(100 * x / n).toFixed(1)}%`;
  console.log(`[pbt-1] docs: picks=${cov.picks}/${cov.nDocs} fence=${cov.fence}/${cov.nDocs} ` +
    `both=${cov.both}/${cov.nDocs} (${pct(cov.both, cov.nDocs)}) unicode=${pct(cov.uni, cov.nDocs)} ` +
    `pickEntries=${pct(cov.withPicks, cov.nDocs)}`);
  console.log(`[pbt-1] pairs: ${JSON.stringify(cov.verdicts)} anchors=${JSON.stringify(cov.anchors)}`);
  if (cov.both / cov.nDocs < 0.8) throw new Error('coverage: Picks+fence < 80%');
  if (cov.verdicts.tie === 0) throw new Error('coverage: no same-anchor ties sampled');
  if (cov.verdicts.conflict === 0) throw new Error('coverage: no conflicts sampled');
  try {
    fc.assert(propTP1, { numRuns: NUMRUNS, seed: SEED });
    console.log(`[pbt-1] TP1 convergence: PASS (${NUMRUNS} runs, drops=0 — validity by construction, no fc.pre)`);
    fc.assert(propTie, { numRuns: NUMRUNS, seed: SEED + 1 });
    console.log(`[pbt-1] same-anchor tie-break determinism: PASS (${NUMRUNS} runs)`);
  } catch (e) {
    const edn = `{:slice 1 :seed ${SEED} :num-runs ${NUMRUNS} :failed true\n` +
      ` :error ${JSON.stringify(String(e && e.message || e)).slice(0, 2000)}}`;
    writeFileSync('/tmp/opencode/pbt-1-failures.edn', edn + '\n');
    console.error(`[pbt-1] FAIL — counterexample in /tmp/opencode/pbt-1-failures.edn\n${e && e.message}`);
    process.exit(1);
  }
  console.log(`[pbt-1] exports: { docArb, genPair } (+ opArbFor, opPairArb, tieArb, anchorsFor, toWire, applyOp, xform, orderOps, countPicks, classifyPair)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// Sync bridge for slice-2-style harnesses: one concurrent pair for a given doc,
// wire form [["retain"|"delete"|"insert", payload]]. Sampling is seed-driven by caller.
export function genPairFn(doc) {
  const [a, b] = fc.sample(opPairArb(doc), 1)[0];
  return [toWire(a), toWire(b)];
}
