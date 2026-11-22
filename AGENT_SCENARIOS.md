# Agent scenario suite: real edits on a disposable copy

Purpose: a fresh agent can prove the MCP still does real editorial work after
any change. Run it against a **disposable instance**, never production. Every scenario is
reversible; the last one proves the document was restored.

Automated version: `test/agent-scenarios.mjs` (does all of this and exits
non-zero on failure). This file is the human/agent prompt form.

## Setup

Target: a HedgeDoc 1.12 instance. Credentials for a registered account
that can edit the note. A source episode to copy (e.g. `<source-note-id>`).

1. Log in and read the cookie:
   ```
   curl -sk -c jar -o /dev/null -X POST "$BASE/login" \
     -d "email=$EMAIL&password=$PASSWORD"
   ```
2. Copy a source episode into a fresh note (never edit the source):
   ```
   curl -sk "$BASE/<source>/download" -o src.md
   curl -sk -b jar -D - -o /dev/null -X POST "$BASE/new" \
     -H 'Content-Type: text/markdown' --data-binary @src.md | grep -i ^location
   ```
   Record the new note id as `$NOTE`.
3. Point an MCP instance at it (`HEDGEDOC_URL`, `HEDGEDOC_NOTE_ID`, email +
   password). If the instance uses a subpath, keep it in `HEDGEDOC_URL`; the
   adapter handles base paths and the socket path.
4. Record the baseline: `get-status` → `rev`, `hash`; `read-note` →
   `total-lines`, `doc-length`, `length`, and the first 40 chars (front matter).

## Scenarios

Each step states the expected result. Anything else is a failure; report the
tool result verbatim.

**S1: orientation.** `get-status` (rev ≥ 0, auth kind "user", sections > 0);
`read-note` with no args (front matter visible, heading list carries line
numbers, `length` > 0); `read-section` on one heading (start/end integers).
Fail if front matter is invisible or sections have no line numbers.

**S2: dry-run never writes.** Pick a distinctive line. `replace-lines` with
`dryRun: true`. Expect `dry-run: true`, `written: false`, a numbered preview
around the target line (not the first 2 KB), and **no change** to rev or hash.
Repeat with `preview: "region"` and `preview: "tail"`; `preview-mode` must echo
the requested mode, `preview-total-lines` must report the affected range, and
`preview` must stop at 200 lines or 4000 UTF-16 units with `preview-truncated`
set. Re-read `get-status` after each mode to prove nothing was written.

**S3: single-line edit.** `replace-lines` on that line (append a marker),
then `read-section` the section: marker present. Revert with another
`replace-lines`; marker gone. Both writes must report `verified`
(`download-poll` or `ack`), not `emitted`.

**S4: batch line edit.** Change four consecutive/related lines in one call
(e.g. grammar fixes). Expect one write, preview showing all target lines, and
all four changes present. Revert as one batch.

**S5: section rewrite.** `read-section <heading>` without `includeSubsections`
and capture the body. `apply-ops` with `heading` + `new-section-text` (dry-run
first with `preview: "region"`, then `"tail"`; the last line of the
replacement must appear in both, and nothing is written). Apply, assert the
new text, then restore with `new-section-text` using the captured content.
Restored content must equal the capture after trimming. A body starting with
`-` must keep one blank line under the heading.

**S6: appended block.** `read-section <heading>` capture. `append-to-section`
a multi-line block (a pick or a feedback quote). Assert the block landed at the
section end **and that a blank line still separates it from the next heading**
(the bug that shipped once). Restore with `new-section-text`; content equals
capture after trimming.

**S7: stale write.** Using a rev at least 3 behind, `replace-lines` with the
current hash. Expect `stale-revision` with `server-rev`/`server-hash` and a
hint. Then re-read and perform the same edit successfully.

**S8: line mismatch.** Current rev/hash, but `:old` deliberately wrong.
Expect `line-mismatch` with `:line`, `:expected`, `:actual` and a hint. No
write must occur.

**S9: insert / search / delete.** `insert-lines` a marker at the end of the
note; `search` must find exactly that line; `delete-lines` it; `search` must
return nothing. All with one attempt (no retries).

**S10: integrity.** Full-document content must be back to the baseline after
normalizing blank lines (diff non-blank lines only). Fence parity unchanged
(count ``` lines, must be even). `total-lines` within ±2 of baseline.

**S11: concurrency (optional, needs a second client).** A human edit lands
between your read and write (e.g. `curl` a socket op, or a second MCP). Expect
`stale-revision`; retry once with the fresh base and succeed. If no second
client is available, skip and say so.

**S12: subtree append and replace.** `read-section <parent>` with
`includeSubsections: true`; it must return `writeRoundTrip: true` and echo
`heading`, `level`, `occurrence`, and `includeSubsections`. Append a marker with `includeSubsections: true`; it must land after the
last child, before the next sibling, with one blank line. Restore with
`apply-ops` `new-section-text` + the same flags using the captured subtree;
content equals the capture after trimming.

**S13: replace-range.** Pick two adjacent lines. `replace-range` with exact
`oldText` and a three-line `newText`; verify both markers and one extra line.
Restore with `replace-range` over the three lines back to the original text.
Line count and markers return to baseline.

## Report

For each scenario: PASS/FAIL, tool, revs before/after, verification field,
and a one-line note. End with: copy URL, baseline vs final hash, and any
whitespace drift. Fail the run if any write reported `emitted` without an
ack, if a dry-run changed rev/hash, or if any marker text survives S9.

## Cleanup

The copy is disposable. Leave it for inspection and include the URL, or
delete it in the web UI when you are done.

## Known traps

- **Revisions are per note-instance memory.** When the last client disconnects
  (or the server rejects an op), the next connection starts at rev 0 and
  receives a fresh `doc`. A write built on an older rev is rejected and the
  download poll cannot confirm it (`applied-but-unconfirmed`). The adapter
  never re-emits after an emit. The correct agent behaviour is: re-read,
  check whether the intent already landed, and only then write again with the
  fresh rev.
- **Cost of `parse-sections`.** It must stay linear. Squint's lazy `rest`
  made it O(n-squared); an 841-line note took 7.3 s, which exceeded the
  socket heartbeat and caused the disconnect/rev-reset cycle. If long-note
  latency regresses, benchmark `parse-sections` first.
- **Login rate limit.** Repeated harness runs trip the dev login limiter
  (HTTP 429). Restart the app container to clear it, and do not loop logins.
- **Strict runs.** `WRITE_ATTEMPTS=1` disables the harness retry so a pass
  means one clean attempt per operation. Use it as the gate.
- **Boot and retry.** `get-status` accepts `waitMs` up to 15000, and `writable`
  is false until the worker has a revision and a live socket. `not-connected`
  carries `retryable: true` and `retryAfterMs: 1000`; `stale-revision` and
  `rev-unknown` do not, because they need a fresh read. `applied-but-unconfirmed`
  is a result with `retryable: false`, not an error.
- **Transport.** `HEDGEDOC_TRANSPORTS` selects the engine.io transports
  (default `websocket`; `polling` or `websocket,polling` also work). Both have
  shown heartbeat drops in this environment (`ping timeout` / `transport
  error`), so the adapter treats reconnects as normal: it invalidates the rev,
  re-joins for a `doc` frame, and refuses writes until a fresh rev arrives.
  Retries happen only before an op leaves the socket. If you see repeated
  drops, try `polling`.

- `read-note` `:doc-length` is the full note in UTF-16 (including the final
  newline); `:length` is the returned slice. Compute retain counts from
  `:doc-length`, not from `content.length`.
- Restoring a section through `:new-section-text` can normalize one leading
  blank line; compare after trimming.
- If the app restarts mid-run the note rev resets to 0; that is a server
  restart, not an adapter bug; note it and rerun.
- The adapter refuses writes when the session is a guest; `get-status.auth`
  tells you which kind you have.
