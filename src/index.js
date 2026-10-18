import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Host } from './host.js';
import { RoomManager } from './roomManager.js';
import { WhatsApp } from './whatsapp.js';

const WATCHDOG_MS = 60_000;

const cfg = loadConfig();
const log = createLogger(cfg.dataDir);
const host = new Host(cfg, log);
const rooms = new RoomManager(host, cfg, log);
const wa = new WhatsApp(cfg, log);

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

wa.on('command', async ({ name, jid, msg, sender }) => {
  log.event('command', { name, jid, sender });
  if (name === 'start') return startRound(jid, msg);
  await wa.react(jid, msg.key, '⏳');
  try {
    const { link } = await rooms.getLink();
    await wa.reply(jid, cfg.whatsapp.replyTemplate.replace('{link}', link), msg);
    await wa.react(jid, msg.key, '✅');
  } catch (err) {
    log.error('Room creation failed:', err.message);
    await wa.react(jid, msg.key, '❌');
    try {
      if (cfg.whatsapp.sendFailureScreenshot && err.screenshot) {
        await wa.sendImage(jid, err.screenshot, `${cfg.whatsapp.failureText}\n(${err.message})`, msg);
      } else {
        await wa.reply(jid, cfg.whatsapp.failureText, msg);
      }
    } catch (sendErr) {
      log.error('Could not report the failure to the group:', sendErr.message);
    }
  }
});

// The room host has to start every round, and the bot is the host.
async function startRound(jid, msg) {
  try {
    await rooms.startRound();
    await wa.react(jid, msg.key, '🏁');
  } catch (err) {
    log.error('Start failed:', err.message);
    await wa.reply(jid, rooms.state === 'live' ? `⚠️ Couldn't start the round: ${err.message}` : `No room yet. Send ${cfg.whatsapp.trigger} first.`, msg)
      .catch((sendErr) => log.error('Could not report the failure to the group:', sendErr.message));
  }
}

wa.on('fatal', () => shutdown(1));

// Keeps a warm main menu so @game only costs the menu clicks: reloads after a
// crash, and refreshes a long-idle tab (WebGL pages leak memory over hours).
function warmUp() {
  if (rooms.state !== 'idle' || host.busy) return;
  const stale = Date.now() - host.menuLoadedAt > cfg.game.menuRefreshMinutes * 60_000;
  if (host.isAlive() && host.atMenu && !stale) return;
  host.loadMenu().catch((err) => log.error('Warm-up failed:', err.message));
}

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down');
  await host.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

log.info('Starting Smash Karts bot');
warmUp();
setInterval(warmUp, WATCHDOG_MS);
await wa.start();
