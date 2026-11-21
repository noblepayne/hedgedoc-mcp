# hedgedoc-mcp

A CAS-grounded MCP server for HedgeDoc 1.x: an agent can read and edit live
notes without clobbering a human editor, and a write reports exactly how it was
verified.

Built for real show-notes work (LUP-style docs), but not specific to them.

Unofficial: this is a separate client, not affiliated with or endorsed by the
HedgeDoc project.

## What it guarantees

- **Every mutation is CAS-gated.** Writes require `base-rev` + `base-hash` from
  a fresh read; a stale base is rejected with the current rev/hash, never
  silently applied.
- **Every write reports its evidence.** The adapter emits one op, then confirms
  the edited region through `/download`. `verified` is `download-poll` on
  success; a timeout is `status: applied-but-unconfirmed`, never success.
  `verify: false` is the fast path: wait up to 1.5 s for the rev to advance and
  report `verified: ack`.
- **At most one emit per write.** The adapter never re-emits after an emit. If
  the poll cannot confirm the result, the caller must re-read and decide; the
  tool returns the server hash it saw and a do-not-re-emit hint. Retries are
  only for failures that happened before the op left the socket.
- **Revisions are socket-scoped.** A reconnect invalidates the local rev.
  Writes are refused with `rev-unknown` until a `doc` frame supplies the new
  revision; the adapter re-joins after a resync rather than guessing.
- **Dry-run is real.** `dryRun: true` returns a numbered window around the edit,
  not a preview of the whole document.
- **One worker per note.** The default binary runs one isolated core process
  per note, so notes never share sockets, revision state or an in-flight write.

## Support matrix

| Component | Supported |
|---|---|
| HedgeDoc | 1.12 (tested); 1.11 expected, not exercised yet (Socket.IO 4.x) |
| HedgeDoc 1.7–1.10 | **not supported** as a client target (Socket.IO 2.x needs a different transport) |
| Node | 20+ (tested on 20, 22 and 24; ESM) |
| Transports | websocket (default), polling, both — `HEDGEDOC_TRANSPORTS` |
| Auth | email + password, session cookie, or guest for reads |

Guest **writes** are best-effort only: on 1.11/1.12 a guest usually cannot join
the OT room, so use a registered bot account for edits.

## Install

Nix first (once the repository is public):

```bash
nix run github:noblepayne/hedgedoc-mcp
nix profile install github:noblepayne/hedgedoc-mcp
```

npm:

```bash
npm install -g hedgedoc-mcp
```

The package ships the compiled CLJS and its runtime dependencies. A container
image is planned. `nix flake check` runs the property tests, GC checks, retry
regressions and a launcher test; it checks the current system only (pass
`--all-systems` with builders configured).

## Quickstart

Point it at any HedgeDoc 1.12 instance and paste the MCP entry into your client:

```bash
HEDGEDOC_URL=https://hedgedoc.example.com \
HEDGEDOC_NOTE_ID=<note-id> \
HEDGEDOC_EMAIL=bot@example.com \
HEDGEDOC_PASSWORD='…' \
hedgedoc-mcp
```

On the first call, use `get-status` and `read-note`. Every write takes the
`rev` and `hash` from that read. A dry run costs nothing and shows the exact
lines the write will produce.

## Configure

Environment only:

| Variable | Required | Notes |
|---|---|---|
| `HEDGEDOC_URL` | yes | e.g. `https://hedgedoc.example.com`; a subpath (`https://host/stage`) works |
| `HEDGEDOC_NOTE_ID` | multi: no; `core.mjs`: yes | default note in the multi-note binary; per-call `note-id` overrides it. Without a default, every call must pass `note-id` |
| `HEDGEDOC_EMAIL` / `HEDGEDOC_PASSWORD` | auth | preferred; logs in and refreshes on expiry. `HEDGEDOC_USER` is an alias for the email |
| `HEDGEDOC_COOKIE` | auth | full cookie pair, `connect.sid=<value>`, used when no credentials |
| `HEDGEDOC_CLIENT_MAJOR` | no | `4` (default) |
| `HEDGEDOC_TRANSPORTS` | no | `websocket` (default), `polling`, `websocket,polling` |
| `HEDGEDOC_POLL_TIMEOUT_MS` | no | verification poll budget, default 10000 |
| `HEDGEDOC_POLL_MS` | no | poll interval, default 500 |
| `HEDGEDOC_MAX_NOTES` | no | multi-note worker cap, default 32 |
| `HEDGEDOC_ALLOW_GUEST_WRITES` | no | allow writes with a guest session (dev/guest-open instances) |
| `HEDGEDOC_ENABLE_SET_NOTE` | no | expose the gated whole-document replace tool |
| `HEDGEDOC_IDLE_MS` | no | presence idle threshold, default 30000 |

OpenCode:

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

Claude Desktop and other `mcpServers` clients:

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

## Tools

| Tool | What it does |
|---|---|
| `get-status` | rev, hash, snapshot id, headings, idle/velocity, auth kind, connected, `rev-known` |
| `read-section` | one heading's content by title/occurrence |
| `read-note` | whole note or a page of lines; front matter, heading line numbers, `doc-length` (full) and `length` (returned slice) |
| `apply-ops` | raw CAS write (`ops`, or `new-section-text` which replaces the section body only), dry-run |
| `append-to-section` | insert a block at a section end, blank-line safe |
| `replace-lines` | batch 1-based line edits with exact `old` |
| `insert-lines` | insert before a line (`total+1` appends) |
| `delete-lines` | delete a line range |
| `search` | line search (substring or regex) |
| `presence` | advisory users/selection info |
| `list-notes` | which notes have a live worker + the default |
| `set-note` | gated whole-document replace (only with `HEDGEDOC_ENABLE_SET_NOTE`) |

In the default multi-note binary, every tool except `list-notes` accepts an
optional `note-id`. The single-note `core.mjs` rejects `note-id`. Writes accept
`dryRun` and `verify`; `set-note` instead requires `force` + `reason` and
takes neither flag. `search` takes `regex` and `caseSensitive`. The older
`dry-run?`, `verify?`, `regex?`, and `case-sensitive?` spellings are accepted
as aliases, but new clients should use the camelCase names.

Typical loop: `get-status` → `read-note`/`read-section` → dry-run → real write
→ `get-status` (or trust `verified: download-poll`). On `stale-revision`,
re-read and retry. On `applied-but-unconfirmed`, re-read; do not blindly
re-emit.

## Reliability notes

- HedgeDoc keeps OT revisions **per note instance**; when the last client
  leaves, the next connection can start at rev 0. A disconnect invalidates the
  local rev, and the adapter re-joins for a `doc` frame before writing.
- Writes are serialized per note: a second concurrent write is rejected with
  `emit-in-flight`; retry after the first completes.
- Verification costs ~0.5–1 s per write; `verify: false` returns after the ack
  (bounded by a 1.5 s wait for the rev to advance).
- A remote edit changes the document under you. CAS rejects the write if the
  rev moved; the pre-emit overlap check aborts if a remote selection covers the
  target.
- `search` with `regex: true` runs JavaScript's backtracking engine over note
  lines. A pathological pattern on a very long line can block the worker; the
  multi-note supervisor recycles a worker after 180 s. Prefer substrings for
  untrusted patterns.

## Security

- Use a **dedicated bot account** with edit rights on the target notes; do not
  use a human's primary login.
- Passwords are never logged. Logs carry note ids, revs, error codes, the
  target URL and the account display name.
- `set-note` is off unless explicitly enabled and requires `force` + `reason`.
- CAS protects content, not credentials: rotate the bot password if it leaks.
- The server is a local stdio process; it does not open a listening port.

## Development

```bash
npm install
npx squint compile
node test/pbt-1-gens.mjs
node test/pbt-3-invariants.mjs
node test/pbt-4-replace-lines.mjs
node test/snapshot-gc.mjs
node test/retry-safety.mjs
node test/remote-op-fold.mjs
node test/bin-launch.mjs
./scripts/e2e.sh            # dev HedgeDoc + scenario suite + live remote op
nix flake check             # package + PBT + GC + retry + launcher
```

`scripts/e2e.sh` boots the podman dev box if `127.0.0.1:3000/status` is not
already up, registers `bot@dev.local`, and needs open registration. Set
`HEDGEDOC_URL` to skip the podman check and use an existing dev instance.

`AGENT_SCENARIOS.md` documents the scenario suite in prompt form;
`test/agent-scenarios.mjs` automates S1–S10 (`WRITE_ATTEMPTS=1` makes it a
strict single-attempt gate); S11 (concurrency) is exercised by
`test/remote-op-live.mjs` against a real second socket.

## Known limits

- CAS is adapter-side: the wire has no `base-hash`, so the gate compares
  against the local mirror. The mirror folds remote operations and resyncs on
  any apply failure; the `/download` poll is the durability proof.
- Notes over 100 KB can be read but not safely edited (the write cap is
  intentional).
- Setext headings and `~~~` fences are not recognized; ATX headings and
  backtick fences are.
- HedgeDoc 1.10 and older are rejected at connect rather than degraded.

## License

MIT. HedgeDoc itself is AGPL; this is a separate client process.
