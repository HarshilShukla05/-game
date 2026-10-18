import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// Commands older than this (e.g. delivered after a reconnect) are ignored, so
// a backlog of old "@game" messages never spawns a room nobody is waiting for.
const MAX_COMMAND_AGE_S = 120;

export function parseCommand(text, trigger) {
  const t = String(text ?? '').replace(/＠/g, '@').trim().toLowerCase();
  const trig = trigger.toLowerCase();
  if (t === trig || t.startsWith(trig + ' ') || t.startsWith(trig + '\n')) return t.slice(trig.length).trim();
  return null;
}

function messageText(message) {
  const c = normalizeMessageContent(message);
  return c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || '';
}

const toSeconds = (ts) => (ts && typeof ts === 'object' ? Number(ts.toString()) : Number(ts));

// Emits 'command' { name, jid, msg, sender, args } for a trigger in allowed groups
// (name 'game' for whatsapp.trigger, 'start' for whatsapp.startTrigger),
// and 'fatal' when the session is logged out.
export class WhatsApp extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.cfg = cfg.whatsapp;
    this.log = log;
    this.sock = null;
    this.retries = 0;
    this.seen = new Set();
    this.knownGroups = new Set();
    this.startedAt = Math.floor(Date.now() / 1000);
  }

  async start() {
    await this.#connect();
  }

  async #connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // Fall back to the version bundled with Baileys.
    }
    const sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: 'warn' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    this.pairingRequested = false;
    this.registered = Boolean(state.creds.registered);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.#onConnection(sock, u));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        this.#onMessage(m).catch((err) => this.log.error('Message handler failed:', err));
      }
    });
  }

  #onConnection(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    // With a pairing number set (WA_PAIRING_NUMBER or whatsapp.pairingNumber),
    // link by typing a code on the bot phone instead of scanning a QR. Handy
    // when the only screen you have is that phone.
    const pairingNumber = String(process.env.WA_PAIRING_NUMBER || this.cfg.pairingNumber || '').replace(/\D/g, '');
    if (qr && pairingNumber && !this.registered) {
      if (!this.pairingRequested) {
        this.pairingRequested = true;
        sock.requestPairingCode(pairingNumber)
          .then((code) => {
            this.log.event('wa_pairing_code', { code });
            console.log(`\nOn the bot phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead" → enter ${code}\n`);
          })
          .catch((err) => this.log.error('Pairing code request failed:', err.message));
      }
    } else if (qr) {
      console.log('\nScan with the bot phone: WhatsApp → Linked devices → Link a device\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      this.retries = 0;
      this.registered = true;
      this.log.event('wa_connected');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut && this.registered) {
        this.log.error(`WhatsApp logged out. Delete "${this.cfg.authDir}" and restart to link again.`);
        this.emit('fatal', new Error('logged out'));
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        // A pairing that was never completed (code or QR not used in time)
        // leaves half-made credentials that WhatsApp rejects. Start over.
        this.log.warn('Linking was not completed in time; starting over with a new code');
        fs.rmSync(this.cfg.authDir, { recursive: true, force: true });
      }
      const delay = Math.min(60_000, 2_000 * 2 ** this.retries++);
      this.log.event('wa_disconnected', { code, retryInMs: delay });
      setTimeout(() => this.#connect().catch((err) => {
        this.log.error('Reconnect failed:', err.message);
        this.#onConnection(this.sock, { connection: 'close', lastDisconnect: { error: err } });
      }), delay);
    }
  }

  async #onMessage(m) {
    const jid = m.key?.remoteJid;
    if (!jid || !isJidGroup(jid) || !m.message) return;

    const id = m.key.id;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);

    const text = messageText(m.message);
    const triggers = { game: this.cfg.trigger, start: this.cfg.startTrigger };
    let name = null;
    let args = null;
    for (const [key, trigger] of Object.entries(triggers)) {
      if (!trigger) continue;
      args = parseCommand(text, trigger);
      if (args !== null) { name = key; break; }
    }
    if (name === null) return;
    if (toSeconds(m.messageTimestamp) < this.startedAt - MAX_COMMAND_AGE_S) return;

    const allowed = this.cfg.groupIds;
    if (allowed.length && !allowed.includes(jid)) return;
    if (!allowed.length && !this.knownGroups.has(jid)) {
      this.knownGroups.add(jid);
      const subject = await this.sock.groupMetadata(jid).then((g) => g.subject).catch(() => '?');
      this.log.warn(`Setup mode: command from group "${subject}" id=${jid}. Put this id in config.json whatsapp.groupIds to lock the bot to it.`);
    }

    const sender = m.key.participantAlt || m.key.participant || null;
    this.emit('command', { name, jid, msg: m, sender, args });
  }

  async #send(jid, content, opts) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sock.sendMessage(jid, content, opts);
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  reply(jid, text, quoted) {
    return this.#send(jid, { text }, quoted ? { quoted } : undefined);
  }

  sendImage(jid, file, caption, quoted) {
    return this.#send(jid, { image: { url: file }, caption }, quoted ? { quoted } : undefined);
  }

  // Reactions are a nice-to-have status signal; never let them fail a command.
  react(jid, key, emoji) {
    return this.#send(jid, { react: { text: emoji, key } }).catch((err) => this.log.warn('React failed:', err.message));
  }
}
