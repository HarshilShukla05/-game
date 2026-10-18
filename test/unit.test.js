import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseCommand } from '../src/whatsapp.js';
import { cropPng, patchClip, patchDiff, patchMatch, patchSimilarity } from '../src/vision.js';
import { extractLink, linkMinutes, linkMismatches, linkTeams } from '../src/host.js';
import { parseGameArgs } from '../src/roomManager.js';
import { withOptions } from '../src/replay.js';

test('parseCommand matches the trigger only at the start', () => {
  assert.equal(parseCommand('@game', '@game'), '');
  assert.equal(parseCommand('  @GAME  ', '@game'), '');
  assert.equal(parseCommand('＠game', '@game'), '');
  assert.equal(parseCommand('@game now', '@game'), 'now');
  assert.equal(parseCommand('@gamer', '@game'), null);
  assert.equal(parseCommand('lets @game', '@game'), null);
  assert.equal(parseCommand(undefined, '@game'), null);
});

// Exactly what the real game copied on 2026-10-18.
const SHARE = 'Come play Smash Karts \nRoom: in358681 \nhttps://smashkarts.io/link/?mode=67109640&wpns=256&room=in358681&arena=smashisland&mdfrs=0 \nArena: Smash Island \nRules: Free For All - 3 Mins - Nukes Only';
const URL_ = 'https://smashkarts.io/link/?mode=67109640&wpns=256&room=in358681&arena=smashisland&mdfrs=0';

test('extractLink pulls the URL out of the game share message', () => {
  assert.equal(extractLink(SHARE), URL_);
  assert.equal(extractLink('https://x.y/z'), 'https://x.y/z');
  assert.equal(extractLink('Room: in358681'), null);
  assert.equal(extractLink(undefined), null);
});

test('linkMismatches checks the room settings encoded in the link', () => {
  const want = { arena: 'smashisland', wpns: '256' };
  assert.deepEqual(linkMismatches(URL_, want), []);
  assert.deepEqual(linkMismatches(URL_.replace('wpns=256', 'wpns=4095'), want), ['wpns=4095 (expected 256)']);
  assert.deepEqual(linkMismatches(URL_.replace('arena=smashisland', 'arena=lavapit'), want), ['arena=lavapit (expected smashisland)']);
  assert.deepEqual(linkMismatches('not a url', want), ['link is not a valid URL']);
  assert.deepEqual(linkMismatches(URL_, undefined), []);
});

test('patchClip stays inside the viewport', () => {
  const vp = { width: 1280, height: 720 };
  assert.deepEqual(patchClip(0, 0, vp), { x: 0, y: 0, width: 40, height: 40 });
  assert.deepEqual(patchClip(1280, 720, vp), { x: 1240, y: 680, width: 40, height: 40 });
  assert.deepEqual(patchClip(100, 100, vp), { x: 80, y: 80, width: 40, height: 40 });
});

const solid = (r, g, b) => {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([r, g, b, 255], i);
  return PNG.sync.write(png);
};

test('patchDiff is 0 for identical and large for different patches', () => {
  assert.equal(patchDiff(solid(10, 20, 30), solid(10, 20, 30)), 0);
  assert.equal(patchDiff(solid(0, 0, 0), solid(255, 255, 255)), 255);
  assert.equal(patchDiff(solid(100, 100, 100), solid(110, 90, 100)), 20 / 3);
});

// 40x40 patch: a light background with a dark square, shifted in brightness by `shift`.
const shape = (shift = 0, inverted = false) => {
  const png = new PNG({ width: 40, height: 40 });
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const inside = x >= 10 && x < 30 && y >= 10 && y < 30;
      const v = Math.max(0, Math.min(255, ((inside !== inverted) ? 40 : 220) + shift));
      png.data.set([v, v, v, 255], (y * 40 + x) * 4);
    }
  }
  return PNG.sync.write(png);
};

test('patchSimilarity ignores a pressed/hover tint but not a different shape', () => {
  assert.ok(patchSimilarity(shape(), shape(-35)) > 0.99, 'darker tint of the same button');
  assert.ok(patchSimilarity(shape(), shape(), true) > 0.99);
  assert.ok(patchSimilarity(shape(), shape(0, true)) < 0, 'inverted shape');
  const flat = new PNG({ width: 40, height: 40 });
  flat.data.fill(128);
  assert.equal(patchSimilarity(PNG.sync.write(flat), shape()), null, 'flat patch has no shape');
});

test('patchMatch falls back to colour difference for flat patches', () => {
  const opts = { minSimilarity: 0.8, maxDiff: 30 };
  assert.equal(patchMatch(shape(), shape(-35), opts).matched, true);
  assert.equal(patchMatch(shape(), shape(0, true), opts).matched, false);
  assert.equal(patchMatch(solid(100, 100, 100), solid(110, 90, 100), opts).matched, true);
  assert.equal(patchMatch(solid(0, 0, 0), solid(200, 200, 200), opts).matched, false);
});

test('cropPng cuts the same pixels a clipped screenshot would', () => {
  const full = shape();
  const cut = PNG.sync.read(cropPng(full, { x: 10, y: 10, width: 4, height: 4 }));
  assert.equal(cut.width, 4);
  assert.deepEqual([...cut.data.slice(0, 4)], [40, 40, 40, 255]);
  const edge = PNG.sync.read(cropPng(full, { x: 8, y: 8, width: 4, height: 4 }));
  assert.deepEqual([...edge.data.slice(0, 4)], [220, 220, 220, 255]);
});

test('linkMinutes reads the round length from the real game links', () => {
  // Both captured from the real game on 2026-10-18.
  assert.equal(linkMinutes(URL_), 3);
  assert.equal(linkMinutes('https://smashkarts.io/link/?mode=67111432&wpns=8547820&room=in346814&arena=skyarena-tunnels&mdfrs=0'), 10);
  assert.equal(linkMinutes('nope'), null);
});

const TIMER = { options: [3, 6, 10, 20], startMinutes: 3, defaultMinutes: 10, arrow: { x: 873, y: 250 } };

test('linkTeams reads Team Battle from the real game links', () => {
  // Captured from the real game on 2026-10-18: FFA 3 min and Team Battle 3 min.
  assert.equal(linkTeams(URL_), false);
  assert.equal(linkTeams('https://smashkarts.io/link/?mode=67109642&wpns=8547820&room=in356500&arena=skatepark&mdfrs=0'), true);
  assert.equal(linkMinutes('https://smashkarts.io/link/?mode=67109642&wpns=8547820&room=in356500&arena=skatepark&mdfrs=0'), 3);
});

test('parseGameArgs: default, lengths, team flag and bad input', () => {
  assert.deepEqual(parseGameArgs('', TIMER), { minutes: 10, teams: false, explicit: false });
  assert.deepEqual(parseGameArgs('20', TIMER), { minutes: 20, teams: false, explicit: true });
  assert.deepEqual(parseGameArgs('6 min', TIMER), { minutes: 6, teams: false, explicit: true });
  assert.deepEqual(parseGameArgs('team', TIMER), { minutes: 10, teams: true, explicit: true });
  assert.deepEqual(parseGameArgs('20 Teams', TIMER), { minutes: 20, teams: true, explicit: true });
  assert.deepEqual(parseGameArgs('teams 3', TIMER), { minutes: 3, teams: true, explicit: true });
  assert.deepEqual(parseGameArgs('steam', TIMER), { minutes: 10, teams: false, explicit: false });
  assert.match(parseGameArgs('15 team', TIMER).error, /3, 6, 10, 20 minutes/);
});

test('withOptions expands timer presses and the teams click', () => {
  const rec = {
    viewport: { width: 1280, height: 720 },
    timer: { x: 873, y: 250, patch: 'P' },
    teamsBox: { x: 493, y: 557, maxDiff: 8, patch: 'T' },
    steps: [{ type: 'click', x: 1, y: 1 }, { type: 'timer' }, { type: 'teams' }, { type: 'click', x: 2, y: 2 }],
  };
  const presses = (o) => withOptions(rec, o, TIMER).steps.filter((s) => s.x === 873).length;
  assert.equal(presses({ minutes: 3 }), 0);
  assert.equal(presses({ minutes: 6 }), 1);
  assert.equal(presses({ minutes: 10 }), 2);
  assert.equal(presses({ minutes: 20 }), 3);
  assert.equal(presses({}), 0);
  const team = withOptions(rec, { minutes: 3, teams: true }, TIMER).steps;
  assert.deepEqual(team.map((s) => s.x), [1, 493, 2]);
  assert.equal(team[1].maxDiff, 8);
  assert.deepEqual(withOptions(rec, { minutes: 3 }, TIMER).steps.map((s) => s.x), [1, 2]);
  assert.ok(!withOptions(rec, { minutes: 20, teams: true }, TIMER).steps.some((s) => s.type !== 'click'));
  assert.throws(() => withOptions(rec, { minutes: 15 }, TIMER), /3, 6, 10, 20/);
  const old = { viewport: rec.viewport, steps: [{ type: 'click', x: 1, y: 1 }] };
  assert.deepEqual(withOptions(old, { minutes: 3 }, TIMER).steps, old.steps);
  assert.throws(() => withOptions(old, { minutes: 10 }, TIMER), /round-timer/);
  assert.throws(() => withOptions(old, { minutes: 3, teams: true }, TIMER), /teams/);
});
