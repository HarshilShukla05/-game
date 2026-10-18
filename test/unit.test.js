import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { parseCommand } from '../src/whatsapp.js';
import { patchClip, patchDiff } from '../src/vision.js';
import { extractLink, linkMismatches } from '../src/host.js';

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
