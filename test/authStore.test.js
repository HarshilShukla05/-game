// Round-trips the WhatsApp login through Redis. Runs when REDIS_TEST_URL is set
// (e.g. docker run -p 6390:6379 redis, REDIS_TEST_URL=redis://localhost:6390).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAuthStore } from '../src/authStore.js';

const url = process.env.REDIS_TEST_URL;
const skip = url ? false : 'set REDIS_TEST_URL to run';
const quietLog = { info() {}, warn() {}, error() {}, event() {} };

test('the Redis login store survives a reopen and can be cleared', { skip }, async () => {
  process.env.REDIS_URL = url;
  const cfg = { redisPrefix: `test:${Date.now()}:` };
  try {
    const a = await openAuthStore(cfg, quietLog);
    assert.equal(a.state.creds.registered, false);
    a.state.creds.registered = true;
    a.state.creds.me = { id: '15550000000:1@s.whatsapp.net' };
    await a.saveCreds();
    const key = Buffer.from([1, 2, 3, 250]);
    await a.state.keys.set({
      'pre-key': { 1: { public: key, private: key } },
      session: { 'abc.0': Buffer.from('session-bytes') },
      'app-state-sync-key': { K1: { keyData: key, timestamp: 5 } },
    });
    await a.state.keys.set({ session: { gone: Buffer.from('x') } });
    await a.state.keys.set({ session: { gone: null } });
    await a.close();

    const b = await openAuthStore(cfg, quietLog);
    assert.equal(b.state.creds.registered, true);
    assert.equal(b.state.creds.me.id, '15550000000:1@s.whatsapp.net');
    assert.ok(Buffer.isBuffer(b.state.creds.noiseKey.private), 'creds keep their Buffers');
    const pre = await b.state.keys.get('pre-key', ['1', '2']);
    assert.deepEqual([...pre['1'].public], [1, 2, 3, 250]);
    assert.equal(pre['2'], null);
    const sessions = await b.state.keys.get('session', ['abc.0', 'gone']);
    assert.equal(sessions['abc.0'].toString(), 'session-bytes');
    assert.equal(sessions.gone, null, 'deleted keys are gone');
    const sync = await b.state.keys.get('app-state-sync-key', ['K1']);
    assert.deepEqual([...sync.K1.keyData], [1, 2, 3, 250]);

    await b.clear();
    await b.close();
    const c = await openAuthStore(cfg, quietLog);
    assert.equal(c.state.creds.registered, false, 'cleared: a fresh login');
    assert.equal((await c.state.keys.get('session', ['abc.0']))['abc.0'], null);
    await c.clear();
    await c.close();
  } finally {
    delete process.env.REDIS_URL;
  }
});
