// Records one human run through the menus (Create → Nukes → Smash Island →
// create → copy invite link) and saves it as the recording the bot replays.
// Recording starts once the game reports its menu, and stops by itself when
// the game copies the invite link. Ctrl+C aborts without saving.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Host, isLink } from './host.js';
import { startRecording } from './recorder.js';

const cfg = loadConfig();
const log = createLogger(cfg.dataDir);
const host = new Host(cfg, log, { record: true });

process.on('SIGINT', async () => {
  log.info('Aborted, nothing saved');
  await host.close();
  process.exit(130);
});

log.info('Loading the game (this can take a minute or two)…');
await host.loadMenu();
const recording = startRecording(host, cfg.browser.viewport, log);

console.log(`
Recording. In the browser window:
  0. WAIT until the main menu is fully loaded and connected (no "Loading…")
  1. Create a private game
  2. Pick Nukes only and the Smash Island map
  3. Create the room, then press the button that copies the invite link
Click only what the bot should click. Recording stops by itself when the
link is copied. Ctrl+C aborts.
`);

const link = await new Promise((resolve) => {
  host.on('copy', (text) => {
    if (isLink(text)) resolve(text);
    else log.warn(`Copied text is not a link, still recording: ${JSON.stringify(text)}`);
  });
});

await new Promise((r) => setTimeout(r, 500)); // let the final pointerup arrive
const rec = await recording.finish({ sampleLink: link });
await fs.mkdir(path.dirname(cfg.game.recordingFile), { recursive: true });
await fs.writeFile(cfg.game.recordingFile, JSON.stringify(rec, null, 2) + '\n');
log.info(`Saved ${rec.steps.length} steps to ${cfg.game.recordingFile}. Link captured: ${link}`);
log.info(`Game console output saved to ${path.join(cfg.dataDir, 'game-console.log')}`);
log.info('Close the window. Then run "npm start".');
await host.close();
process.exit(0);
