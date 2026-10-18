import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Host } from './host.js';
import { RoomManager, parseGameArgs } from './roomManager.js';
import { loadRecording } from './replay.js';
import { WhatsApp } from './whatsapp.js';

const WATCHDOG_MS = 60_000;

const cfg = loadConfig();
const log = createLogger(cfg.dataDir);
const host = new Host(cfg, log);
const rooms = new RoomManager(host, cfg, log);
const wa = new WhatsApp(cfg, log);

process.on('unhandledRejection', (err) => log.error('Unhandled rejection:', err));

wa.on('command', async ({ name, jid, msg, sender, args }) => {
  log.event('command', { name, jid, sender, args });
  if (name === 'start') return startRound(jid, msg);
  const ask = parseGameArgs(args, cfg.game.timer);
  if (ask.error) {
    await wa.reply(jid, `⚠️ ${ask.error} Example: ${cfg.whatsapp.trigger} 20 team`, msg).catch((err) => log.error('Reply failed:', err.message));
    return;
  }
  await wa.react(jid, msg.key, '⏳');
  try {
    const { link, minutes, teams } = await rooms.getLink(ask);
    const text = cfg.whatsapp.replyTemplate
      .replace('{link}', link)
      .replace('{minutes}', minutes)
      .replace('{format}', teams ? 'Team Battle' : 'Free For All');
    await wa.reply(jid, text, msg);
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
    const result = await rooms.startRound();
    if (result === 'already running') await wa.reply(jid, '🏁 A round is already running.', msg);
    else await wa.react(jid, msg.key, '🏁');
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

// While a room is live: keep the host's kart from being kicked as idle, and
// notice when the bot was dropped back to the main menu anyway.
async function roomWatch() {
  if (rooms.state !== 'live' || host.busy) return;
  try {
    if (await host.showsMainMenu(await loadRecording(cfg.game.recordingFile))) {
      rooms.markLost('dropped back to the main menu');
      return;
    }
    await host.nudge();
  } catch (err) {
    log.warn('Room watch failed:', err.message);
  }
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
setInterval(roomWatch, cfg.game.keepAliveSeconds * 1000);
await wa.start();
