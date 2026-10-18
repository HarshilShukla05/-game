import fs from 'node:fs';
import { BufferJSON, initAuthCreds, proto, useMultiFileAuthState } from 'baileys';
import { createClient } from 'redis';

// Where the WhatsApp login lives. With REDIS_URL set (on Inframan, where the
// container's disk is lost on every restart) it is kept in Redis; otherwise
// in a local folder. Both return { state, saveCreds, clear, close }.
export async function openAuthStore(cfg, log) {
  const url = process.env.REDIS_URL;
  return url ? redisAuthStore(url, cfg.redisPrefix ?? 'smashbot:wa:', log) : folderAuthStore(cfg.authDir);
}

async function folderAuthStore(dir) {
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  return {
    state,
    saveCreds,
    clear: async () => fs.rmSync(dir, { recursive: true, force: true }),
    close: async () => {},
  };
}

// Same layout as Baileys' useMultiFileAuthState, one Redis key per file.
async function redisAuthStore(url, prefix, log) {
  const client = createClient({ url });
  client.on('error', (err) => log.warn('Redis:', err.message));
  await client.connect();

  const read = async (key) => {
    const raw = await client.get(prefix + key);
    return raw ? JSON.parse(raw, BufferJSON.reviver) : null;
  };
  const write = (key, value) => client.set(prefix + key, JSON.stringify(value, BufferJSON.replacer));

  const creds = (await read('creds')) || initAuthCreds();
  log.info(`WhatsApp login kept in Redis (${creds.registered ? 'linked' : 'not linked yet'})`);
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              tasks.push(value ? write(`${category}-${id}`, value) : client.del(prefix + `${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    clear: async () => {
      for await (const keys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
        if (keys.length) await client.del(keys);
      }
    },
    close: () => client.quit(),
  };
}
