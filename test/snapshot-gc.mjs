// snapshot-gc.mjs — fast node assertions for the SPEC §5 snapshot-audit
// predicates compiled from src/hedgedoc_mcp/state.cljs (Squint).
// Pure only, no server, no clock globals (now-ms passed explicitly).
//
// Contracts assumed:
//   - make_initial(note-id, rev, content, now-ms) -> value map with
//     :snapshot nil + :ops-since-snapshot 0 (additive keys).
//   - snapshot_record(rev, hash, now-ms) -> {:rev :hash :at}.
//   - snapshot_valid_QMARK_(value, snapshot) -> bool (re-verify).
//   - is_snapshot_needed_QMARK_(value, threshold, now-ms, ttl-ms) -> bool.
//     ttl-ms null disables the TTL leg.
//   - can_gc_QMARK_(op-rev, snapshot-rev, remaining, min-retain) -> bool.
//   - prune_op_log(op-log, snapshot, min-retain) -> retained array (order kept).
//
// Run: node snapshot-gc.mjs   (after `npx squint compile` in repo root)
import { strict as assert } from 'node:assert';

import {
  make_initial,
  content_hash,
  snapshot_record,
  snapshot_valid_QMARK_,
  is_snapshot_needed_QMARK_,
  can_gc_QMARK_,
  prune_op_log,
} from '../hedgedoc_mcp/state.mjs';

const EVERY = 5;   // SNAPSHOT_EVERY
const RETAIN = 10; // GC_RETAIN

function opLog(revs, atBase = 0) {
  return revs.map((r) => ({ rev: r, hash: `h${r}`, at: atBase + r }));
}
function revsOf(log) {
  return Array.from(log).map((op) => op.rev);
}

// --- (1) threshold edges: op-count + version-distance, both sides ---------
function checkThresholdEdges() {
  const base = make_initial('note', 0, '# Show\n', 1000);
  const snap0 = snapshot_record(0, content_hash(base), 1000);
  const at = (rev, ops, nowMs = 2000, ttl = null) => ({
    ...base, rev, snapshot: snap0, 'ops-since-snapshot': ops,
  });
  // just below on both legs -> false
  assert.equal(is_snapshot_needed_QMARK_(at(4, 4), EVERY, 2000, null), false,
    'rev-dist 4 + ops 4 vs threshold 5 must not trigger');
  // op-count leg hits exactly threshold -> true
  assert.equal(is_snapshot_needed_QMARK_(at(1, 5), EVERY, 2000, null), true,
    'ops-since == threshold must trigger');
  // version-distance leg hits exactly threshold -> true (ops leg quiet)
  assert.equal(is_snapshot_needed_QMARK_(at(5, 1), EVERY, 2000, null), true,
    'rev-dist == threshold must trigger');
  // TTL leg: aged snapshot triggers only when ttl is set
  const aged = { ...base, rev: 1, snapshot: snap0, 'ops-since-snapshot': 1 };
  assert.equal(is_snapshot_needed_QMARK_(aged, EVERY, 1000 + 60_000, 60_000), true,
    'snapshot age == ttl must trigger');
  assert.equal(is_snapshot_needed_QMARK_(aged, EVERY, 1000 + 60_000, null), false,
    'null ttl must disable the TTL leg');
  // bootstrap: no snapshot yet -> true
  assert.equal(is_snapshot_needed_QMARK_(base, EVERY, 2000, null), true,
    'nil snapshot (bootstrap) must trigger');
}

// --- (2) empty log: prune is identity; nil snapshot keeps everything ------
function checkEmptyLog() {
  const snap = snapshot_record(3, 'abc', 1000);
  assert.deepEqual(revsOf(prune_op_log([], snap, RETAIN)), [],
    'prune of empty log must be empty');
  const log = opLog([1, 2, 3]);
  assert.deepEqual(revsOf(prune_op_log(log, null, 0)), [1, 2, 3],
    'nil snapshot must keep everything (nothing provably superseded)');
}

// --- (3) concurrent-inflight retain: newer than snapshotVersion survives ---
function checkInflightRetain() {
  const snap = snapshot_record(10, 'h10', 1000);
  const pruned = revsOf(prune_op_log(opLog([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]), snap, RETAIN));
  assert.deepEqual(pruned, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    'prune must drop only ops <= snapshot-rev outside the retain window');
  for (const r of [11, 12, 13, 14, 15]) {
    assert.ok(pruned.includes(r), `inflight rev ${r} newer than snapshot must survive`);
  }
  // per-op gate: newer-than-snapshot is never collectible, however much room
  assert.equal(can_gc_QMARK_(11, 10, 99, RETAIN), false,
    'op newer than snapshotVersion must never be GCable');
  assert.equal(can_gc_QMARK_(5, 10, 15, RETAIN), true,
    'covered op with room above retain floor must be GCable');
}

// --- (4) retain floor: short log untouched; remaining < minRetain blocks ----
function checkRetainFloor() {
  const snap = snapshot_record(5, 'h5', 1000);
  assert.deepEqual(revsOf(prune_op_log(opLog([1, 2, 3, 4, 5]), snap, RETAIN)), [1, 2, 3, 4, 5],
    'log shorter than minRetain must be kept whole');
  assert.equal(can_gc_QMARK_(1, 5, 9, RETAIN), false,
    'remaining 9 < minRetain 10 must block GC');
  assert.equal(can_gc_QMARK_(1, 5, 10, RETAIN), true,
    'remaining == minRetain keeps retain >= minRetain, GC allowed');
}

// --- (5) corrupt-snapshot repair: detect -> invert-or-replace -> re-verify --
function checkCorruptRepair() {
  const value = make_initial('note', 7, '# Show\nbody\n', 1000);
  const good = snapshot_record(7, content_hash(value), 1000);
  assert.equal(snapshot_valid_QMARK_(value, good), true, 'fresh marker must verify');
  // corruption: stale/tampered hash on an otherwise live value
  const corrupt = { ...good, hash: 'deadbeef' };
  assert.equal(snapshot_valid_QMARK_(value, corrupt), false,
    'tampered snapshot hash must fail re-verify');
  // repair path = replace marker from the live value (scratch copy only:
  // the live volume — value.content — is never touched), then re-verify
  const scratch = { ...value };
  const repaired = snapshot_record(scratch.rev, content_hash(scratch), 2000);
  assert.equal(snapshot_valid_QMARK_(scratch, repaired), true,
    'replaced marker must re-verify green');
  assert.equal(scratch.content, value.content, 'repair must not touch live content');
}

const CHECKS = [
  ['threshold-edges (op-count / version-distance / ttl / bootstrap)', checkThresholdEdges],
  ['empty-log prune + nil-snapshot keep-all', checkEmptyLog],
  ['concurrent-inflight retain (never GC newer than snapshotVersion)', checkInflightRetain],
  ['retain floor (retain >= minRetain)', checkRetainFloor],
  ['corrupt-snapshot repair (replace + re-verify)', checkCorruptRepair],
];

function runAll() {
  const failures = [];
  for (const [name, fn] of CHECKS) {
    try {
      fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`FAIL ${name} :: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(failures.length
    ? `RESULT: FAIL (${failures.length}/${CHECKS.length} failing)`
    : `RESULT: PASS (${CHECKS.length}/${CHECKS.length} checks)`);
  process.exitCode = failures.length ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) runAll();

export { CHECKS, runAll };
