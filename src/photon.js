// Decodes the game's Photon WebSocket frames (Photon binary protocol 1.8,
// client libversion 4.1.6.11) into plain objects. The game talks to Photon
// through Unity, so frames arrive as raw bytes: 0xF3, a message type, then a
// typed body.
//
// decodeFrame(buf) -> { type, code, returnCode?, debugMessage?, params }
//   type: 'request' | 'response' | 'event' | 'internalRequest' |
//         'internalResponse' | 'init' | 'initResponse' | 'message' | 'raw'
//   params: { [byte key]: value } for requests, responses and events.
// Values: numbers, strings, booleans, null, arrays, plain objects for
// hashtables and dictionaries, and { $type: 'Vector3', x, y, z } style
// objects for the custom types PUN registers (Vector2/3, Quaternion, Player).

const MAGIC = 0xf3;
const MESSAGE_TYPES = {
  0: 'init', 1: 'initResponse', 2: 'request', 3: 'response', 4: 'event',
  6: 'internalRequest', 7: 'internalResponse', 8: 'message', 9: 'raw',
};

// PUN's custom types, serialized big-endian by PUN itself.
const CUSTOM = {
  86: (b) => ({ $type: 'Vector3', x: b.readFloatBE(0), y: b.readFloatBE(4), z: b.readFloatBE(8) }),
  87: (b) => ({ $type: 'Vector2', x: b.readFloatBE(0), y: b.readFloatBE(4) }),
  81: (b) => ({ $type: 'Quaternion', w: b.readFloatBE(0), x: b.readFloatBE(4), y: b.readFloatBE(8), z: b.readFloatBE(12) }),
  80: (b) => ({ $type: 'Player', actor: b.readInt32BE(0) }),
};

class Reader {
  constructor(buf) {
    this.b = buf;
    this.i = 0;
  }

  need(n) {
    if (this.i + n > this.b.length) throw new Error(`frame ends early at byte ${this.i} (needs ${n} more)`);
  }

  u8() { this.need(1); return this.b[this.i++]; }
  i16() { this.need(2); const v = this.b.readInt16LE(this.i); this.i += 2; return v; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.i); this.i += 2; return v; }
  f32() { this.need(4); const v = this.b.readFloatLE(this.i); this.i += 4; return v; }
  f64() { this.need(8); const v = this.b.readDoubleLE(this.i); this.i += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.i, this.i + n); this.i += n; return v; }

  // Unsigned LEB128 varint.
  varint() {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      if (shift > 63n) throw new Error('varint too long');
    }
  }

  count() { return Number(this.varint()); }
  zigzag() { const n = this.varint(); return Number((n >> 1n) ^ -(n & 1n)); }
  string() { return this.bytes(this.count()).toString('utf8'); }
}

// One value whose type byte has already been read.
function value(r, t) {
  if (t >= 0x80) return custom(r, t & 0x7f);
  switch (t) {
    case 0: case 8: return null;
    case 2: return r.u8() !== 0;
    case 3: return r.u8();
    case 4: return r.i16();
    case 5: return r.f32();
    case 6: return r.f64();
    case 7: return r.string();
    case 9: case 10: return r.zigzag();
    case 11: case 15: return r.u8();
    case 12: case 16: return -r.u8();
    case 13: case 17: return r.u16();
    case 14: case 18: return -r.u16();
    case 19: return custom(r, r.u8());
    case 20: return dictionary(r);
    case 21: return hashtable(r);
    case 23: return Array.from({ length: r.count() }, () => any(r));
    case 24: { const code = r.u8(); return { $type: 'OperationRequest', code, params: table(r) }; }
    case 25: return { $type: 'OperationResponse', ...response(r) };
    case 26: { const code = r.u8(); return { $type: 'EventData', code, params: table(r) }; }
    case 27: return false;
    case 28: return true;
    case 29: case 30: case 31: case 32: case 33: case 34: return 0;
    case 66: { // booleans, 8 to a byte
      const n = r.count();
      const packed = r.bytes(Math.ceil(n / 8));
      return Array.from({ length: n }, (_, k) => Boolean(packed[k >> 3] & (1 << (k & 7))));
    }
    case 67: return Array.from(r.bytes(r.count()));
    case 68: return Array.from({ length: r.count() }, () => r.i16());
    case 69: return Array.from({ length: r.count() }, () => r.f32());
    case 70: return Array.from({ length: r.count() }, () => r.f64());
    case 71: return Array.from({ length: r.count() }, () => r.string());
    case 73: case 74: return Array.from({ length: r.count() }, () => r.zigzag());
    case 83: { // custom type array: one type code for all items
      const n = r.count();
      const code = r.u8();
      return Array.from({ length: n }, () => customBody(r, code));
    }
    case 84: return Array.from({ length: r.count() }, () => dictionary(r));
    case 85: return Array.from({ length: r.count() }, () => hashtable(r));
    case 64: { // array of arrays (or of another typed value)
      const n = r.count();
      const inner = r.u8();
      return Array.from({ length: n }, () => value(r, inner));
    }
    default: throw new Error(`unknown type 0x${t.toString(16)} at byte ${r.i - 1}`);
  }
}

const any = (r) => value(r, r.u8());

function customBody(r, code) {
  const body = r.bytes(r.count());
  const decode = CUSTOM[code];
  if (decode && body.length >= { 86: 12, 87: 8, 81: 16, 80: 4 }[code]) return decode(Buffer.from(body));
  return { $type: `custom${code}`, hex: Buffer.from(body).toString('hex') };
}

const custom = (r, code) => customBody(r, code);

function hashtable(r) {
  const out = {};
  for (let n = r.count(); n > 0; n--) {
    const key = any(r);
    out[key] = any(r);
  }
  return out;
}

function dictionary(r) {
  const keyType = r.u8();
  const valueType = r.u8();
  const out = {};
  for (let n = r.count(); n > 0; n--) {
    const key = keyType === 0 ? any(r) : value(r, keyType);
    out[key] = valueType === 0 ? any(r) : value(r, valueType);
  }
  return out;
}

// Parameter table of a request, response or event: byte keys, typed values.
function table(r) {
  const out = {};
  for (let n = r.u8(); n > 0; n--) {
    const key = r.u8();
    out[key] = any(r);
  }
  return out;
}

function response(r) {
  const code = r.u8();
  const returnCode = r.i16();
  const debugMessage = any(r);
  return { code, returnCode, debugMessage, params: table(r) };
}

export function decodeFrame(buf) {
  const r = new Reader(buf);
  if (r.u8() !== MAGIC) throw new Error(`not a Photon frame (starts 0x${buf[0]?.toString(16)})`);
  const raw = r.u8();
  if (raw & 0x80) return { type: 'encrypted', messageType: raw & 0x7f };
  const type = MESSAGE_TYPES[raw];
  switch (type) {
    case 'request':
    case 'internalRequest':
    case 'event': {
      const code = r.u8();
      return { type, code, params: table(r) };
    }
    case 'response':
    case 'internalResponse':
      return { type, ...response(r) };
    default:
      return { type: type ?? `type${raw}`, hex: buf.subarray(2).toString('hex') };
  }
}
