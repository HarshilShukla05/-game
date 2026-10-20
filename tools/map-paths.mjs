// Usage: node tools/map-paths.mjs data/captures/<room>.ndjson out.png
// Top-down map of every kart's path from one captured room (network data only).
import fs from 'node:fs';
import { PNG } from 'pngjs';
import { decodeFrame } from '../src/photon.js';
import { gameEvents } from '../src/smashkarts.js';
const [file, out] = process.argv.slice(2);
const frames = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
const names = {}; const ev = [];
for (const f of frames) {
  if (!f.b64) continue;
  const m = decodeFrame(Buffer.from(f.b64, 'base64'));
  if (m.type === 'response' && m.code === 226 && m.params[249]) for (const [a, p] of Object.entries(m.params[249])) if (p?.[255]) names[a] = p[255];
  for (const e of gameEvents(m)) { ev.push(e); if (e.kind === 'join' && e.name) names[e.actor] = e.name; }
}
const W = 900, H = 900, SCALE = 2, CX = W / 2, CY = H / 2; // 2 px per unit, x right, z up
const png = new PNG({ width: W, height: H });
for (let i = 0; i < png.data.length; i += 4) png.data.set([24, 26, 33, 255], i);
const px = (x, z) => [Math.round(CX + x * SCALE), Math.round(CY - z * SCALE)];
const dot = (x, y, c, r = 1) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) png.data.set([...c, 255], (Y * W + X) * 4); } };
const line = (a, b, c) => { const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1); for (let k = 0; k <= n; k++) dot(Math.round(a[0] + (b[0] - a[0]) * k / n), Math.round(a[1] + (b[1] - a[1]) * k / n), c, 1); };
for (let u = -200; u <= 200; u += 50) { for (let v = -220; v <= 220; v++) { dot(...px(u, v), [45, 48, 58], 0); dot(...px(v, u), [45, 48, 58], 0); } }
const COLORS = { Cadensce2: [255, 196, 0], Bankai: [0, 190, 255], Papaji: [255, 80, 120], OverdriveRush: [160, 160, 160], THElemon: [120, 230, 120] };
const byView = {};
for (const e of ev) if (e.kind === 'kart') (byView[e.view] ??= []).push(e);
for (const [view, s] of Object.entries(byView)) {
  s.sort((a, b) => a.ts - b.ts);
  const c = COLORS[names[Math.floor(view / 1000)]] ?? [255, 255, 255];
  for (let i = 1; i < s.length; i++) if (Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z) < 30) line(px(s[i - 1].x, s[i - 1].z), px(s[i].x, s[i].z), c);
  const last = s.at(-1); const [lx, ly] = px(last.x, last.z);
  for (let k = -6; k <= 6; k++) { dot(lx + k, ly + k, [255, 255, 255], 1); dot(lx + k, ly - k, [255, 255, 255], 1); } // end of a life
}
for (const e of ev) if (e.kind === 'rpc' && e.method === 8) { const [x, y] = px(e.args[1].x, e.args[1].z); for (let k = -4; k <= 4; k++) { dot(x + k, y - 4, [255, 60, 60], 0); dot(x + k, y + 4, [255, 60, 60], 0); dot(x - 4, y + k, [255, 60, 60], 0); dot(x + 4, y + k, [255, 60, 60], 0); } }
fs.writeFileSync(out, PNG.sync.write(png));
console.log('legend', Object.fromEntries(Object.entries(COLORS).filter(([n]) => Object.values(names).includes(n))));
