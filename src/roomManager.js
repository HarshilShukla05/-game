import { loadRecording } from './replay.js';

// One room at a time. States: idle -> creating -> live -> idle.
//  - @game while live      -> same link again (and the room's TTL is extended)
//  - @game while creating  -> waits for the same creation (single-flight)
//  - TTL expiry            -> back to a fresh main menu, ready for the next @game
//  - host lost (crash)     -> idle; the next @game builds a new room
export class RoomManager {
  constructor(host, cfg, log) {
    this.host = host;
    this.cfg = cfg;
    this.log = log;
    this.state = 'idle';
    this.link = null;
    this.createdAt = 0;
    this.inflight = null;
    this.ttlTimer = null;

    host.on('lost', (reason) => {
      if (this.state !== 'live') return;
      this.log.event('room_closed', { reason: `host lost: ${reason}`, livedMs: Date.now() - this.createdAt });
      this.#toIdle();
    });
  }

  async getLink() {
    if (this.state === 'live' && this.host.isAlive()) {
      this.#armTtl();
      this.log.event('room_reused', { link: this.link });
      return { link: this.link, reused: true };
    }
    if (!this.inflight) {
      this.inflight = this.#create().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async #create() {
    this.state = 'creating';
    try {
      const rec = await loadRecording(this.cfg.game.recordingFile);
      const attempts = Math.max(1, this.cfg.game.createAttempts);
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const t0 = Date.now();
        try {
          const link = await this.host.createRoom(rec);
          this.state = 'live';
          this.link = link;
          this.createdAt = Date.now();
          this.#armTtl();
          this.log.event('room_created', { link, ms: Date.now() - t0, attempt });
          return { link, reused: false };
        } catch (err) {
          lastErr = err;
          const shot = await this.host.screenshot(`fail-${Date.now()}-attempt${attempt}`);
          this.log.event('room_failed', { attempt, error: err.message, screenshot: shot });
          lastErr.screenshot = shot;
        }
      }
      throw lastErr;
    } catch (err) {
      this.state = 'idle';
      throw err;
    }
  }

  #armTtl() {
    clearTimeout(this.ttlTimer);
    this.ttlTimer = setTimeout(() => this.close('ttl'), this.cfg.game.roomTtlMinutes * 60_000);
    this.ttlTimer.unref();
  }

  #toIdle() {
    clearTimeout(this.ttlTimer);
    this.state = 'idle';
    this.link = null;
  }

  async close(reason) {
    if (this.state !== 'live') return;
    this.log.event('room_closed', { reason, livedMs: Date.now() - this.createdAt });
    this.#toIdle();
    // Reloading leaves the room and leaves a warm menu for the next @game.
    await this.host.loadMenu().catch((err) => this.log.error('Reload after close failed:', err.message));
  }
}
