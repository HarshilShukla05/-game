import { loadRecording } from './replay.js';

// "@game", "@game 20", "@game 20 min" -> round length. Explicit means the
// asker named a length; a live room with another length is then replaced.
export function parseMinutes(args, timer) {
  const m = String(args ?? '').match(/\d+/);
  if (!m) return { minutes: timer.defaultMinutes, explicit: false };
  const minutes = Number(m[0]);
  if (!timer.options.includes(minutes)) return { error: `Round length can be ${timer.options.join(', ')} minutes.` };
  return { minutes, explicit: true };
}

// One room at a time. States: idle -> creating -> live -> idle.
//  - @game while live      -> same link again (and the room's TTL is extended),
//                             unless another round length was asked for
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
    this.minutes = null;
    this.createdAt = 0;
    this.inflight = null;
    this.inflightMinutes = null;
    this.ttlTimer = null;

    host.on('lost', (reason) => {
      if (this.state !== 'live') return;
      this.log.event('room_closed', { reason: `host lost: ${reason}`, livedMs: Date.now() - this.createdAt });
      this.#toIdle();
    });
  }

  async getLink(minutes = this.cfg.game.timer.defaultMinutes, explicit = false) {
    while (this.inflight) {
      if (!explicit || this.inflightMinutes === minutes) return this.inflight;
      await this.inflight.catch(() => {});
    }
    if (this.state === 'live' && this.host.isAlive()) {
      if (!explicit || this.minutes === minutes) {
        this.#armTtl();
        this.log.event('room_reused', { link: this.link, minutes: this.minutes });
        return { link: this.link, minutes: this.minutes, reused: true };
      }
      await this.close(`replaced by a ${minutes} min room`);
    }
    this.inflightMinutes = minutes;
    this.inflight = this.#create(minutes).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #create(minutes) {
    this.state = 'creating';
    try {
      const rec = await loadRecording(this.cfg.game.recordingFile);
      const attempts = Math.max(1, this.cfg.game.createAttempts);
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const t0 = Date.now();
        try {
          const link = await this.host.createRoom(rec, { minutes });
          this.state = 'live';
          this.link = link;
          this.minutes = minutes;
          this.createdAt = Date.now();
          this.#armTtl();
          this.log.event('room_created', { link, minutes, ms: Date.now() - t0, attempt });
          return { link, minutes, reused: false };
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
    this.minutes = null;
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
