import fs from 'node:fs';
import path from 'node:path';

// Saves every WebSocket frame the game sends or receives (Host option
// `capture`), one JSON line each, in a new file per game-server connection,
// i.e. per room. Training data for the AI teammate; see docs/NETWORK.md.
export function recordFrames(host, dir, log) {
  fs.mkdirSync(dir, { recursive: true });
  let out = null;
  host.on('net', (frames) => {
    for (const f of frames) {
      if (f.dir === 'open' && /\/game\//.test(f.url ?? '')) {
        out?.end();
        const file = path.join(dir, `${new Date(f.t).toISOString().replace(/[:.]/g, '-')}.ndjson`);
        out = fs.createWriteStream(file, { flags: 'a' });
        out.on('error', (err) => log.warn('Capture write failed:', err.message));
        log.event('capture_started', { file });
      }
      out?.write(JSON.stringify(f) + '\n');
    }
  });
}
