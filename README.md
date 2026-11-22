# hedgedoc-mcp

An MCP server that lets an agent read and edit live HedgeDoc 1.x notes without
dropping a human's typing on the floor.

HedgeDoc 1.x has no supported document write API. Every edit goes over its live OT socket
(operational transformation, which merges concurrent edits), so an agent that
reads a note, thinks for a minute, and writes the whole document back will erase
whatever a person typed in between.

This server sits between the agent and that socket. It gives the agent ordinary
read and edit tools, and every write carries the revision it was based on
(`rev`, the note's edit counter) and the content hash (`hash`, a digest of the
note text). If the note moved, the write is refused and nothing is sent. By
default, if it lands, the server reads the edited region back through
HedgeDoc's download endpoint before reporting success.

It was built for [LINUX Unplugged](https://linuxunplugged.com) show notes, where
two hosts and an agent work on the same document before a show. Nothing in it is
specific to that show, and it targets any HedgeDoc 1.12 note your account can
edit.

Unofficial client. Not affiliated with or endorsed by the HedgeDoc project.

## Status

| Item | State |
|---|---|
| Version | `0.2.3` |
| HedgeDoc 1.12 | Tested |
| HedgeDoc 1.11 | Expected to work, not exercised yet |
| HedgeDoc 1.10 and older | Refused at connect (they use Socket.IO 2) |
| HedgeDoc 2 | Not supported |
| Install | Nix is supported today; the npm package is not published yet |

## Requirements

- A HedgeDoc 1.12 instance, reachable over HTTP or HTTPS. 1.11 should work
  but has not been exercised yet.
- A registered account that can edit the target note. Use a dedicated bot
  account, not a person's login.
- The note id, which is the last path segment of the note URL.
- Node 20 or newer, or Nix.

You do not need shell access to the HedgeDoc host, a server-side plugin, or a
database connection.

## Install

### Nix

```bash
nix run github:noblepayne/hedgedoc-mcp
nix profile install github:noblepayne/hedgedoc-mcp
```

The flake package carries Node, the compiled server, and a `hedgedoc-mcp`
binary that starts the multi-note supervisor.

### From source

The npm package is not published yet, so `npm install -g hedgedoc-mcp` does not
work today. Build it from a clone instead:

```bash
git clone https://github.com/noblepayne/hedgedoc-mcp
cd hedgedoc-mcp
npm install
npm run build
node hedgedoc_mcp/multi.mjs
```

`npm run build` is `npx squint compile`, which writes `hedgedoc_mcp/*.mjs` from
`src/hedgedoc_mcp/*.cljs`. The compiled output needs Node 20 or newer, and the
`start` script runs the same entry point.

## Configure

The server takes settings from the environment and nothing else. Point it at an
instance and a note, then give your MCP client a stdio entry.

OpenCode, in a project `opencode.json` or the global config:

```json
{
  "mcp": {
    "hedgedoc": {
      "type": "local",
      "command": ["hedgedoc-mcp"],
      "environment": {
        "HEDGEDOC_URL": "https://hedgedoc.example.com",
        "HEDGEDOC_EMAIL": "bot@example.com",
        "HEDGEDOC_PASSWORD": "…",
        "HEDGEDOC_NOTE_ID": "<note-id>"
      }
    }
  }
}
```

Claude Desktop and other clients that use `mcpServers`:

```json
{
  "mcpServers": {
    "hedgedoc": {
      "command": "hedgedoc-mcp",
      "env": {
        "HEDGEDOC_URL": "https://hedgedoc.example.com",
        "HEDGEDOC_EMAIL": "bot@example.com",
        "HEDGEDOC_PASSWORD": "…",
        "HEDGEDOC_NOTE_ID": "<note-id>"
      }
    }
  }
}
```

Restart the client after adding the entry. The tools appear under the server
name you chose.

`HEDGEDOC_NOTE_ID` sets a default note. You can omit it and pass `note-id` on
every call instead, which is useful when the agent should not have a default
target. Set `HEDGEDOC_MAX_NOTES` to cap how many notes one server process may
open.

### Variables

| Variable | Required | Notes |
|---|---|---|
| `HEDGEDOC_URL` | yes | Instance URL. A subpath such as `https://host/notes` works. |
| `HEDGEDOC_NOTE_ID` | no | Default note. Required by the single-note `core.mjs`, optional in the default multi-note binary. |
| `HEDGEDOC_EMAIL` / `HEDGEDOC_PASSWORD` | auth | Preferred. The server logs in and refreshes the session. `HEDGEDOC_USER` is an alias for the email. |
| `HEDGEDOC_COOKIE` | auth | Full cookie pair, `connect.sid=<value>`, for when you have no password. |
| `HEDGEDOC_CLIENT_MAJOR` | no | `4` (default). |
| `HEDGEDOC_TRANSPORTS` | no | `websocket` (default), `polling`, or `websocket,polling`. |
| `HEDGEDOC_POLL_TIMEOUT_MS` | no | Budget for confirming a write, in ms. Default 10000. |
| `HEDGEDOC_POLL_MS` | no | Poll interval, in ms. Default 500. |
| `HEDGEDOC_MAX_NOTES` | no | Worker cap in the multi-note binary. Default 32. |
| `HEDGEDOC_IDLE_MS` | no | Presence idle threshold, in ms. Default 30000. |
| `HEDGEDOC_ALLOW_GUEST_WRITES` | no | Allow writes over a guest session. Most HedgeDoc 1.12 instances still refuse the room join. |
| `HEDGEDOC_ENABLE_SET_NOTE` | no | Expose the gated whole-document replace tool. |

Auth is email plus password, a session cookie, or a guest session for reads.
Guest writes are best effort: on 1.11 and 1.12 a guest usually cannot join the
OT room, so use a registered bot account for edits.

## First edit

Start the client and give the agent the note id. A useful first prompt:

> Use the `hedgedoc` tools for note `<note-id>`. Call `get-status` until the rev
> is no longer -1, read the section you want to change, and dry-run a line edit.
> Show me the preview and do not write until I say so.

The first `get-status` can return `rev: -1` and `connected: false` while the
server logs in and joins the note. Call it again after a second, or pass
`waitMs: 5000` to hold the call until boot lands. `waitMs` takes an integer from
0 to 15000 and defaults to 0. The wait costs wall-clock time on that call, at
most the number you pass.

`writable` tells you whether a write can go out now: the revision is known, the
socket is connected, and the session may join the OT room. A cold or
disconnected worker returns `writable: false` with a `hint` that says it is
still booting. That is normal while the backend is down, not an error, and the
status is still complete, with `rev: -1` before boot. `rev-known` reports the
revision on its own, and `waitedMs` reports how long the wait took.

A dry run returns a window of numbered lines around the edit and writes nothing.
Pass `preview: "region"` to see the whole affected range, or `preview: "tail"`
for its last 12 lines. `window` is the default and keeps the six-line radius.
The example is abridged. The full result also carries `would-be-hash`,
`preview-lines`, and `ops`, and it has no `new-rev` because nothing was emitted.

```json
{
  "dry-run": true,
  "status": "dry-run",
  "written": false,
  "base-rev": 4,
  "base-hash": "ab23c794…",
  "preview": "72 | the line before\n73 | the edited line\n74 | the line after",
  "hint": "no write was emitted; rev and hash are the current base"
}
```

A dry run on the five write tools also returns `preview-mode` (the mode you
asked for), `preview-lines` (`start-line` and `end-line` for the returned
window), `preview-total-lines` (lines in the affected range before truncation),
and `preview-truncated` (true when the mode does not show the whole range). A
preview stops at 200 lines or 4000 UTF-16 units of rendered text, whichever
comes first, and it keeps whole lines. These keys appear on dry runs only; an
actual write keeps the success shape below.

If the preview looks right, call the same tool with `dryRun: false`. A write that
lands reports how the server checked it:

```json
{
  "status": "confirmed",
  "verified": "download-poll",
  "new-rev": 5,
  "new-hash": "dc19bc80…"
}
```

The full result adds `preview`, `via`, and `op-id`.

| `verified` | Meaning |
|---|---|
| `download-poll` | The edited region was read back from HedgeDoc's `/download` endpoint. |
| `ack` | `verify: false`. The server waits up to 1.5 s for the revision to advance and its local copy of the note to hold the new content, without polling the document. |

A timeout is `status: applied-but-unconfirmed`, not success: the op may have
landed. Re-read the note and decide from there.

## How writes are gated

### Compare and swap (CAS) inside the server

Every write takes `base-rev` and `base-hash` from a fresh read. Before emitting,
the server compares both against its current view of the note. If either moved,
the write is refused with the current values and nothing goes out. The wire
protocol has no `base-hash`, so the comparison happens inside this server; the
`/download` poll is the durability check.

### One emit per write

If the poll cannot confirm the write, the tool says so and stops. A timeout is
`applied-but-unconfirmed`, not proof that the first op failed, so it is not
retried automatically. Retries are only for failures that happen before the op
leaves the socket. Re-read and decide.

### Per-socket revisions

A reconnect invalidates the local revision, and writes are refused with
`rev-unknown` until a `doc` frame supplies the new one. After a resync the server
rejoins; it does not guess the revision.

### Serialized writes

A second write on the same note while one is running is rejected with
`emit-in-flight`. Wait for the first to finish.

### One worker per note

The default binary runs an isolated core process for each note, so notes do not
share a socket, revision state, or in-flight write.

### Errors and retry advice

A tool error carries `code`, `message`, and `data`. Five codes add a top-level
`retryable` flag next to those keys:

| Code | `retryable` | `retryAfterMs` |
|---|---|---|
| `not-connected` | true | 1000 |
| `rev-unknown` | false | absent |
| `stale-revision` | false | absent |
| `emit-in-flight` | false | absent |
| `write-needs-user` | false | absent |

`download-failed` and every other error code carry no retry fields, so a client
that reads `retryable` sees it absent rather than false. A `stale-revision` or
`rev-unknown` write needs a fresh read and a rebuilt base, not a retry of the
same one. `not-connected` is the code where a bounded retry after a second is
the intended behavior.

`applied-but-unconfirmed` is a result, not an error. It has `retryable: false`
and stays under `status`, because the op may have landed. Re-read the note and
decide; a blind re-emit can duplicate the edit.

## Tools

| Tool | What it does |
|---|---|
| `get-status` | Reports revision, hash, headings, idle time, rev velocity, auth kind, connection state, and `writable`. `waitMs` waits for boot and reports `waitedMs`. |
| `read-section` | Returns one heading's content with UTF-16 offsets. `occurrence` picks among duplicate headings, `level` narrows by heading level, and `includeSubsections` reads the whole subtree. A subtree read can be written back with the same flags. |
| `read-note` | Returns the note, or a page of lines, with front matter and heading line numbers. `sections` controls the heading list. |
| `apply-ops` | Writes raw ops under CAS, or replaces a section body via `new-section-text` plus `heading`. `includeSubsections` replaces the whole subtree. |
| `append-to-section` | Inserts a block at the end of a section, before the next heading. `includeSubsections` appends after the last child. |
| `replace-lines` | Applies batch single-line edits with an `old` match, bottom-up. |
| `replace-range` | Replaces a 1-based line range with one or more lines, exact `oldText`, one CAS write. |
| `insert-lines` | Inserts before a line. `total+1` appends. |
| `delete-lines` | Deletes a line range, one line by default. Refuses to run past the end of the note. |
| `search` | Searches lines by substring or regex, case insensitive by default. |
| `presence` | Reports users and selection data, advisory only; the gate is the pre-emit overlap check inside `apply-ops`. |
| `list-notes` | Lists notes with a live worker, plus the default note. |
| `set-note` | Replaces the whole document under the gate; only with `HEDGEDOC_ENABLE_SET_NOTE`. |

### Arguments

| Argument | Tools | Notes |
|---|---|---|
| `note-id` | Every tool except `list-notes`, in the multi-note binary | Selects the worker. The single-note `core.mjs` rejects it. |
| `waitMs` | `get-status` | Integer 0..15000, default 0. Waits up to that many ms for boot to land, then returns the status with `waitedMs`. Costs wall-clock time on the call. |
| `level`, `includeSubsections` | `read-section`, `apply-ops`, `append-to-section` | `level` is 1..6 and filters without a fallback. `includeSubsections: true` reads or writes from after the heading line to the next heading at or above that level, or to the document end. A subtree read returns `writeRoundTrip: true` and echoes the anchor. Raw ops plus either flag is `bad-args`. |
| `sections` | `read-note` | `"all"` (default), `"none"`, or `"window"` for headings inside the returned slice. A boolean is rejected with a hint to use `"none"`. `get-status` still returns every heading. |
| `base-rev`, `base-hash` | Every write | Taken from a fresh read. A stale base is refused. |
| `startLine`, `endLine`, `oldText`, `newText` | `replace-range` | Inclusive 1-based range. `oldText` is the lines joined by `\n`, no trailing newline. `newText` may be multi-line; blank deletes the range. |
| `dryRun` | Write tools | Returns a numbered preview with `status: dry-run` and `written: false`, and emits nothing. Aliases: `dry-run`, `dry_run`, `dry-run?`. |
| `preview` | `apply-ops`, `append-to-section`, `replace-lines`, `insert-lines`, `delete-lines` | Dry-run only: `"window"` (default, six-line radius around the target), `"region"` (the whole affected range), or `"tail"` (its last 12 lines). `set-note` does not take it. |
| `verify` | Write tools | `false` skips the download poll and reports `verified: ack` once the revision has advanced and the intended content is visible locally. Alias: `verify?`. |
| `regex`, `caseSensitive` | `search` | Aliases: `regex?`, `case-sensitive?`. |
| `force`, `reason` | `set-note` | Required. `set-note` takes none of the flags above. |

Use the camelCase names. The older spellings still parse, so clients written
against 0.2.0 keep working, and a conflict between an alias and its canonical
spelling is rejected as `bad-args`.

Typical loop: `get-status`, then `read-note` or `read-section`, then a dry run,
then the write. On `stale-revision`, read again and use the new rev and hash. On
`applied-but-unconfirmed`, re-read before doing anything else.

## Troubleshooting

| Result | What to do |
|---|---|
| `rev: -1`, `connected: false`, `writable: false` | The worker is still booting. Call `get-status` again, or pass `waitMs`. A down backend keeps `writable` false without failing the call. |
| `rev-unknown` | The socket reconnected. Call `get-status` and wait for a doc frame. |
| `not-connected` | The socket is down. `retryable` is true and `retryAfterMs` is 1000, so a retry after a second is expected. |
| `stale-revision` | The note moved. Read again and use the new rev and hash. |
| `line-mismatch` | The `old` line is not there anymore. Read the note and fix the edit. |
| `applied-but-unconfirmed` | Re-read before doing anything else. Do not re-emit blindly. |
| `emit-in-flight` | Another write is running. Wait for it to finish. |
| `write-needs-user` | You are a guest. Use the bot account. |
| `range-mismatch` | `oldText` is not the current text of those lines. Read again and rebuild it. CRLF input fails with an LF hint. |
| `range-out-of-range` | `startLine`/`endLine` are inverted or outside the note. Read the line count and retry. |
| 401 or `unauthorized` | Check the email, password, or cookie. |
| `oversize` | The write would pass 100 KB. Split it or edit a smaller region. |
| `download-failed` | Check `HEDGEDOC_URL`, the note id, the cookie, and reachability. |

## Limits

- CAS runs inside this server. The wire protocol has no `base-hash`, so the gate
  compares against the local copy this server keeps.
- A write whose result would exceed 100 KB is refused. Larger notes can still be read.
- ATX headings and backtick fences are recognized. Setext headings and `~~~`
  fences are not. An indented ATX heading is not recognized either, so it does
  not end a subtree read.
- A subtree append lands after the last child, so the added text reads as part
  of that child. That is inherent to the requested semantics; use the child
  heading directly if the text belongs to the parent.
- `length` counts the returned lines joined by `\n`, excluding the newline that
  ends the last returned line. `doc-length` includes the single trailing
  newline. `read-section` includes that newline when the section is last.
- `new-section-text` constructs one blank line after the heading, then the body
  with leading and trailing blank lines stripped. A body starting with `-`, `+`,
  text, or a fence keeps the conventional blank line. Empty text produces only
  that blank line, or `## H` followed by the next heading when the section is
  last. A read-then-restore is stable after one pass; the second restore is a
  `no-op`.
- There is no undo. HedgeDoc's own history is the recovery path.
- HedgeDoc 2 is not supported.
- `search` with `regex: true` uses JavaScript's backtracking engine. A
  pathological pattern on a very long line can block the worker; the multi-note
  supervisor recycles it after 180 seconds. Prefer substrings for untrusted
  patterns.

## Security

- Use a dedicated bot account with edit rights only on the notes it needs. Do
  not use a person's primary login.
- Passwords are not logged. Logs carry note ids, revisions, error codes, the
  target URL, and the account display name.
- The server speaks stdio. It does not listen on a port.
- `set-note` is off unless explicitly enabled, and requires `force` and
  `reason`.
- Rotate the bot password if it leaks.

## Development

```bash
npm install
npm run build
npm run test:pbt
node test/snapshot-gc.mjs
node test/retry-safety.mjs
node test/remote-op-fold.mjs
node test/bin-launch.mjs
node test/arg-validation.mjs
./scripts/e2e.sh
nix flake check
```

[`scripts/e2e.sh`](scripts/e2e.sh) brings up a disposable HedgeDoc with
`podman-compose` if `127.0.0.1:3000/status` is not already answering, registers
`bot@dev.local`, and needs open registration on the instance. Set `HEDGEDOC_URL`
to use an existing dev instance instead.

`nix flake check` builds the package and runs the version check, property tests,
GC, retry, remote-op, launcher, and argument validation suites from
`package.nix`. It checks the current system; pass `--all-systems` only when
builders for the other systems are configured.

[`AGENT_SCENARIOS.md`](AGENT_SCENARIOS.md) has the scenario suite in prompt
form, and `test/agent-scenarios.mjs` automates it. `CONTRIBUTING.md` covers the
gate and the write-path rules; [`docs/PROTOCOL.md`](docs/PROTOCOL.md) records
the wire facts.

## License

MIT, see [`LICENSE`](LICENSE). HedgeDoc itself is AGPL and runs as a separate
process.
