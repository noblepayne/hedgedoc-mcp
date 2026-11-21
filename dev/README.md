# hedgedoc dev box (local, disposable)

Runs HedgeDoc 1.12 + PostgreSQL 18 on loopback so the E2E harness has a
disposable target that isn't production.

## Loop

```sh
podman-compose -f dev/compose.yml up -d
until curl -sf http://localhost:3000/status >/dev/null; do sleep 2; done
node dev/seed.mjs                      # prints show/empty/dup note IDs
HEDGEDOC_URL=http://localhost:3000 node test/e2e-convergence.mjs
podman-compose -f dev/compose.yml down -v     # wipe everything
```

## Notes

- Guest-open by design. Loopback-bound (`127.0.0.1:3000`), never exposed.
  Data is fixtures only.
- First boot pulls ~500MB of images; the database starts empty.
- The images are tagged, not digest-pinned; pin them for reproducible runs.
- If port 3000 collides locally, remap to `13000:3000` in compose.yml and set
  `HEDGEDOC_URL=http://localhost:13000`.
