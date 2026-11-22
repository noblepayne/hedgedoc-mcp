// error-shape.mjs — pure retry-metadata contract (WO-01).
// Runs against the compiled errors module: no socket, no boot, no note.
//   npx squint compile && node test/error-shape.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as E from '../hedgedoc_mcp/errors.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'PASS']); console.log(`PASS ${name}`); }
  catch (e) { results.push([name, 'FAIL']); console.log(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const shape = (code, data = {}) => E.shape_error(code, `msg:${code}`, data);

check('retry table has the required codes', () => {
  // P3-04 adds rate-limited; do not lock the exact key set here.
  const required = ['emit-in-flight', 'not-connected', 'rev-unknown',
                    'stale-revision', 'write-needs-user'];
  for (const code of required) assert(has(E.retry_table, code), `missing ${code}`);
});

check('not-connected: retryable true, 1000ms', () => {
  const r = shape('not-connected');
  assert(r.code === 'not-connected', `code=${r.code}`);
  assert(r.message === 'msg:not-connected', `message=${r.message}`);
  assert(r.retryable === true, `retryable=${r.retryable}`);
  assert(r.retryAfterMs === 1000, `retryAfterMs=${r.retryAfterMs}`);
});

for (const code of ['rev-unknown', 'stale-revision', 'emit-in-flight', 'write-needs-user']) {
  check(`${code}: retryable false, no delay`, () => {
    const r = shape(code);
    assert(r.retryable === false, `retryable=${r.retryable}`);
    assert(!has(r, 'retryAfterMs'), 'retryAfterMs must be absent when not retryable');
  });
}

for (const code of ['download-failed', 'bad-args', 'internal', 'no-such-code']) {
  check(`${code}: no retry fields at all`, () => {
    const r = shape(code);
    assert(!has(r, 'retryable'), 'retryable must be absent');
    assert(!has(r, 'retryAfterMs'), 'retryAfterMs must be absent');
  });
}

check('shape stays {:code :message :data}', () => {
  const r = shape('download-failed');
  assert(JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['code', 'data', 'message']),
    `keys=${Object.keys(r)}`);
  assert(r.data && typeof r.data === 'object', 'data must be an object');
});

check('catalog hint fills data.hint; caller hint wins', () => {
  const a = shape('stale-revision', { field: 'base-rev' });
  assert(typeof a.data.hint === 'string' && a.data.hint.includes('Re-read'), `hint=${a.data.hint}`);
  assert(a.data.field === 'base-rev', 'data fields preserved');
  const b = shape('stale-revision', { hint: 'mine' });
  assert(b.data.hint === 'mine', `caller hint lost: ${b.data.hint}`);
  const c = shape('not-connected');
  assert(typeof c.data.hint === 'string', 'not-connected must keep its hint');
  assert(c.data.code === undefined, 'data must not repeat :code');
});

// The applied-but-unconfirmed result is a success payload, not an error, so it
// is marked in tools.cljs rather than going through shape-error. Assert the
// source contract: the unconfirmed branch carries :retryable false, and the
// confirmed branch carries no retry advice at all.
check('applied-but-unconfirmed result is retryable: false', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/hedgedoc_mcp/tools.cljs', import.meta.url)), 'utf8');
  const start = src.indexOf('(defn- phase-b-result');
  const end = src.indexOf('(defn- idle-advisory!');
  assert(start >= 0 && end > start, 'phase-b-result not found');
  const body = src.slice(start, end);
  const u = body.indexOf(':status :applied-but-unconfirmed');
  const c = body.indexOf(':status :confirmed');
  assert(u > 0 && c > 0 && c < u, 'phase-b branch markers missing');
  assert(body.slice(u).includes(':retryable false'), 'unconfirmed branch lacks :retryable false');
  assert(!body.slice(c, u).includes(':retryable'), 'confirmed branch must not carry retry advice');
});

const failed = results.filter(([, r]) => r === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
