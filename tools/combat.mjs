// Usage: node tools/combat.mjs data/captures/<room>.ndjson
// Smashes, damage and Nuke flight from one captured room.
import fs from 'node:fs';
import { decodeFrame } from '../src/photon.js';
import { gameEvents, yaw } from '../src/smashkarts.js';
const frames = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const names = {}; const ev = [];
for (const f of frames) {
  if (!f.b64) continue;
  const m = decodeFrame(Buffer.from(f.b64, 'base64'));
  if (m.type === 'response' && m.code === 226 && m.params[249]) for (const [a, p] of Object.entries(m.params[249])) if (p?.[255]) names[a] = p[255];
  for (const e of gameEvents(m)) { ev.push({ ...e, t: f.t }); if (e.kind === 'join' && e.name) names[e.actor] = e.name; }
}
const actorOf = (view) => Math.floor(view / 1000);
const nm = (a) => names[a] ?? `actor${a}`;
const t0 = ev[0].t;

// Damage: RPC 10 (partial) and 11 (direct, 210), sent by the victim's kart, often twice: dedupe by victim+seed+method.
const seen = new Set(); const dmg = [];
for (const e of ev) if (e.kind === 'rpc' && (e.method === 10 || e.method === 11)) {
  const [attacker, pos, dir, amount, weapon, seed] = e.args;
  const key = `${e.view}/${seed}/${e.method}`;
  if (seen.has(key)) continue; seen.add(key);
  dmg.push({ t: e.t, ts: e.ts, victim: actorOf(e.view), victimView: e.view, attacker, pos, dir, amount, weapon, seed, method: e.method });
}
// Deaths: a kart view removed; credited to the last damage on that view.
const deaths = [];
for (const e of ev) if (e.kind === 'remove' && e.view >= 1000) {
  const hits = dmg.filter((d) => d.victimView === e.view);
  const total = hits.reduce((s, d) => s + d.amount, 0);
  const last = hits.at(-1);
  deaths.push({ t: e.t, victim: actorOf(e.view), total, killer: last?.attacker, lastHitBefore: last ? ((e.t - last.t) / 1000).toFixed(1) : null });
}
console.log('--- deaths (kart removed)');
for (const d of deaths) console.log(`${((d.t - t0) / 1000).toFixed(1)}s ${nm(d.victim)} died, damage taken ${d.total}, last hit by ${d.killer === undefined ? '-' : nm(d.killer)} ${d.lastHitBefore ?? '-'}s before removal`);
const score = {};
for (const d of deaths) if (d.killer !== undefined && d.total >= 200) { (score[nm(d.killer)] ??= { smashes: 0, deaths: 0 }).smashes++; }
for (const d of deaths) if (d.total >= 200) (score[nm(d.victim)] ??= { smashes: 0, deaths: 0 }).deaths++;
console.log('--- smashes (deaths with >= 200 damage)'); console.log(score);
console.log('--- lethal hit still to be removed when the capture ended:', dmg.filter((d) => d.method === 11 && !deaths.some((x) => x.t > d.t && x.victim === d.victim)).map((d) => `${nm(d.attacker)} -> ${nm(d.victim)}`));

// Nuke flight: fire RPC 8 (seed in args[4]) matched with damage of the same seed.
const fires = ev.filter((e) => e.kind === 'rpc' && e.method === 8).map((e) => ({ t: e.t, ts: e.ts, shooter: actorOf(e.view), view: e.view, weapon: e.args[0], pos: e.args[1], seed: e.args[4] }));
const states = ev.filter((e) => e.kind === 'kart');
const stateAt = (view, ts) => states.filter((s) => s.view === view).reduce((a, b) => (!a || Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a), null);
console.log('--- shots', fires.length, 'by', fires.reduce((a, f) => ((a[nm(f.shooter)] = (a[nm(f.shooter)] || 0) + 1), a), {}));
const flights = [];
for (const f of fires) for (const d of dmg.filter((x) => x.seed === f.seed)) {
  const dx = d.pos.x - f.pos.x, dz = d.pos.z - f.pos.z, dist = Math.hypot(dx, dz), sec = (d.ts - f.ts) / 1000;
  const s = stateAt(f.view, f.ts); const h = s ? yaw(s) : null;
  const offAxis = h === null ? null : Math.acos(Math.max(-1, Math.min(1, (Math.sin(h) * dx + Math.cos(h) * dz) / dist))) * 180 / Math.PI;
  const dirAgree = Math.acos(Math.max(-1, Math.min(1, (d.dir.x * dx + d.dir.z * dz) / dist))) * 180 / Math.PI;
  flights.push({ dist, sec, offAxis, dirAgree, amount: d.amount, method: d.method });
  console.log(`${nm(f.shooter)} -> ${nm(d.victim)}: ${dist.toFixed(1)} units in ${sec.toFixed(2)} s (${(dist / sec).toFixed(0)} u/s), shot vs shooter heading ${offAxis?.toFixed(0)} deg, hit dir vs path ${dirAgree.toFixed(0)} deg, damage ${d.amount}${d.method === 11 ? ' direct' : ''}`);
}
const missed = fires.filter((f) => !dmg.some((d) => d.seed === f.seed)).length;
console.log(`--- ${fires.length - missed} of ${fires.length} shots hit someone`);
