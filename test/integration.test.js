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
import { Host, extractLink } from '../src/host.js';
import { RoomManager } from '../src/roomManager.js';
import { startRecording } from '../src/recorder.js';

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
      menuTimeoutMs: 30_000,
      menuSettleMs: 300,
      linkTimeoutMs: 5_000,
      createAttempts: 2,
      roomTtlMinutes: 120,
    },
    replay: { speed: 1, minGapMs: 200, maxGapMs: 2_000, visualCheck: true, strictVisual: true, visualThreshold: 30, visualTimeoutMs: 8_000 },
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

const skip = process.env.DISPLAY ? false : 'needs a display (run under xvfb-run)';

test('record a human run, then replay it on a slower load and get the link', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. Record: a "human" waits for the real menu, then clicks through.
  const recCfg = makeConfig(tmp, 'load=1500&room=1000');
  const recHost = new Host(recCfg, quietLog, { record: true });
  await recHost.loadMenu();
  const recording = startRecording(recHost, recCfg.browser.viewport, quietLog);
  const copied = new Promise((resolve) => recHost.on('copy', resolve));
  await recHost.page.waitForFunction(() => window.__fake.screen === 'menu');
  for (const [x, y] of HUMAN_CLICKS) {
    if (x === 640 && y === 600) await recHost.page.waitForFunction(() => window.__fake.screen === 'lobby');
    await sleep(400);
    await recHost.page.mouse.click(x, y, { delay: 70 });
  }
  assert.equal(extractLink(await copied), LINK);
  await sleep(300);
  const rec = await recording.finish({ sampleLink: LINK });
  await recHost.close();

  assert.equal(rec.steps.length, 5);
  assert.ok(rec.steps.every((s) => s.type === 'click' && s.patch), 'every click has a screen patch');
  fs.writeFileSync(recCfg.game.recordingFile, JSON.stringify(rec));

  // 2. Replay on a much slower load and slower room creation than recorded:
  //    the visual check must wait instead of wasting clicks.
  const cfg = makeConfig(tmp, 'load=8000&room=4000');
  const host = new Host(cfg, quietLog);
  t.after(() => host.close());
  const rooms = new RoomManager(host, cfg, quietLog);

  // Two friends send @game at the same time: one room, same link for both.
  const [a, b] = await Promise.all([rooms.getLink(), rooms.getLink()]);
  assert.equal(a.link, LINK);
  assert.equal(b.link, LINK);
  const fake = await host.page.evaluate(() => window.__fake);
  assert.deepEqual({ screen: fake.screen, mode: fake.mode, map: fake.map, wasted: fake.wastedClicks },
    { screen: 'lobby', mode: 'nukes', map: 'smash', wasted: 0 });

  // A later @game reuses the live room.
  const c = await rooms.getLink();
  assert.deepEqual(c, { link: LINK, reused: true });
});

test('a room with the wrong settings is rejected, not posted', { skip, timeout: 120_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skbot-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = makeConfig(tmp, 'load=1000&room=500');
  cfg.game.createAttempts = 1;
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
