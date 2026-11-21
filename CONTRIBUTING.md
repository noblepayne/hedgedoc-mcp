# Contributing

## Gate

No GitHub Actions by design. Run the gate locally before sending a change:

```bash
npm install
npx squint compile
npm run test:pbt
node test/retry-safety.mjs
node test/remote-op-fold.mjs
node test/bin-launch.mjs
nix flake check                 # package + tests + launcher
./scripts/e2e.sh                # dev HedgeDoc + scenarios + live remote op
```

`nix flake check` checks the current system. Pass `--all-systems` only when
builders for the other systems are configured.

`./scripts/e2e.sh` needs podman and starts its own disposable HedgeDoc if
`127.0.0.1:3000/status` is not up. Set `HEDGEDOC_URL` to use an existing dev
instance instead. It registers `bot@dev.local`, so the target must allow open
registration.

## Rules of the write path

- Every mutation is CAS-gated on `base-rev` + `base-hash`.
- Never re-emit after an op leaves the socket. A poll timeout is
  `applied-but-unconfirmed`; the caller re-reads.
- A reconnect invalidates the revision. Wait for a `doc` frame; do not reuse an
  old base.
- Keep the pure core pure: `model.cljc` / `model_ops.cljc` take values and a
  clock argument; they do not touch sockets, files or `js/Date`.
- One writer per note. The multi-note supervisor spawns one core process per
  note; do not share revision state between notes.

## Style

- Squint/ClojureScript style in `src/`, ESM in `test/` and `bin/`.
- Small, isolated commits. Explain the failure mode in the message.
- Do not add agent co-author trailers.
- New behaviour needs a test that fails without it; write-path changes need a
  `test/retry-safety.mjs` or live-socket equivalent.

## Docs

The public docs are `README.md`, `docs/PROTOCOL.md`, `SECURITY.md` and
`AGENT_SCENARIOS.md`. Internal runbooks and deployment plans do not belong in
this repository.
