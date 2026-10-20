import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseCommand } from '../src/whatsapp.js';
import { cropPng, patchClip, patchDiff, patchMatch, patchSimilarity } from '../src/vision.js';
import { extractLink, linkMinutes, linkMismatches, linkTeams, sharedArena, weaponMask } from '../src/host.js';
import { parseGameArgs, roomKey, weaponsText } from '../src/options.js';
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

// The real game's names (2.16.008), as in recordings/create.json.
const ARENAS = ['Random', 'Boneyard Basin', 'Graveyard', 'Graveyard CTF', 'Kartuga', 'Lava Pit', 'Lava Pit CTF', 'Skate City',
  'Skate Park', 'Sky Arena Dropzone', 'Sky Arena Pinball', 'Sky Arena Showdown', 'Sky Arena Temples', 'Sky Arena Tunnels',
  "Slick 'n Slide", 'Smash Fort', 'Smash Fort CTF', 'Smash Island', 'Snow Shrine', 'Snowpark', 'SnowparkCTF', 'Space Station',
  'Space Stations', 'Star Warp Station', "Steky's Speedway", 'The Battle Box', 'The Gravel Pit', 'The Old Graveyard',
  'The Sand Box', 'Toxic Towers'].map((name) => ({ name }));
const WEAPONS = [{ name: 'Rockets' }, { name: 'Invincibility' }, { name: 'Machine Gun', aliases: ['mg'] }, { name: 'Mines' },
  { name: 'Fake Lootbox' }, { name: 'Nuke' }, { name: 'Bullets' }, { name: 'Cannons' }, { name: 'Lob-Grenuke' },
  { name: 'Spikys', aliases: ['spikes'] }, { name: 'Snowball Blaster' }, { name: 'Lob Sentry' }];
const CHOICES = { timer: TIMER, arenas: ARENAS, weapons: WEAPONS, defaults: { arena: 'Smash Island', weapons: ['Nuke'] } };
const ask = (text) => parseGameArgs(text, CHOICES);
const room = (minutes, teams, arena, weapons, explicit = true) => ({ minutes, teams, arena, weapons, explicit });

test('parseGameArgs: default, lengths, team flag and bad input', () => {
  assert.deepEqual(ask(''), room(10, false, 'Smash Island', ['Nuke'], false));
  assert.deepEqual(ask('20'), room(20, false, 'Smash Island', ['Nuke']));
  assert.deepEqual(ask('6 min'), room(6, false, 'Smash Island', ['Nuke']));
  assert.deepEqual(ask('20min'), room(20, false, 'Smash Island', ['Nuke']));
  assert.deepEqual(ask('team'), room(10, true, 'Smash Island', ['Nuke']));
  assert.deepEqual(ask('20 Teams'), room(20, true, 'Smash Island', ['Nuke']));
  assert.deepEqual(ask('teams 3'), room(3, true, 'Smash Island', ['Nuke']));
  assert.match(ask('15 team').error, /3, 6, 10, 20 minutes/);
  assert.match(ask('3 20').error, /one round length/);
  assert.match(ask('steam').error, /don't know "steam"/);
  assert.deepEqual(ask('help'), { help: true });
  assert.deepEqual(ask('maps'), { help: true });
});

test('parseGameArgs: arenas by full name, unique part or squashed', () => {
  const arena = (text) => ask(text).arena;
  assert.equal(arena('sky arena tunnels'), 'Sky Arena Tunnels');
  assert.equal(arena('SkyArenaTunnels'), 'Sky Arena Tunnels');
  assert.equal(arena('tunnels'), 'Sky Arena Tunnels');
  assert.equal(arena('island'), 'Smash Island');
  assert.equal(arena('graveyard'), 'Graveyard', 'a full name beats a part of another');
  assert.equal(arena('old graveyard'), 'The Old Graveyard');
  assert.equal(arena('snowpark ctf'), 'SnowparkCTF');
  assert.equal(arena('slick n slide'), "Slick 'n Slide");
  assert.equal(arena('stekys speedway'), "Steky's Speedway");
  assert.equal(arena('space stations'), 'Space Stations');
  assert.equal(arena('space station'), 'Space Station');
  assert.equal(arena('random'), 'Random');
  assert.match(ask('station').error, /don't know "station"/, 'a part two arenas share is not a name');
  assert.match(ask('kartuga lava pit').error, /one arena/);
});

test('parseGameArgs: weapons, "all", and everything together', () => {
  const weapons = (text) => ask(text).weapons;
  assert.deepEqual(weapons('nukes'), ['Nuke']);
  assert.deepEqual(weapons('mines nuke'), ['Mines', 'Nuke'], 'popup order');
  assert.deepEqual(weapons('machine gun'), ['Machine Gun']);
  assert.deepEqual(weapons('mg, rocket'), ['Rockets', 'Machine Gun']);
  assert.deepEqual(weapons('lob-grenuke spikes'), ['Lob-Grenuke', 'Spikys']);
  assert.deepEqual(weapons('all'), WEAPONS.map((w) => w.name));
  assert.deepEqual(weapons('all weapons'), WEAPONS.map((w) => w.name));
  assert.match(ask('lob').error, /don't know "lob"/);
  assert.deepEqual(ask('20 team tunnels nuke + mines'), room(20, true, 'Sky Arena Tunnels', ['Mines', 'Nuke']));
  assert.deepEqual(ask('Toxic Towers all 3'), room(3, false, 'Toxic Towers', WEAPONS.map((w) => w.name)));
  assert.deepEqual(ask('on smash fort with rockets only'), room(10, false, 'Smash Fort', ['Rockets']));
});

test('weapon text and room keys', () => {
  assert.equal(weaponsText(['Nuke'], WEAPONS), 'Nuke only');
  assert.equal(weaponsText(['Mines', 'Nuke'], WEAPONS), 'Mines + Nuke only');
  assert.equal(weaponsText(WEAPONS.map((w) => w.name), WEAPONS), 'All weapons');
  assert.notEqual(roomKey(ask('tunnels')), roomKey(ask('')));
  assert.equal(roomKey(ask('nuke 10 island')), roomKey(ask('')));
});

test('the share message and the wpns mask', () => {
  assert.equal(sharedArena(SHARE), 'Smash Island');
  assert.equal(sharedArena('Come play\nArena: Sky Arena - Tunnels \nRules: x'), 'Sky Arena - Tunnels');
  assert.equal(sharedArena('no arena'), null);
  const tiles = [{ name: 'Nuke', bit: 8 }, { name: 'Mines', bit: 3 }, { name: 'Odd', bit: null }];
  assert.equal(weaponMask(tiles, ['Nuke']), 256);
  assert.equal(weaponMask(tiles, ['Nuke', 'Mines']), 264);
  assert.equal(weaponMask(tiles, ['Odd']), null);
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

test('withOptions expands the weapon and arena choices', () => {
  const tile = (name, x, extra = {}) => ({ name, x, y: 1, patch: name, ...extra });
  const rec = {
    viewport: { width: 1280, height: 720 },
    weapons: { allOn: tile('All ON', 50), tiles: [tile('Rockets', 10), tile('Mines', 20), tile('Nuke', 30)] },
    arenas: { scroll: { x: 640, y: 400, dy: 400 }, tiles: [tile('Random', 100, { view: 'top' }), tile('Toxic Towers', 200, { view: 'bottom' })] },
    steps: [{ type: 'click', x: 1, y: 1 }, { type: 'weapons' }, { type: 'arena' }, { type: 'click', x: 2, y: 2 }],
  };
  const plan = (o) => withOptions(rec, { minutes: 3, ...o }, TIMER).steps;
  const nukes = plan({ weapons: ['Nuke'], arena: 'Random' });
  assert.deepEqual(nukes.map((s) => s.x), [1, 30, 100, 2]);
  assert.equal(nukes[1].toggle, true, 'a weapon tile is checked to toggle');
  assert.deepEqual(nukes[2].scroll, { x: 640, y: 400, dy: -400 }, 'top-view tiles scroll up');
  const more = plan({ weapons: ['Nuke', 'Rockets'], arena: 'Toxic Towers' });
  assert.deepEqual(more.map((s) => s.x), [1, 10, 30, 200, 2], 'tiles in popup order');
  assert.deepEqual(more[3].scroll, { x: 640, y: 400, dy: 400 }, 'bottom-view tiles scroll down');
  assert.deepEqual(plan({ weapons: ['Rockets', 'Mines', 'Nuke'], arena: 'Random' }).map((s) => s.x), [1, 50, 100, 2], 'all: All ON');
  assert.throws(() => plan({ weapons: ['Laser'], arena: 'Random' }), /Unknown weapon/);
  assert.throws(() => plan({ weapons: [], arena: 'Random' }), /No weapons/);
  assert.throws(() => plan({ weapons: ['Nuke'], arena: 'Moon' }), /Unknown arena "Moon"/);
});
