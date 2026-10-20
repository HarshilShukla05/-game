// RoomManager decisions against a fake host: when a room is reused, kept for
// a running round, or replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomManager } from '../src/roomManager.js';

const quietLog = { info() {}, warn() {}, error() {}, event() {} };

class FakeHost extends EventEmitter {
  created = [];
  isAlive() { return true; }
  async createRoom(_rec, room) { this.created.push(room); return `https://smashkarts.io/link/?room=${this.created.length}`; }
  async startRound() { return 'started'; }
  async loadMenu() {}
}

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const recordingFile = path.join(tmp, 'create.json');
  fs.writeFileSync(recordingFile, JSON.stringify({ viewport: { width: 1, height: 1 }, steps: [{ type: 'click', x: 0, y: 0 }] }));
  const cfg = {
    game: {
      recordingFile, createAttempts: 1, roomTtlMinutes: 120,
      timer: { options: [3, 6, 10, 20], startMinutes: 3, defaultMinutes: 10 },
      defaults: { arena: 'Smash Island', weapons: ['Nuke'] },
    },
  };
  const host = new FakeHost();
  return { host, rooms: new RoomManager(host, cfg, quietLog) };
}

const ask = (o) => ({ explicit: true, fresh: false, ...o });

test('a plain @game reuses the live room; other settings replace it', async (t) => {
  const { host, rooms } = setup(t);
  const a = await rooms.getLink();
  assert.deepEqual({ reused: a.reused, minutes: a.minutes, arena: a.arena, weapons: a.weapons }, { reused: false, minutes: 10, arena: 'Smash Island', weapons: ['Nuke'] });
  assert.equal((await rooms.getLink()).link, a.link);
  assert.equal((await rooms.getLink(ask({ minutes: 10, weapons: ['Nuke'] }))).reused, true, 'same settings named');
  const b = await rooms.getLink(ask({ arena: 'Kartuga' }));
  assert.deepEqual([b.reused, b.arena, host.created.length], [false, 'Kartuga', 2]);
});

test('while a round runs, other settings keep the room unless asked with "new"', async (t) => {
  const { host, rooms } = setup(t);
  const a = await rooms.getLink();
  assert.equal(await rooms.startRound(), 'started');
  assert.ok(rooms.roundRunning());
  const kept = await rooms.getLink(ask({ arena: 'Kartuga' }));
  assert.deepEqual([kept.link, kept.roundRunning, kept.arena, host.created.length], [a.link, true, 'Smash Island', 1]);
  const fresh = await rooms.getLink(ask({ arena: 'Kartuga', fresh: true }));
  assert.deepEqual([fresh.reused, fresh.arena, host.created.length, rooms.roundRunning()], [false, 'Kartuga', 2, false]);
  const again = await rooms.getLink(ask({ arena: 'Kartuga', fresh: true }));
  assert.equal(host.created.length, 3, '"new" makes a fresh room even with the same settings');
  assert.notEqual(again.link, fresh.link);
});

test('a dropped room-server connection closes the room', async (t) => {
  const { host, rooms } = setup(t);
  await rooms.getLink();
  host.emit('roomSocket', 'close', 1006);
  assert.equal(rooms.state, 'idle');
  const b = await rooms.getLink();
  assert.deepEqual([b.reused, host.created.length], [false, 2], 'the next @game makes a new room');
});
