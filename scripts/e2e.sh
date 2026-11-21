#!/usr/bin/env bash
# End-to-end gate: dev HedgeDoc + the scenario suite, single-attempt writes.
# Requires: podman-compose, curl, node with `npm install` already run.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${HEDGEDOC_URL:-http://127.0.0.1:3000}"

if ! curl -sf "$BASE/status" >/dev/null 2>&1; then
  podman-compose -f dev/compose.yml up -d
fi
for _ in $(seq 1 60); do
  curl -sf "$BASE/status" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$BASE/status" >/dev/null || { echo "dev box did not come up" >&2; exit 1; }

# Idempotent bot account (dev only).
curl -sk -o /dev/null -X POST "$BASE/register" \
  -d 'email=bot@dev.local&password=devpassword123' || true

LOC=$(curl -s -D - -o /dev/null -X POST "$BASE/new" \
  -H 'Content-Type: text/markdown' --data-binary @test/fixtures/source.md \
  | awk 'tolower($1)=="location:"{print $2}' | tr -d '\r')
SRC="${LOC##*/}"
[ -n "$SRC" ] || { echo "could not create the source note" >&2; exit 1; }
echo "source note: $BASE/$SRC"

HEDGEDOC_URL="$BASE" \
HEDGEDOC_EMAIL=bot@dev.local \
HEDGEDOC_PASSWORD=devpassword123 \
SOURCE_NOTE="$SRC" \
WRITE_ATTEMPTS=1 \
  node test/agent-scenarios.mjs

echo "--- retry safety + remote-op fold ---"
node test/retry-safety.mjs
node test/remote-op-fold.mjs

echo "--- concurrent human operation (real core process) ---"
HEDGEDOC_URL="$BASE" \
HEDGEDOC_EMAIL=bot@dev.local \
HEDGEDOC_PASSWORD=devpassword123 \
  node test/remote-op-live.mjs

echo "--- multi-note supervisor ---"
DEFAULT_NOTE="$SRC" \
HEDGEDOC_URL="$BASE" \
HEDGEDOC_EMAIL=bot@dev.local \
HEDGEDOC_PASSWORD=devpassword123 \
  node test/multi-note.mjs
