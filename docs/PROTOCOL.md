# HedgeDoc 1.x OT wire facts

Observed against HedgeDoc 1.12.0 (Socket.IO 4 / Engine.IO 4). This is the
subset this client depends on, not a complete protocol description.

## Version gate

| Server | Socket.IO | Engine.IO | Client major |
|---|---|---|---|
| 1.11–1.12 | 4.x | 4 | `socket.io-client@4` |
| 1.7–1.10 | 2.x | 3 | `socket.io-client@2` (not implemented here) |

A 1.11/1.12 server refuses a 2.x client and vice versa. The adapter checks the
`hedgedoc-version` response header and rejects an incompatible pairing before
opening the socket.

## Connection and cookie

- Socket URL: the instance origin, path `/socket.io/`, query `noteId=<id>`.
- The OT room requires a **note-scoped session cookie**. A cookie from the
  homepage or `/status` is not enough; fetch `GET /<note-id>/download` first
  (it sets `connect.sid`) or log in and then fetch `/download`.
- With `socket.io-client@4`, pass the cookie as an `extraHeaders` entry:
  `Cookie: connect.sid=<value>`.

## Frames

### `doc` (server → client)

Sent on join and on a forced rebuild. Fields used:

```json
{ "revision": 12, "str": "…", "clients": [ … ], "force": true? }
```

- `revision` is the OT revision of `str`.
- `str` is the full document, UTF-16 code units, and may end with more than one
  newline.
- `clients` is an array of presence records (advisory).
- `force: true` marks a rebuild after the server rejected/rebased an op.

### `operation` (client → server, server → other clients)

```js
socket.emit("operation", revision, ops, selection)
```

- `revision` is the client's base revision.
- `ops` is a JSON OT array:
  - retain N → `N` (positive number)
  - delete N → `-N` or `{ "d": N }` (both observed)
  - insert "s" → `"s"`
- `selection` is `null`; do not omit it.
- The server broadcasts the same event to the other clients in the room with
  the post-apply revision. This client does not receive an echo of its own op.

### `operations` (server → client, batch)

```js
(headRevision, [op, op, …])
```

Used when several operations arrive together. Each op's revision is
`headRevision + index`.

### `ack` (server → sender)

The server acknowledges the sender's op with the positioned revision, either a
number or `{ "revision": N }`. An ack means **positioned**, not
intent-preserved: confirm the edited region through `/download` before
reporting success.

### `info` (server → client)

```json
{ "code": "…" }
```

A refusal or room event (permission, delete, kick, lock). The adapter logs the
code; the write is not retried automatically.

## REST endpoints used

| Endpoint | Use |
|---|---|
| `GET /<id>/download` | canonical text after a write; also mints a note-scoped cookie |
| `GET /<id>/info` | title, description, timestamps (read-only) |
| `GET /<id>/revision` | revision timestamps and lengths (no rev numbers) |
| `GET /me` | session identity: `{status, id, name}` |
| `POST /login` | form `email` + `password`, sets `connect.sid` |
| `POST /new` | create a note from a markdown body |

`/download` has no revision field. A revision is only learned from a `doc`
frame (join/rebuild), an `operation`, or an `ack`, which is why the adapter
treats revisions as socket-generation scoped.

## Consequences this client encodes

- Revisions are per note instance. When the last client leaves, the next room
  can start at rev 0; a held rev is worthless after a disconnect.
- The server applies client ops without validating the base length or revision.
  A wrong-base op is not safely rejected by the protocol, which is why the
  client gates writes on `base-rev` + `base-hash` and emits at most once.
- `/download` lags writes by roughly a second, so a poll timeout is
  `applied-but-unconfirmed`, not a failure.
- The server's `str` may carry extra trailing newlines. The client keeps them
  as a tail and pads wire ops with a final retain.
