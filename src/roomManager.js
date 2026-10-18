import { loadRecording } from './replay.js';

// "@game", "@game 20", "@game team", "@game 20 teams" -> room options.
// Explicit means the asker named an option; a live room that differs is then
// replaced, while a plain "@game" just gets the live room's link.
export function parseGameArgs(args, timer) {
  const text = String(args ?? '');
  const teams = /\bteams?\b/i.test(text);
  const m = text.match(/\d+/);
  const minutes = m ? Number(m[0]) : timer.defaultMinutes;
  if (m && !timer.options.includes(minutes)) return { error: `Round length can be ${timer.options.join(', ')} minutes.` };
  return { minutes, teams, explicit: Boolean(m) || teams };
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
    this.teams = false;
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

  // `req` = { minutes, teams, explicit } from parseGameArgs.
  async getLink(req = { minutes: this.cfg.game.timer.defaultMinutes, teams: false, explicit: false }) {
    const key = `${req.minutes}/${req.teams}`;
    while (this.inflight) {
      if (!req.explicit || this.inflightKey === key) return this.inflight;
      await this.inflight.catch(() => {});
    }
    if (this.state === 'live' && this.host.isAlive()) {
      if (!req.explicit || (this.minutes === req.minutes && this.teams === req.teams)) {
        this.#armTtl();
        this.log.event('room_reused', { link: this.link, minutes: this.minutes, teams: this.teams });
        return { link: this.link, minutes: this.minutes, teams: this.teams, reused: true };
      }
      await this.close(`replaced by a ${req.minutes} min${req.teams ? ' team' : ''} room`);
    }
    this.inflightKey = key;
    this.inflight = this.#create(req.minutes, req.teams).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async #create(minutes, teams) {
    this.state = 'creating';
    try {
      const rec = await loadRecording(this.cfg.game.recordingFile);
      const attempts = Math.max(1, this.cfg.game.createAttempts);
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const t0 = Date.now();
        try {
          const link = await this.host.createRoom(rec, { minutes, teams });
          this.state = 'live';
          this.link = link;
          this.minutes = minutes;
          this.teams = teams;
          this.createdAt = Date.now();
          this.#armTtl();
          this.log.event('room_created', { link, minutes, teams, ms: Date.now() - t0, attempt });
          return { link, minutes, teams, reused: false };
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
