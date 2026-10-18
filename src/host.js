import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { pageHooks, inputRecorder } from './hooks.js';
import { replay } from './replay.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isLink = (t) => /^https?:\/\/\S+$/i.test(String(t).trim());

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
  // the invite link the game copies.
  createRoom(rec) {
    return this.#run(async () => {
      if (!this.isAlive() || !this.atMenu) await this.#loadMenu();
      this.atMenu = false;

      let link = null;
      const onCopy = (text) => {
        if (!link && isLink(text)) link = text;
        else if (!link) this.log.warn(`Game copied something that is not a link: ${JSON.stringify(text)}`);
      };
      this.on('copy', onCopy);
      try {
        const r = this.cfg.replay;
        await replay(this.page, rec, {
          ...r,
          firstStepTimeoutMs: this.cfg.game.menuTimeoutMs,
          log: this.log,
          shouldStop: () => Boolean(link),
        });
        if (!link) await this.#waitFor('copy', this.cfg.game.linkTimeoutMs, isLink);
        if (!link) throw new Error('Replay finished but the game never copied an invite link');
        return link;
      } finally {
        this.off('copy', onCopy);
      }
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
