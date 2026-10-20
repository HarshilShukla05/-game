import { loadRecording } from './replay.js';
import { roomKey } from './options.js';

// One room at a time. States: idle -> creating -> live -> idle.
//  - @game while live      -> same link again (and the room's TTL is extended),
//                             unless other settings were asked for
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
    this.room = null; // { minutes, teams, arena, weapons } of the live room
    this.createdAt = 0;
    this.inflight = null;
    this.inflightKey = null;
    this.ttlTimer = null;

    host.on('lost', (reason) => {
      if (this.state !== 'live') return;
      this.log.event('room_closed', { reason: `host lost: ${reason}`, livedMs: Date.now() - this.createdAt });
      this.#toIdle();
    });
  }

  // `req` = { minutes, teams, arena, weapons, explicit } from parseGameArgs;
  // left-out settings take the defaults.
  async getLink(req = {}) {
    const g = this.cfg.game;
    const want = {
      minutes: req.minutes ?? g.timer.defaultMinutes,
      teams: req.teams ?? false,
      arena: req.arena ?? g.defaults.arena,
      weapons: req.weapons ?? g.defaults.weapons,
    };
    const key = roomKey(want);
    while (this.inflight) {
      if (!req.explicit || this.inflightKey === key) return this.inflight;
      await this.inflight.catch(() => {});
    }
    if (this.state === 'live' && this.host.isAlive()) {
      if (!req.explicit || roomKey(this.room) === key) {
        this.#armTtl();
        this.log.event('room_reused', { link: this.link, ...this.room });
        return { link: this.link, ...this.room, reused: true };
      }
      await this.close(`replaced by a room with ${key}`);
    }
    this.inflightKey = key;
    this.inflight = this.#create(want).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #create(room) {
    this.state = 'creating';
    try {
      const rec = await loadRecording(this.cfg.game.recordingFile);
      const attempts = Math.max(1, this.cfg.game.createAttempts);
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const t0 = Date.now();
        try {
          const link = await this.host.createRoom(rec, room);
          this.state = 'live';
          this.link = link;
          this.room = room;
          this.createdAt = Date.now();
          this.#armTtl();
          this.log.event('room_created', { link, ...room, ms: Date.now() - t0, attempt });
          return { link, ...room, reused: false };
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
    this.room = null;
  }

  // The bot was dropped from its room (e.g. kicked): forget the dead link.
  markLost(reason) {
    if (this.state !== 'live') return;
    this.log.event('room_closed', { reason, livedMs: Date.now() - this.createdAt });
    this.#toIdle();
  }

  // Returns 'started' or 'already running'.
  async startRound() {
    if (this.state !== 'live') throw new Error('No room is live');
    const result = await this.host.startRound(await loadRecording(this.cfg.game.recordingFile));
    this.#armTtl();
    this.log.event('round_started', { link: this.link, result });
    return result;
  }

  async close(reason) {
    if (this.state !== 'live') return;
    this.log.event('room_closed', { reason, livedMs: Date.now() - this.createdAt });
    this.#toIdle();
    // Reloading leaves the room and leaves a warm menu for the next @game.
    await this.host.loadMenu().catch((err) => this.log.error('Reload after close failed:', err.message));
  }
}
