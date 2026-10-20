// What Smash Karts sends over Photon (PUN), on top of src/photon.js.
// Learned from captured rounds on 2.16.008; see docs/NETWORK.md.

// PUN's own event codes (inside RaiseEvent, param 244 = code, 245 = data).
export const PUN = {
  RPC: 200,
  SERIALIZE: 201, // unreliable state of networked objects, ~6 per second here
  INSTANTIATE: 202,
  DESTROY: 204,
  SERIALIZE_RELIABLE: 206,
};

const POS_SCALE = 16; // 1/16 unit steps
const VEL_SCALE = 512; // units/s

// A kart's 20-byte state from a SERIALIZE event: position as 3 uint16
// ((v - 32768) / 16), rotation as a quaternion of 4 int16 (/ 32767) in
// Unity's order (x, y, z, w), velocity as 3 int16 (/ 512 units/s).
// Little-endian.
export function decodeKartState(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 20) return null;
  const pos = (i) => (b.readUInt16LE(i) - 32768) / POS_SCALE;
  const rot = (i) => b.readInt16LE(i) / 32767;
  const vel = (i) => b.readInt16LE(i) / VEL_SCALE;
  return {
    x: pos(0), y: pos(2), z: pos(4),
    q: [rot(6), rot(8), rot(10), rot(12)],
    vx: vel(14), vy: vel(16), vz: vel(18),
  };
}

// Heading in radians around the vertical axis; forward is (sin, 0, cos).
// Checked against the velocity of fast karts in captured rounds.
export const yaw = (state) => 2 * Math.atan2(state.q[1], state.q[3]);

// Turns one decoded frame (from decodeFrame) into game events. A frame the
// game sent itself ("out") counts as much as one it received: both describe
// the room.
//   { kind: 'kart', view, actor, ts, ...state }    from SERIALIZE(_RELIABLE)
//   { kind: 'spawn', view, prefab, ts, pos, rot }  INSTANTIATE ("pv" a player's kart, "bv" a built-in bot)
//   { kind: 'remove', view }                       DESTROY (a kart smashed, or the round over)
//   { kind: 'rpc', view, method, ts, args }        RPC (methods are sent by index, not name)
//   { kind: 'join', actor, name, actors }          a player entered the room
//   { kind: 'leave', actor }
export function gameEvents(msg) {
  let code;
  let data;
  let actor;
  if (msg.type === 'event') {
    code = msg.code;
    data = msg.params[245];
    actor = msg.params[254];
  } else if (msg.type === 'request' && msg.code === 253) {
    code = msg.params[244];
    data = msg.params[245];
  } else {
    return [];
  }
  switch (code) {
    case PUN.SERIALIZE:
    case PUN.SERIALIZE_RELIABLE: {
      if (!Array.isArray(data)) return [];
      const ts = data[0];
      return data.slice(2).flatMap((view) => {
        const state = Array.isArray(view) && Array.isArray(view[3]) ? decodeKartState(view[3]) : null;
        return state ? [{ kind: 'kart', view: view[0], actor, ts, reliable: code === PUN.SERIALIZE_RELIABLE, ...state }] : [];
      });
    }
    case PUN.INSTANTIATE:
      return [{ kind: 'spawn', view: data[7], prefab: data[0], ts: data[6], pos: data[1], rot: data[2], actor }];
    case PUN.DESTROY:
      return [{ kind: 'remove', view: data[0], actor }];
    case PUN.RPC:
      return [{ kind: 'rpc', view: data[0], method: data[3] ?? data[5], ts: data[2], args: data[4] ?? [], actor }];
    case 255: { // Photon's own: join
      const props = msg.params[249] ?? {};
      return [{ kind: 'join', actor, name: props[255], actors: msg.params[252] }];
    }
    case 254:
      return [{ kind: 'leave', actor }];
    default:
      return [];
  }
}
