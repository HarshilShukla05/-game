import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { pageHooks, inputRecorder } from './hooks.js';
import { replay, withTimer } from './replay.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The game copies a share message ("Come play Smash Karts\nRoom: in123\n
// https://smashkarts.io/link/?...&arena=smashisland&wpns=256 ..."), not a bare
// URL, so take the first URL in whatever it copied.
export function extractLink(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : null;
}

// Round length in minutes, from the link's `mode` bitfield: bits 8-15.
// Observed on the real game: 3 min -> 0x4000308, 10 min -> 0x4000A08.
export function linkMinutes(link) {
  try {
    return (Number(new URL(link).searchParams.get('mode')) >> 8) & 0xff;
  } catch {
    return null;
  }
}

// The invite link encodes the room's settings. Returns what differs from
// `expected` (e.g. { arena: 'smashisland', wpns: '256' }); empty means it matches.
export function linkMismatches(link, expected = {}) {
  let params;
  try {
    params = new URL(link).searchParams;
  } catch {
    return ['link is not a valid URL'];
  }
  return Object.entries(expected)
    .filter(([key, value]) => params.get(key) !== String(value))
    .map(([key, value]) => `${key}=${params.get(key)} (expected ${value})`);
}

// Owns the real Chromium tab that hosts the room. All public operations are
// serialized through one queue, so a reset can never interleave with a create.
//
// Events: 'menuReady', 'copy' (text), 'input' (calibration), 'lost' (browser
// or page died; any live room is gone).
export class Host extends EventEmitter {
  #queue = Promise.resolve();
  #pending = 0;

  constructor(cfg, log, { record = false } = {}) {
    super();
    this.cfg = cfg;
    this.log = log;
    this.record = record;
    this.context = null;
    this.page = null;
    this.menuLoadedAt = 0;
    this.atMenu = false;
  }

  get busy() { return this.#pending > 0; }

  isAlive() { return Boolean(this.page && !this.page.isClosed() && !this.crashed); }

  #run(fn) {
    this.#pending++;
    const p = this.#queue.then(fn, fn).finally(() => { this.#pending--; });
    this.#queue = p.catch(() => {});
    return p;
  }

  async #launch() {
    if (this.isAlive()) return;
    await this.#closeContext();
    const b = this.cfg.browser;
    const { width, height } = b.viewport;
    this.context = await chromium.launchPersistentContext(b.profileDir, {
      headless: false,
      channel: b.channel || undefined,
      executablePath: b.executablePath || undefined,
      viewport: { width, height },
      deviceScaleFactor: 1,
      args: [
        '--mute-audio',
        '--ignore-gpu-blocklist',
        '--enable-unsafe-swiftshader', // software WebGL fallback when there is no GPU (e.g. under Xvfb)
        `--window-size=${width + 40},${height + 160}`,
      ],
    });
    await this.context.exposeBinding('__skBridge', (_source, e) => this.#onPageEvent(e));
    await this.context.addInitScript(pageHooks, { photonPort443: Boolean(this.cfg.game.photonPort443) });
    if (this.record) await this.context.addInitScript(inputRecorder);

    const context = this.context;
    context.on('close', () => {
      if (this.context !== context) return;
      this.context = null;
      this.page = null;
      this.#markLost('browser closed');
    });
    this.page = context.pages()[0] ?? (await context.newPage());
    for (const p of context.pages()) if (p !== this.page) await p.close().catch(() => {});
    // Ads sometimes open new tabs; keep the single game tab focused.
    context.on('page', (p) => { if (p !== this.page) p.close().catch(() => {}); });
    this.crashed = false;
    if (this.record) this.#logGameConsole(this.page);
    this.page.on('crash', () => { this.crashed = true; this.#markLost('page crashed'); });
  }

  // Calibration only: keep the game's own console output (Photon connects,
  // room events) to find precise readiness and room signals later.
  #logGameConsole(page) {
    const file = path.join(this.cfg.dataDir, 'game-console.log');
    page.on('console', (m) => {
      fs.appendFile(file, `${new Date().toISOString()} ${m.type()} ${m.text()}\n`).catch(() => {});
    });
  }

  #markLost(reason) {
    this.atMenu = false;
    this.log.event('host_lost', { reason });
    this.emit('lost', reason);
  }

  #onPageEvent(e) {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'menuReady') this.emit('menuReady');
    else if (e.type === 'copy') this.emit('copy', String(e.text ?? '').trim(), e.via);
    else if (e.type === 'loadingState') this.log.event('loading_state', { value: e.value });
    else if (e.type === 'input') this.emit('input', e);
  }

  // Resolves true when `event` fires (and passes `filter`), false on timeout.
  #waitFor(event, timeoutMs, filter = () => true) {
    return new Promise((resolve) => {
      const onEvent = (...args) => {
        if (!filter(...args)) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off(event, onEvent); };
      this.on(event, onEvent);
    });
  }

  async #loadMenu() {
    await this.#launch();
    this.atMenu = false;
    const g = this.cfg.game;
    const t0 = Date.now();
    const ready = this.#waitFor('menuReady', g.menuTimeoutMs);
    await this.page.goto(g.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (await ready) {
      this.log.event('menu_ready', { ms: Date.now() - t0 });
    } else {
      this.log.warn(`No main-menu signal within ${g.menuTimeoutMs} ms; continuing anyway`);
    }
    await sleep(g.menuSettleMs);
    this.atMenu = true;
    this.menuLoadedAt = Date.now();
  }

  // (Re)loads the game to a fresh main menu. Leaves any room the tab is in.
  loadMenu() { return this.#run(() => this.#loadMenu()); }

  // Replays the "create room" recording from a fresh main menu and returns
  // the invite link the game copies. `minutes` sets the round length.
  createRoom(rec, { minutes } = {}) {
    const plan = withTimer(rec, minutes, this.cfg.game.timer);
    return this.#run(async () => {
      if (!this.isAlive() || !this.atMenu) await this.#loadMenu();
      this.atMenu = false;

      // A misclick that picks the wrong arena or weapons still yields a link,
      // so every link is checked against the expected settings before use.
      let link = null;
      let wrongSettings = null;
      const onCopy = (text) => {
        if (link || wrongSettings) return;
        const url = extractLink(text);
        if (!url) {
          this.log.warn(`Game copied text without a link: ${JSON.stringify(text)}`);
          return;
        }
        const bad = linkMismatches(url, this.cfg.game.expectLinkParams);
        if (minutes != null && linkMinutes(url) !== minutes) bad.push(`round=${linkMinutes(url)} min (expected ${minutes})`);
        if (bad.length) wrongSettings = `Room has the wrong settings: ${bad.join(', ')}`;
        else link = url;
      };
      this.on('copy', onCopy);
      try {
        const r = this.cfg.replay;
        const debugDir = r.debugShots ? path.join(this.cfg.dataDir, 'screens', `replay-${Date.now()}`) : undefined;
        if (debugDir) await fs.mkdir(debugDir, { recursive: true });
        await replay(this.page, plan, {
          ...r,
          debugDir,
          firstStepTimeoutMs: this.cfg.game.menuTimeoutMs,
          log: this.log,
          shouldStop: () => Boolean(link || wrongSettings),
        });
        if (!link && !wrongSettings) await this.#waitFor('copy', this.cfg.game.linkTimeoutMs, (t) => Boolean(extractLink(t)));
        if (wrongSettings) throw new Error(wrongSettings);
        if (!link) throw new Error('Replay finished but the game never copied an invite link');
        return link;
      } finally {
        this.off('copy', onCopy);
      }
    });
  }

  // The room host has to start each round; the lobby says "Press Space to start round".
  startRound() {
    return this.#run(async () => {
      if (!this.isAlive()) throw new Error('The game is not running');
      await this.page.keyboard.press('Space');
    });
  }

  async screenshot(name) {
    if (!this.isAlive()) return null;
    const dir = path.join(this.cfg.dataDir, 'screens');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    try {
      await this.page.screenshot({ path: file });
      return file;
    } catch (err) {
      this.log.warn('Screenshot failed:', err.message);
      return null;
    }
  }

  async #closeContext() {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  close() { return this.#closeContext(); }
}
