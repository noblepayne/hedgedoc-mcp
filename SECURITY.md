# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
("Security" → "Report a vulnerability"). Please do not open a public issue for
an exploitable problem.

Include the version, the transport, the note size, and a minimal reproduction.
A failing write should include the tool result (it carries the code and the
rev/hash the adapter saw), never the bot password or session cookie.

## Threat model

`hedgedoc-mcp` is a local stdio process. It does not listen on a port. The
security boundary is the bot account you give it and the notes that account can
edit.

- Use a dedicated bot account with edit rights only on the notes it needs.
- Do not run it with a human's primary login.
- Passwords are read from the environment and are never written to logs.
  Logs do carry note ids, revisions, error codes, the target URL and the
  account display name.
- `HEDGEDOC_COOKIE` is a bearer credential; treat it like a password.
- `set-note` (whole-document replace) is off unless
  `HEDGEDOC_ENABLE_SET_NOTE=true` and still requires `force` + `reason`.
- CAS protects document content, not credentials. Rotate the bot password if it
  leaks.

## Known limitations

- CAS is adapter-side. The wire protocol has no `base-hash`, so the gate
  compares against the local mirror. A mirror divergence is detected by the
  `/download` poll and a resync, not by the server.
- The server applies client operations without validating the base revision or
  length. The client compensates by emitting at most once and verifying; it
  cannot make a wrong-base op harmless at the protocol level.
- `search` with `regex? true` uses JavaScript's backtracking regex engine. A
  pathological pattern on a very long line can block the worker. Prefer
  substrings for untrusted input; the multi-note supervisor recycles a worker
  after 180 s.
- Notes over 100 KB can be read but not safely edited.
- Guest sessions can usually read but cannot join the OT room on 1.11/1.12, so
  guest writes are best-effort only.
- A server `info` refusal (permission, lock, kick) is logged but arrives as a
  socket event, not a synchronous verdict. The write is reported
  `applied-but-unconfirmed` unless `/download` shows the edit; it is never
  auto-retried.
