import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(file = process.env.BOT_CONFIG || path.join(ROOT, 'config.json')) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Every relative path in the config is resolved against the project root,
  // so the bot behaves the same whichever directory it is started from.
  const abs = (p) => (p ? path.resolve(ROOT, p) : p);
  cfg.whatsapp.authDir = abs(cfg.whatsapp.authDir);
  cfg.browser.profileDir = abs(cfg.browser.profileDir);
  cfg.browser.executablePath = cfg.browser.executablePath || process.env.CHROMIUM_PATH || '';
  cfg.game.recordingFile = abs(cfg.game.recordingFile);
  cfg.game.captureDir = abs(cfg.game.captureDir || process.env.SK_CAPTURE_DIR || '');
  // WA_GROUP_IDS (comma-separated) overrides the allowed groups.
  if (process.env.WA_GROUP_IDS !== undefined) cfg.whatsapp.groupIds = process.env.WA_GROUP_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  cfg.game.photonPort443 = Boolean(cfg.game.photonPort443) || process.env.SK_PHOTON_PORT_443 === '1';
  cfg.dataDir = abs(cfg.dataDir);
  return cfg;
}
