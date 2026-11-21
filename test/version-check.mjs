// version-check.mjs — one version, checked everywhere.
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const files = ['core.cljs', 'multi.cljs'];
let bad = false;
for (const f of files) {
  const src = readFileSync(new URL(`../src/hedgedoc_mcp/${f}`, import.meta.url), 'utf8');
  const m = src.match(/\(def server-version "([^"]+)"\)/);
  if (!m) { console.error(`${f}: no server-version`); bad = true; continue; }
  if (m[1] !== pkg.version) { console.error(`${f}: ${m[1]} != package.json ${pkg.version}`); bad = true; }
}
if (bad) process.exit(1);
console.log(`version check: ${pkg.version}`);
