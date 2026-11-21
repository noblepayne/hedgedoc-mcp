import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
const base = (process.env.HEDGEDOC_URL || process.env.STAGE_URL || 'http://localhost:3000').replace(/\/$/, '');
const marker = `E2E-${randomUUID()}`;

function cookieFor(noteId) {
  return fetch(`${base}/${noteId}/download`, { redirect: 'manual' })
    .then(r => (r.headers.get('set-cookie') || '').split(';')[0]);
}
function connect(noteId, cookie) {
  return io(base, { path: '/socket.io/', query: { noteId }, transports: ['polling','websocket'],
    reconnection: false, extraHeaders: { Cookie: cookie } });
}
async function createNote(md) {
  const r = await fetch(`${base}/new`, { method:'POST', headers:{'Content-Type':'text/markdown'}, body:md, redirect:'manual' });
  const loc = r.headers.get('location') || '';
  const id = loc.split('/').pop().split(/[?#]/)[0];
  if (!id) throw new Error(`no note id from ${r.status}`);
  return id;
}
function fenceParity(s) { return (s.match(/```/g) || []).length % 2 === 0; }

const fixture = `---
tags: LUP
---
# dev E2E

## Picks

### [Pick: Seed](https://example.com/seed)
> seed pick

## News
+ bullet one

\`\`\`nix
{ pkgs }: { environment.systemPackages = with pkgs; [ hello ]; }
\`\`\`
`;
const noteId = await createNote(fixture);
console.log('note:', noteId, 'marker:', marker);

const c1 = await cookieFor(noteId);
const c2 = await cookieFor(noteId);
const H = connect(noteId, c1);
const B = connect(noteId, c2);

let Hforce=0, Bforce=0;
let Hdoc='', Bdoc='', Hrev=-1, Brev=-1;

H.on('doc', (d, ...rest) => {
  Hdoc = d.str || d.content || '';
  Hrev = (typeof d.revision === 'number') ? d.revision : (typeof d.rev === 'number' ? d.rev : Hrev);
  if (d.force) Hforce++;
});
B.on('doc', (d, ...rest) => {
  Bdoc = d.str || d.content || '';
  Brev = (typeof d.revision === 'number') ? d.revision : (typeof d.rev === 'number' ? d.rev : Brev);
  if (d.force) Bforce++;
});
H.on('ack', (d, ...rest) => { const r = (typeof d === 'number') ? d : (d && d.revision); if (typeof r === 'number') Hrev = r; console.log('H ACK:', JSON.stringify(d), '-> Hrev', Hrev); });
B.on('ack', (d, ...rest) => { const r = (typeof d === 'number') ? d : (d && d.revision); if (typeof r === 'number') Brev = r; console.log('B ACK:', JSON.stringify(d), '-> Brev', Brev); });

await new Promise((res,rej)=>{ let n=0; const t=setInterval(()=>{ if(H.connected && B.connected){clearInterval(t);res();} if(++n>100){clearInterval(t);rej(new Error('connect timeout'));} },100); });
await new Promise((res)=>{ let n=0; const t=setInterval(()=>{ if(Hdoc.length>0 && Bdoc.length>0){clearInterval(t);res();} if(++n>100){clearInterval(t);res();} },100); });
console.log('both connected, Hrev', Hrev, 'Brev', Brev, 'Hlen', Hdoc.length);
await new Promise(r=>setTimeout(r,500));

// Step 1: Human inserts "hello-world\n" at line 4 (sequential)
const original = Hdoc.split('\n');
const targetLine = 4;
const before = original.slice(0, targetLine).join('\n') + '\n';
const off = before.length;
const humanText = 'hello-world\n';
const docLen = Hdoc.length;
console.log('Step1: human insert offset:', off, 'docLen:', docLen, 'rev:', Hrev);

H.emit('operation', Hrev, [off, humanText, docLen - off], null);
console.log('human emitted');

// Wait for ack + doc broadcast
await new Promise(r=>setTimeout(r,1000));
console.log('After human: Hdoc len', Hdoc.length, 'hello-present (remote doc):', Hdoc.includes('hello-world'));

// Step 2: Bot appends marker (sequential, after human converged)
// Use /download to get current state for bot
const r2 = await fetch(`${base}/${noteId}/download`, { headers: { Cookie: c2 } });
const botDoc = await r2.text();
const picksIdx = botDoc.indexOf('## Picks');
const insertAt = picksIdx === -1 ? botDoc.length : botDoc.indexOf('\n', picksIdx) + 1;
if (Brev < Hrev) Brev = Hrev;
console.log('Step2: bot append at', insertAt, 'rev:', Brev, 'docLen:', botDoc.length);

B.emit('operation', Brev, [insertAt, `+ [Pick: ${marker}](https://example.com/x)\n`, botDoc.length - insertAt], null);
console.log('bot emitted');

// Wait for convergence via download polling
const deadline = Date.now() + 8000;
let finalText = '';
while (Date.now() < deadline) {
  const r3 = await fetch(`${base}/${noteId}/download`, { headers: { Cookie: c1 } });
  finalText = await r3.text();
  if (finalText.includes('hello-world') && finalText.includes('+ [Pick:')) break;
  await new Promise(r=>setTimeout(r, 500));
}

console.log('Final: len', finalText.length);
console.log('Hforce:', Hforce, 'Bforce:', Bforce);
console.log('human-text-present:', finalText.includes('hello-world'));
console.log('marker-count:', (finalText.match(new RegExp(marker,'g'))||[]).length);
console.log('fence-parity:', fenceParity(finalText));

const ok = finalText.includes('hello-world') &&
  (finalText.match(new RegExp(marker,'g'))||[]).length === 1 &&
  Bforce === 0 && fenceParity(finalText);
H.disconnect(); B.disconnect();
if (!ok) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
process.exit(0);
JS
