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
| Version | `0.2.1` |
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
server logs in and joins the note. Call it again after a second. Once the rev is
a number, the session is ready.

A dry run returns a window of numbered lines around the edit and writes nothing.
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

## Tools

| Tool | What it does |
|---|---|
| `get-status` | Reports revision, hash, headings, idle time, rev velocity, auth kind, and connection state. |
| `read-section` | Returns one heading's content with UTF-16 offsets. `occurrence` picks among duplicate headings. |
| `read-note` | Returns the note, or a page of lines, with front matter and heading line numbers. |
| `apply-ops` | Writes raw ops under CAS, or replaces a section body via `new-section-text` plus `heading`. |
| `append-to-section` | Inserts a block at the end of a section, before the next heading. |
| `replace-lines` | Applies batch 1-based line edits with an `old` match, bottom-up. |
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
| `base-rev`, `base-hash` | Every write | Taken from a fresh read. A stale base is refused. |
| `dryRun` | Write tools | Returns the preview window with `status: dry-run` and `written: false`, and emits nothing. Aliases: `dry-run`, `dry_run`, `dry-run?`. |
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
| `rev: -1`, `connected: false` | The worker is still booting. Call `get-status` again after a second. |
| `rev-unknown` | The socket reconnected. Call `get-status` and wait for a doc frame. |
| `not-connected` | The socket is down. Retry after a second. |
| `stale-revision` | The note moved. Read again and use the new rev and hash. |
| `line-mismatch` | The `old` line is not there anymore. Read the note and fix the edit. |
| `applied-but-unconfirmed` | Re-read before doing anything else. Do not re-emit blindly. |
| `emit-in-flight` | Another write is running. Wait for it to finish. |
| `write-needs-user` | You are a guest. Use the bot account. |
| 401 or `unauthorized` | Check the email, password, or cookie. |
| `oversize` | The write would pass 100 KB. Split it or edit a smaller region. |
| `download-failed` | Check `HEDGEDOC_URL`, the note id, the cookie, and reachability. |

## Limits

- CAS runs inside this server. The wire protocol has no `base-hash`, so the gate
  compares against the local copy this server keeps.
- A write whose result would exceed 100 KB is refused. Larger notes can still be read.
- ATX headings and backtick fences are recognized. Setext headings and `~~~`
  fences are not.
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
