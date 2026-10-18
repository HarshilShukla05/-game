// End-to-end check of record → replay → link against test/fixtures/fake-game.html,
// which mirrors the real game's JS surface and its slow, early-signalled load.
// Needs a display (run under xvfb-run on a headless box). Set CHROMIUM_PATH to
// use a specific Chromium binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Host, extractLink, linkMinutes, linkTeams } from '../src/host.js';
import { RoomManager } from '../src/roomManager.js';
import { addOptionSteps, startRecording } from '../src/recorder.js';
import { cropPng, patchClip } from '../src/vision.js';

const FIXTURE = pathToFileURL(path.resolve(import.meta.dirname, 'fixtures/fake-game.html')).href;
const LINK = 'https://smashkarts.io/link/?mode=67109640&wpns=256&room=in123456&arena=smashisland&mdfrs=0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quietLog = { info() {}, warn() {}, error() {}, event() {} };

function makeConfig(tmp, query) {
  return {
    browser: {
      profileDir: path.join(tmp, 'profile'),
      channel: '',
      executablePath: process.env.CHROMIUM_PATH || '',
      viewport: { width: 1280, height: 720 },
    },
    game: {
      url: `${FIXTURE}?${query}`,
      recordingFile: path.join(tmp, 'create.json'),
      expectLinkParams: { arena: 'smashisland', wpns: '256' },
      timer: { options: [3, 6, 10, 20], startMinutes: 3, defaultMinutes: 10, arrow: { x: 740, y: 150 } },
      teamsBox: { x: 330, y: 430, maxDiff: 8 },
      menuTimeoutMs: 30_000,
      menuSettleMs: 300,
      linkTimeoutMs: 5_000,
      createAttempts: 2,
      roomTtlMinutes: 120,
    },
    replay: { speed: 1, minGapMs: 200, maxGapMs: 2_000, visualCheck: true, strictVisual: true, minSimilarity: 0.8, visualThreshold: 30, visualTimeoutMs: 15_000, reclickMs: 3_000 },
    dataDir: tmp,
  };
}

const HUMAN_CLICKS = [
  [640, 400], // CREATE
  [400, 290], // NUKES
  [880, 290], // SMASH ISLAND
  [640, 540], // CREATE ROOM
  [640, 600], // COPY LINK (only appears after the "server" creates the room)
];

// A "human" waits for the real menu, clicks through once and the recording
// is finished the way calibrate.js does it (timer step inserted before Play).
async function recordHumanRun(tmp) {
  const cfg = makeConfig(tmp, 'load=1500&room=1000');
  const host = new Host(cfg, quietLog, { record: true });
  await host.loadMenu();
  const recording = startRecording(host, cfg.browser.viewport, quietLog);
  const copied = new Promise((resolve) => host.on('copy', resolve));
  await host.page.waitForFunction(() => window.__fake.screen === 'menu');
  for (const [x, y] of HUMAN_CLICKS) {
    if (x === 640 && y === 600) await host.page.waitForFunction(() => window.__fake.screen === 'lobby');
    await sleep(400);
    await host.page.mouse.click(x, y, { delay: 70 });
  }
  assert.equal(extractLink(await copied), LINK);
  await sleep(300);
  const rec = await recording.finish({ sampleLink: LINK });
  await host.close();
  assert.equal(rec.steps.length, 5);
  assert.ok(rec.steps.every((s) => s.type === 'click' && s.patch), 'every click has a screen patch');
  assert.ok(addOptionSteps(rec, { timerArrow: cfg.game.timer.arrow, teamsBox: cfg.game.teamsBox }), 'option steps added');
  assert.deepEqual(rec.steps.map((s) => s.type), ['click', 'click', 'click', 'timer', 'teams', 'click', 'click']);
  return rec;
}

const skip = process.env.DISPLAY ? false : 'needs a display (run under xvfb-run)';

test('record a human run, then replay it on a slower load with round lengths', { skip, timeout: 180_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rec = await recordHumanRun(tmp);

  // Replay on a much slower load and slower room creation than recorded:
  // the visual check must wait instead of wasting clicks.
  const cfg = makeConfig(tmp, 'load=8000&room=4000');
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify(rec));
  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  const rooms = new RoomManager(host, cfg, quietLog);

  // Two friends send @game at the same time: one room, same link, default 10 min.
  const [a, b] = await Promise.all([rooms.getLink(), rooms.getLink()]);
  assert.equal(linkTeams(a.link), false);
  assert.equal(a.link, b.link);
  assert.equal(linkMinutes(a.link), 10);
  assert.equal(a.minutes, 10);
  let fake = await host.page.evaluate(() => window.__fake);
  assert.deepEqual({ screen: fake.screen, mode: fake.mode, map: fake.map, wasted: fake.wastedClicks },
    { screen: 'lobby', mode: 'nukes', map: 'smash', wasted: 0 });

  // A plain @game reuses the live room; "@game 10" too.
  const reused = { link: a.link, minutes: 10, teams: false, reused: true };
  assert.deepEqual(await rooms.getLink(), reused);
  assert.deepEqual(await rooms.getLink({ minutes: 10, teams: false, explicit: true }), reused);

  // "@game 20" asks for another length: a new room with 20 min rounds.
  const c = await rooms.getLink({ minutes: 20, teams: false, explicit: true });
  assert.equal(c.reused, false);
  assert.equal(linkMinutes(c.link), 20);

  // "@game 6 team": a new Team Battle room with 6 min rounds.
  const d = await rooms.getLink({ minutes: 6, teams: true, explicit: true });
  assert.deepEqual({ reused: d.reused, minutes: linkMinutes(d.link), teams: linkTeams(d.link) }, { reused: false, minutes: 6, teams: true });
  fake = await host.page.evaluate(() => window.__fake);
  assert.equal(fake.wastedClicks, 0);
});

test('a known popup over the menu is closed and the room still gets made', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rec = await recordHumanRun(tmp);

  const cfg = makeConfig(tmp, 'load=2000&room=1000&popup=1');
  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  await host.loadMenu();
  await host.page.waitForFunction(() => window.__fake.screen === 'menu' && window.__fake.popup);
  // Learn the popup's close button from the screen, as was done for the real promo.
  const x = 950;
  const y = 130;
  rec.popups = [{ name: 'promo', x, y, patch: cropPng(await host.page.screenshot(), patchClip(x, y, cfg.browser.viewport)).toString('base64') }];
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify(rec));

  const rooms = new RoomManager(host, cfg, quietLog);
  const { link } = await rooms.getLink();
  assert.equal(linkMinutes(link), 10);
  const fake = await host.page.evaluate(() => window.__fake);
  assert.deepEqual({ popup: fake.popup, screen: fake.screen, wasted: fake.wastedClicks }, { popup: false, screen: 'lobby', wasted: 0 });
});

test('a room with the wrong settings is rejected, not posted', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = makeConfig(tmp, 'load=1000&room=500');
  cfg.game.createAttempts = 1;
  cfg.game.timer.defaultMinutes = 3; // hand-made recording without a timer step
  cfg.replay.visualCheck = false;
  // Skips the NUKES button: the game still creates a room and copies a link,
  // but with all weapons on.
  const clicks = [[640, 400], [880, 290], [640, 540], [640, 600]];
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify({
    viewport: cfg.browser.viewport,
    steps: clicks.map(([x, y], i) => ({ type: 'click', x, y, holdMs: 60, waitBeforeMs: i === 3 ? 2_000 : 300 })),
  }));

  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  const rooms = new RoomManager(host, cfg, quietLog);
  await host.loadMenu();
  await host.page.waitForFunction(() => window.__fake.screen === 'menu');
  await assert.rejects(rooms.getLink(), /wrong settings: wpns=4095 \(expected 256\)/);
  assert.equal(rooms.state, 'idle');
});

test('a recording that never reaches the copy button fails cleanly with a screenshot', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = makeConfig(tmp, 'load=1000&room=500');
  cfg.game.timer.defaultMinutes = 3; // hand-made recording without a timer step
  cfg.game.linkTimeoutMs = 1_500;
  cfg.replay.visualTimeoutMs = 1_000;
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify({
    viewport: cfg.browser.viewport,
    steps: [{ type: 'click', x: 20, y: 20, holdMs: 60, waitBeforeMs: 0 }],
  }));

  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  const rooms = new RoomManager(host, cfg, quietLog);
  await assert.rejects(rooms.getLink(), (err) => {
    assert.match(err.message, /never copied an invite link/);
    assert.ok(err.screenshot && fs.existsSync(err.screenshot), 'failure screenshot saved');
    return true;
  });
  assert.equal(rooms.state, 'idle');
});

test('an unknown nag popup is closed by its close button before the first click', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rec = await recordHumanRun(tmp);
  const cfg = makeConfig(tmp, 'load=2000&room=1000&popup=1');
  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  await host.loadMenu();
  await host.page.waitForFunction(() => window.__fake.screen === 'menu' && window.__fake.popup);
  // Not a known popup: only the look of a close button is given.
  rec.popups = [];
  rec.closeButton = { name: 'any close button', patch: cropPng(await host.page.screenshot(), patchClip(950, 130, cfg.browser.viewport)).toString('base64') };
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify(rec));

  const { link } = await new RoomManager(host, cfg, quietLog).getLink();
  assert.equal(linkMinutes(link), 10);
  const fake = await host.page.evaluate(() => window.__fake);
  assert.deepEqual({ popup: fake.popup, screen: fake.screen, wasted: fake.wastedClicks }, { popup: false, screen: 'lobby', wasted: 0 });
});

test('@start closes the pause menu, starts the round, and knows when one runs', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rec = await recordHumanRun(tmp);
  const cfg = makeConfig(tmp, 'load=1000&room=500&pause=1');
  const vp = cfg.browser.viewport;
  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  const rooms = new RoomManager(host, cfg, quietLog);
  // No lobby snapshots yet: create the room, then learn them from the screen.
  rec.lobby = { overlays: [], roundStarted: { name: 'clock', x: 660, y: 35, patch: '' } };
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify(rec));
  await rooms.getLink();
  await host.page.waitForFunction(() => window.__fake.paused);
  const cut = async (x, y) => cropPng(await host.page.screenshot(), patchClip(x, y, vp)).toString('base64');
  const resume = { name: 'Resume', x: 980, y: 330, patch: await cut(980, 330) };
  // Learn the clock by drawing the round state for a moment, then restore the
  // paused lobby. (The Host closes extra tabs, so no second page.)
  await host.page.evaluate(() => { window.__fake.screen = 'round'; draw(); }); // eslint-disable-line no-undef
  const clock = { name: 'clock', x: 660, y: 35, patch: await cut(660, 35) };
  await host.page.evaluate(() => { window.__fake.screen = 'lobby'; draw(); }); // eslint-disable-line no-undef
  rec.lobby = { overlays: [resume], roundStarted: clock };
  fs.writeFileSync(cfg.game.recordingFile, JSON.stringify(rec));

  assert.equal(await rooms.startRound(), 'started');
  const fake = await host.page.evaluate(() => window.__fake);
  assert.deepEqual({ screen: fake.screen, paused: fake.paused }, { screen: 'round', paused: false });
  assert.equal(await rooms.startRound(), 'already running');
});
