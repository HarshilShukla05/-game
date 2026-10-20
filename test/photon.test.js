// Decodes frames captured from the real game (2.16.008) on 2026-10-20.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decodeFrame } from '../src/photon.js';
import { decodeKartState, gameEvents, yaw } from '../src/smashkarts.js';

const FRAMES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/photon-frames.json'), 'utf8'));
const frame = (name) => decodeFrame(Buffer.from(FRAMES[name], 'base64'));
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('decodeFrame reads every message type the game uses', () => {
  assert.deepEqual(frame('ping').type, 'internalRequest');
  const join = frame('joinResponse');
  assert.deepEqual([join.type, join.code, join.returnCode], ['response', 226, 0]);
  assert.equal(join.params[248].gl, 'Smash Island', 'room properties: arena');
  assert.equal(join.params[248].wm, 8547820, 'room properties: weapon mask');
  const props = frame('setProperties');
  assert.deepEqual([props.type, props.code], ['request', 252]);
  assert.throws(() => decodeFrame(Buffer.from([0x00, 0x01])), /not a Photon frame/);
  assert.throws(() => decodeFrame(Buffer.from(FRAMES.kartState, 'base64').subarray(0, 20)), /ends early/);
});

test('a kart state: position, heading and velocity', () => {
  const [kart] = gameEvents(frame('kartState'));
  assert.equal(kart.kind, 'kart');
  assert.equal(kart.view, 1001, 'the first player\'s kart');
  // At spawn: (2.4, 0, -187.9), facing +x (the spawn rotation is 90 degrees).
  near(kart.x, 2.375);
  near(kart.y, -0.0625);
  near(yaw(kart), Math.PI / 2, 0.01);
  near(Math.hypot(kart.vx, kart.vz), 0, 0.01);
  assert.equal(decodeKartState([1, 2, 3]), null);
});

test('spawn, remove, RPCs and joins', () => {
  const [spawn] = gameEvents(frame('spawnKart'));
  assert.equal(spawn.prefab, 'pv');
  assert.equal(spawn.view, 1001);
  near(spawn.pos.x, 2.4);
  near(spawn.rot.w, 0.7071, 1e-3);
  assert.deepEqual(gameEvents(frame('removeKart')), [{ kind: 'remove', view: 1001, actor: 1 }]);
  const [fire] = gameEvents(frame('fireRpc'));
  assert.deepEqual([fire.kind, fire.view, fire.method, fire.args[1].$type], ['rpc', 1001, 8, 'Vector3']);
  const [hit] = gameEvents(frame('hitRpc'));
  assert.deepEqual([hit.method, hit.args[0], hit.args[3]], [11, 1000000, 200], 'hit by a bot for 200');
  const [join] = gameEvents(frame('playerJoined'));
  assert.deepEqual([join.kind, join.actor, join.actors], ['join', 2, [1, 2]]);
  assert.equal(typeof join.name, 'string');
  assert.deepEqual(gameEvents(frame('ping')), []);
});
