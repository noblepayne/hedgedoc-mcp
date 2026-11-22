# Changelog

## 0.2.3 — 2026-11-21

### Added

- Subtree writes: `includeSubsections` and `level` on `append-to-section` and
  `apply-ops` `new-section-text`. A subtree append lands after the last child;
  a subtree replace removes the children and keeps the heading line.
- `replace-range` for multi-line line-range replacement with exact `oldText`,
  one CAS write, dry-run and preview.
- `writeRoundTrip: true` on a subtree read, with the echoed heading anchor.

### Changed

- `new-section-text` constructs one blank line after the heading, strips leading
  and trailing blank lines from the body, and normalizes empty and
  whitespace-only bodies. A read-then-restore is stable after one pass.

### Fixed

- Length-changing deletes and inserts verify on the new affected span. A
  delete that shortened the document was reported applied-but-unconfirmed
  despite landing.
- A subtree replace is verified against the subtree, not the plain body up to
  the first child.

## 0.2.2 — 2026-11-21

### Added

- `get-status` `waitMs` (0..15000) and `writable`, `waitedMs`. A cold worker no
  longer fails; it waits or returns a nil-tolerant status.
- Top-level `retryable` / `retryAfterMs` on errors. `not-connected` is
  retryable after 1 s; `rev-unknown`, `stale-revision`, `emit-in-flight`, and
  `write-needs-user` are not.
- `read-section` `includeSubsections` and `level`, with a new pure subtree
  range and a `writeRoundTrip: false` advisory until subtree writes land.
- `read-note` `sections`: `"all"`, `"none"`, or `"window"`.
- `preview`: `"window"`, `"region"`, or `"tail"` on the five write tools, with
  `preview-mode`, `preview-total-lines`, and `preview-truncated`.
- Generic `:enum` validation for tool arguments.

### Fixed

- Duplicate headings all reported occurrence 0. Squint compiled
  `(assoc seen k ...)` with a literal key; `parse-sections` now uses `update`.
- A cold `get-status` threw `not-booted`; it now returns a status with
  `writable: false` and a boot hint.
- The multi-note test now uses `waitMs` instead of expecting a boot error.

## 0.2.1 — 2026-11-21

### Fixed

- Tool arguments use camelCase wire names: `dryRun`, `verify`, `regex`,
  `caseSensitive`. The old `dry-run?`, `verify?`, `regex?` and
  `case-sensitive?` names are accepted as aliases, as are `dry-run` and
  `dry_run`. A client or model that strips the question mark can no longer
  turn a dry run into a write.
- A dry run returns `status: dry-run`, `written: false`, and the current
  `base-rev`/`base-hash`. It no longer reports `new-rev` as if the write
  happened.
- Unknown arguments return `bad-args` instead of an internal error caused by
  an unbound `clojure.string` reference.

## 0.2.0 — 2026-11-21

First public release.

### Added

- CAS-gated tools: `get-status`, `read-section`, `read-note`, `apply-ops`,
  `append-to-section`, `replace-lines`, `insert-lines`, `delete-lines`,
  `search`, `presence`, `list-notes`, and gated `set-note`.
- `/download` verification with a region-intent check, plus a fast
  `verify? false` path that waits for the ack revision.
- Multi-note supervisor: one isolated core process per note, a worker cap, and
  a 180 s call timeout with recycling.
- Dry-run previews scoped to a numbered window around the edit.
- Grapheme-safe UTF-16 op construction, a 100 KB write cap, and fence-aware
  section parsing with occurrence disambiguation.
- Nix flake/package, npm package, and a podman dev box with a full E2E gate.

### Fixed

- `parse-sections` was accidentally O(n²) through Squint's lazy `rest`
  (841 lines: 7.3 s), which stalled the socket heartbeat and caused
  reconnects. It is now indexed (11.7 ms).
- A remote `operation` is folded against the server's raw trailing-newline
  tail; the compiled core now imports the model-ops namespace it uses.
- A write is never re-emitted after it leaves the socket. The old retry gate
  could duplicate an append when `/download` lagged.
- A reconnect no longer emits into socket.io's buffer: the adapter requires a
  live transport and a `doc` frame before writing.
- A resync forces a re-join for a fresh revision instead of leaving writes
  blocked at `rev-unknown`.
- Retry after a pre-emit failure only proceeds when the content is unchanged.
- The multi-note supervisor evicts only the worker that exited, fails queued
  calls, handles stdin `EPIPE`, and keeps its timeout on boot retries.
- A 401 without credentials no longer loops forever at boot.

### Packaging

- `squint-cljs` is a runtime dependency; the compiled output imports it.
- The worker path is resolved from the module URL, so `npm i -g` and `npx`
  work, not just the Nix wrapper.
- `prepack` builds the compiled files that `npm pack` ships.
