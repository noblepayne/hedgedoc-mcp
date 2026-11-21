// Seeds the local dev box with LUP-shaped fixture notes via REST.
// Rerunnable: creates fresh notes each run, prints IDs for the E2E harness.
// Usage: HEDGEDOC_URL=http://localhost:3000 node dev/seed.mjs
const base = (process.env.HEDGEDOC_URL || process.env.STAGE_URL || 'http://localhost:3000').replace(/\/$/, '');

const showDoc = (n) => `---
tags: LUP
---

# LUP 9${n}9 (dev fixture ${n})

#### Show
LUP

#### Episode
9${n}9

#### GUID
dev-fixture-${n}

## Pre-Show
+ cold open check

## Feedback
> dev feedback ${n}

\`\`\`nix
{ pkgs }: { environment.systemPackages = with pkgs; [ hello ]; }
\`\`\`

## BOOSTS
### Ballot counter ${n}
+ 1,000 sats
> dev boost — ignore me

## Picks

### [Pick: DevPick${n}](https://example.com/dev${n})
> dev pick for convergence tests
`;

const emptyDoc = `# blank ${Date.now()}\n`;
const dupDoc = `## Picks\n+ first\n## picks\n+ second (dup heading, different case)\n`;

async function createNote(markdown) {
  const r = await fetch(`${base}/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/markdown' },
    body: markdown,
    redirect: 'manual',
  });
  if (r.status !== 302 && r.status !== 201 && r.status !== 200) {
    throw new Error(`POST /new -> ${r.status}`);
  }
  const loc = r.headers.get('location') || '';
  const id = loc.split('/').pop().split(/[?#]/)[0] || '(follow-redirects-manually)';
  return { status: r.status, id };
}

const notes = { show: showDoc(1), empty: emptyDoc, dup: dupDoc };
const ids = {};
for (const [k, md] of Object.entries(notes)) {
  ids[k] = await createNote(md);
  console.log(`${k}: ${ids[k].status} ${ids[k].id}`);
}
console.log(JSON.stringify({ base, ids }, null, 1));
