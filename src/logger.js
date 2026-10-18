import fs from 'node:fs';
import path from 'node:path';

// Console logging plus an append-only events.jsonl. The events file is the
// raw history (commands, rooms, failures) that later analysis and the
// "learn from our matches" work will be built on, so every entry is one JSON line.
export function createLogger(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const stamp = () => new Date().toISOString();

  return {
    info: (...a) => console.log(stamp(), 'INFO ', ...a),
    warn: (...a) => console.warn(stamp(), 'WARN ', ...a),
    error: (...a) => console.error(stamp(), 'ERROR', ...a),
    event(type, data = {}) {
      const line = JSON.stringify({ ts: stamp(), type, ...data });
      fs.appendFile(eventsFile, line + '\n', (err) => {
        if (err) console.error(stamp(), 'ERROR', 'events.jsonl write failed:', err.message);
      });
      console.log(stamp(), 'EVENT', line);
    },
  };
}
