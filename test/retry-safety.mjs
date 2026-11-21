// retry-safety.mjs — a write must never be re-emitted without proof it failed.
// Regression for the old poll-timeout branch, which re-emitted whenever the
// revision or hash was unchanged (i.e. almost always) and could duplicate an
// append on a slow /download.
import { atom, deref, swap_BANG_, ex_info } from 'squint-cljs/src/squint/core.js';
import { append_to_section } from '../hedgedoc_mcp/tools.mjs';
import * as st from '../hedgedoc_mcp/state.mjs';
import * as m from '../hedgedoc_mcp/model.mjs';

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

function makeEnv({ content, send, download, onFirstSend }) {
  const state = atom(st.make_initial('n', 0, m.normalize(content), Date.now()));
  const inflight = atom(null);
  const snap = st.snapshot_for_cas(state);
  const env = {
    state,
    inflight,
    auth: () => ({ kind: 'user', status: 'ok', name: 'test' }),
    'doc-reset': () => null,
    'clear-doc-reset!': () => {},
    'allow-guest-writes?': false,
    'connected?': () => true,
    'now-ms': () => Date.now(),
    'send-op!': send,
    'fetch-download': download,
    'get-presence': () => ({ users: [], selections: [] }),
    'sleep-ms': () => Promise.resolve(),
    'max-retries': 3,
    'poll-ms': 1,
    'poll-timeout-ms': 5,
    'idle-ms': 0,
    config: {},
  };
  const args = {
    heading: 'S',
    text: '+ appended once',
    'base-rev': snap.rev,
    'base-hash': snap.hash,
    verify: true,
  };
  return { env, state, inflight, args, snap };
}

// A. Poll timeout: one emit, reported unconfirmed, never retried.
{
  let sends = 0;
  const { env, inflight, args } = makeEnv({
    content: '## S\n\nalpha\n',
    send: () => { sends += 1; return Promise.resolve({ kind: 'emitted' }); },
    download: () => Promise.resolve({ content: '## S\n\nalpha\n' }),
  });
  const res = await append_to_section(env, args);
  check(sends === 1, `poll timeout emits once (got ${sends})`);
  check(res.status === 'applied-but-unconfirmed', 'poll timeout is reported unconfirmed');
  check(deref(inflight) === null, 'inflight cleared');
}

// B. send-op rejects before emitting (socket vanished), then succeeds on retry.
{
  let calls = 0;
  const { env, inflight, args } = makeEnv({
    content: '## S\n\nalpha\n',
    send: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(ex_info('none', { code: 'not-connected' }));
      return Promise.resolve({ kind: 'emitted' });
    },
    download: () => Promise.resolve({ content: '## S\n\nalpha\n' }),
  });
  const res = await append_to_section(env, args);
  check(calls === 2, `pre-emit rejection retries once (got ${calls} calls)`);
  check(res.status === 'applied-but-unconfirmed', 'retry still reports unconfirmed when the poll lags');
  check(deref(inflight) === null, 'inflight cleared after retry');
}

// C. Content moved before the retry: abort instead of applying stale ops.
{
  let calls = 0;
  const { env, args, state } = makeEnv({
    content: '## S\n\nalpha\n',
    send: () => {
      calls += 1;
      // A human edits the section between the rejected emit and the retry.
      swap_BANG_(state, (v) => ({ ...v, content: '## S\n\nalpha changed\n' }));
      return Promise.reject(ex_info('none', { code: 'not-connected' }));
    },
    download: () => Promise.resolve({ content: '## S\n\nalpha changed\n' }),
  });
  let code = null;
  try { await append_to_section(env, args); } catch (e) { code = e?._data?.code ?? null; }
  check(code === 'target-moved', `moved content aborts the retry (code ${code})`);
  check(calls === 1, `no second emit after content moved (got ${calls})`);
}

// D. A synchronous throw from send-op! must not leak :inflight.
{
  let calls = 0;
  const { env, inflight, args } = makeEnv({
    content: '## S\n\nalpha\n',
    send: () => {
      calls += 1;
      if (calls === 1) throw ex_info('sync', { code: 'not-connected' });
      return Promise.resolve({ kind: 'emitted' });
    },
    download: () => Promise.resolve({ content: '## S\n\nalpha\n' }),
  });
  await append_to_section(env, args);
  check(calls === 2, `sync throw is retried (got ${calls})`);
  check(deref(inflight) === null, 'sync throw does not leak inflight');
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
