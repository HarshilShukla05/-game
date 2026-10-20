//! Decoding and encoding of Photon protocol 1.8 frames, as sent over
//! WebSocket: `0xF3`, a message type byte, then the typed body.

use crate::value::{Message, Params, Value};
use std::fmt;

const MAGIC: u8 = 0xF3;

// Message types.
const REQUEST: u8 = 2;
const RESPONSE: u8 = 3;
const EVENT: u8 = 4;
const INTERNAL_REQUEST: u8 = 6;
const INTERNAL_RESPONSE: u8 = 7;

// Type codes (Photon's Protocol18 GpType).
const T_UNKNOWN: u8 = 0;
const T_BOOL: u8 = 2;
const T_BYTE: u8 = 3;
const T_SHORT: u8 = 4;
const T_FLOAT: u8 = 5;
const T_DOUBLE: u8 = 6;
const T_STRING: u8 = 7;
const T_NULL: u8 = 8;
const T_COMPRESSED_INT: u8 = 9;
const T_COMPRESSED_LONG: u8 = 10;
const T_INT1: u8 = 11;
const T_INT1_NEG: u8 = 12;
const T_INT2: u8 = 13;
const T_INT2_NEG: u8 = 14;
const T_L1: u8 = 15;
const T_L1_NEG: u8 = 16;
const T_L2: u8 = 17;
const T_L2_NEG: u8 = 18;
const T_CUSTOM: u8 = 19;
const T_DICTIONARY: u8 = 20;
const T_HASHTABLE: u8 = 21;
const T_OBJECT_ARRAY: u8 = 23;
const T_FALSE: u8 = 27;
const T_TRUE: u8 = 28;
const T_SHORT_ZERO: u8 = 29;
const T_INT_ZERO: u8 = 30;
const T_LONG_ZERO: u8 = 31;
const T_FLOAT_ZERO: u8 = 32;
const T_DOUBLE_ZERO: u8 = 33;
const T_BYTE_ZERO: u8 = 34;
const T_ARRAY: u8 = 64;
const T_BOOL_ARRAY: u8 = 66;
const T_BYTE_ARRAY: u8 = 67;
const T_SHORT_ARRAY: u8 = 68;
const T_FLOAT_ARRAY: u8 = 69;
const T_DOUBLE_ARRAY: u8 = 70;
const T_STRING_ARRAY: u8 = 71;
const T_INT_ARRAY: u8 = 73;
const T_LONG_ARRAY: u8 = 74;
const T_CUSTOM_ARRAY: u8 = 83;
const T_HASHTABLE_ARRAY: u8 = 85;
const T_CUSTOM_SLIM: u8 = 0x80;

/// Why a frame could not be decoded or encoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    NotPhoton,
    Truncated { at: usize },
    UnknownType { code: u8, at: usize },
    BadUtf8 { at: usize },
    Unsupported(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotPhoton => write!(f, "not a Photon frame"),
            Error::Truncated { at } => write!(f, "frame ends early at byte {at}"),
            Error::UnknownType { code, at } => write!(f, "unknown type 0x{code:02x} at byte {at}"),
            Error::BadUtf8 { at } => write!(f, "invalid UTF-8 at byte {at}"),
            Error::Unsupported(what) => write!(f, "unsupported: {what}"),
        }
    }
}

impl std::error::Error for Error {}

type Result<T> = std::result::Result<T, Error>;

// ---------------------------------------------------------------- decoding

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len());
        let end = end.ok_or(Error::Truncated { at: self.pos })?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut a = [0; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn varint(&mut self) -> Result<u64> {
        let mut out = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            out |= u64::from(b & 0x7F) << shift;
            if b & 0x80 == 0 {
                return Ok(out);
            }
        }
        Err(Error::Truncated { at: self.pos })
    }

    /// A count or length. Bounded by the bytes left, so a corrupt count can
    /// never make the decoder allocate more than the frame could hold.
    fn count(&mut self) -> Result<usize> {
        let n = usize::try_from(self.varint()?).map_err(|_| Error::Truncated { at: self.pos })?;
        if n > self.buf.len() - self.pos {
            return Err(Error::Truncated { at: self.pos });
        }
        Ok(n)
    }

    fn zigzag32(&mut self) -> Result<i32> {
        let n = self.varint()? as u32;
        Ok(((n >> 1) as i32) ^ -((n & 1) as i32))
    }

    fn zigzag64(&mut self) -> Result<i64> {
        let n = self.varint()?;
        Ok(((n >> 1) as i64) ^ -((n & 1) as i64))
    }

    fn string(&mut self) -> Result<String> {
        let n = self.count()?;
        let at = self.pos;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| Error::BadUtf8 { at })
    }

    fn typed(&mut self) -> Result<Value> {
        let t = self.u8()?;
        self.value(t)
    }

    fn value(&mut self, t: u8) -> Result<Value> {
        if t >= T_CUSTOM_SLIM {
            return self.custom(t & 0x7F);
        }
        Ok(match t {
            T_UNKNOWN | T_NULL => Value::Null,
            T_BOOL => Value::Bool(self.u8()? != 0),
            T_BYTE => Value::Byte(self.u8()?),
            T_SHORT => Value::Short(i16::from_le_bytes(self.array()?)),
            T_FLOAT => Value::Float(f32::from_le_bytes(self.array()?)),
            T_DOUBLE => Value::Double(f64::from_le_bytes(self.array()?)),
            T_STRING => Value::String(self.string()?),
            T_COMPRESSED_INT => Value::Int(self.zigzag32()?),
            T_COMPRESSED_LONG => Value::Long(self.zigzag64()?),
            T_INT1 => Value::Int(self.u8()?.into()),
            T_INT1_NEG => Value::Int(-i32::from(self.u8()?)),
            T_INT2 => Value::Int(u16::from_le_bytes(self.array()?).into()),
            T_INT2_NEG => Value::Int(-i32::from(u16::from_le_bytes(self.array()?))),
            T_L1 => Value::Long(self.u8()?.into()),
            T_L1_NEG => Value::Long(-i64::from(self.u8()?)),
            T_L2 => Value::Long(u16::from_le_bytes(self.array()?).into()),
            T_L2_NEG => Value::Long(-i64::from(u16::from_le_bytes(self.array()?))),
            T_CUSTOM => {
                let code = self.u8()?;
                self.custom(code)?
            }
            T_DICTIONARY => self.dictionary()?,
            T_HASHTABLE => Value::Hashtable(self.entries()?),
            T_OBJECT_ARRAY => {
                let n = self.count()?;
                Value::ObjectArray((0..n).map(|_| self.typed()).collect::<Result<_>>()?)
            }
            T_FALSE => Value::Bool(false),
            T_TRUE => Value::Bool(true),
            T_SHORT_ZERO => Value::Short(0),
            T_INT_ZERO => Value::Int(0),
            T_LONG_ZERO => Value::Long(0),
            T_FLOAT_ZERO => Value::Float(0.0),
            T_DOUBLE_ZERO => Value::Double(0.0),
            T_BYTE_ZERO => Value::Byte(0),
            T_ARRAY => {
                let n = self.count()?;
                let elem_type = self.u8()?;
                let items = (0..n)
                    .map(|_| self.value(elem_type))
                    .collect::<Result<_>>()?;
                Value::Array { elem_type, items }
            }
            T_BOOL_ARRAY => {
                let n = self.count()?;
                let packed = self.take(n.div_ceil(8))?;
                Value::BoolArray(
                    (0..n)
                        .map(|i| packed[i / 8] & (1 << (i % 8)) != 0)
                        .collect(),
                )
            }
            T_BYTE_ARRAY => {
                let n = self.count()?;
                Value::ByteArray(self.take(n)?.to_vec())
            }
            T_SHORT_ARRAY => {
                let n = self.count()?;
                Value::ShortArray(
                    (0..n)
                        .map(|_| Ok(i16::from_le_bytes(self.array()?)))
                        .collect::<Result<_>>()?,
                )
            }
            T_FLOAT_ARRAY => {
                let n = self.count()?;
                Value::FloatArray(
                    (0..n)
                        .map(|_| Ok(f32::from_le_bytes(self.array()?)))
                        .collect::<Result<_>>()?,
                )
            }
            T_DOUBLE_ARRAY => {
                let n = self.count()?;
                Value::DoubleArray(
                    (0..n)
                        .map(|_| Ok(f64::from_le_bytes(self.array()?)))
                        .collect::<Result<_>>()?,
                )
            }
            T_STRING_ARRAY => {
                let n = self.count()?;
                Value::StringArray((0..n).map(|_| self.string()).collect::<Result<_>>()?)
            }
            T_INT_ARRAY => {
                let n = self.count()?;
                Value::IntArray((0..n).map(|_| self.zigzag32()).collect::<Result<_>>()?)
            }
            T_LONG_ARRAY => {
                let n = self.count()?;
                Value::LongArray((0..n).map(|_| self.zigzag64()).collect::<Result<_>>()?)
            }
            T_CUSTOM_ARRAY => {
                let n = self.count()?;
                let code = self.u8()?;
                let items = (0..n)
                    .map(|_| {
                        let len = self.count()?;
                        Ok(self.take(len)?.to_vec())
                    })
                    .collect::<Result<_>>()?;
                Value::CustomArray { code, items }
            }
            T_HASHTABLE_ARRAY => {
                let n = self.count()?;
                Value::HashtableArray((0..n).map(|_| self.entries()).collect::<Result<_>>()?)
            }
            code => {
                return Err(Error::UnknownType {
                    code,
                    at: self.pos - 1,
                });
            }
        })
    }

    fn custom(&mut self, code: u8) -> Result<Value> {
        let n = self.count()?;
        Ok(Value::Custom {
            code,
            data: self.take(n)?.to_vec(),
        })
    }

    fn entries(&mut self) -> Result<Vec<(Value, Value)>> {
        let n = self.count()?;
        (0..n).map(|_| Ok((self.typed()?, self.typed()?))).collect()
    }

    fn dictionary(&mut self) -> Result<Value> {
        let key_type = self.u8()?;
        let value_type = self.u8()?;
        let n = self.count()?;
        let mut entries = Vec::with_capacity(n);
        for _ in 0..n {
            let k = if key_type == T_UNKNOWN {
                self.typed()?
            } else {
                self.value(key_type)?
            };
            let v = if value_type == T_UNKNOWN {
                self.typed()?
            } else {
                self.value(value_type)?
            };
            entries.push((k, v));
        }
        Ok(Value::Dictionary {
            key_type,
            value_type,
            entries,
        })
    }

    fn params(&mut self) -> Result<Params> {
        let n = self.u8()?;
        (0..n)
            .map(|_| Ok((self.u8()?, self.typed()?)))
            .collect::<Result<_>>()
            .map(Params)
    }

    fn debug_message(&mut self) -> Result<Option<String>> {
        Ok(match self.typed()? {
            Value::String(s) => Some(s),
            _ => None,
        })
    }
}

/// Decodes one WebSocket frame.
pub fn decode(frame: &[u8]) -> Result<Message> {
    let mut r = Reader { buf: frame, pos: 0 };
    if r.u8()? != MAGIC {
        return Err(Error::NotPhoton);
    }
    let raw = r.u8()?;
    if raw & 0x80 != 0 {
        return Ok(Message::Encrypted {
            msg_type: raw & 0x7F,
        });
    }
    Ok(match raw {
        REQUEST | INTERNAL_REQUEST => {
            let code = r.u8()?;
            let params = r.params()?;
            if raw == REQUEST {
                Message::Request { code, params }
            } else {
                Message::InternalRequest { code, params }
            }
        }
        EVENT => {
            let code = r.u8()?;
            Message::Event {
                code,
                params: r.params()?,
            }
        }
        RESPONSE | INTERNAL_RESPONSE => {
            let code = r.u8()?;
            let return_code = i16::from_le_bytes(r.array()?);
            let debug_message = r.debug_message()?;
            let params = r.params()?;
            if raw == RESPONSE {
                Message::Response {
                    code,
                    return_code,
                    debug_message,
                    params,
                }
            } else {
                Message::InternalResponse {
                    code,
                    return_code,
                    debug_message,
                    params,
                }
            }
        }
        msg_type => Message::Other {
            msg_type,
            body: frame[2..].to_vec(),
        },
    })
}

// ---------------------------------------------------------------- encoding

fn put_varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

fn put_count(out: &mut Vec<u8>, n: usize) {
    put_varint(out, n as u64);
}

fn put_zigzag32(out: &mut Vec<u8>, v: i32) {
    put_varint(out, u64::from(((v << 1) ^ (v >> 31)) as u32));
}

fn put_zigzag64(out: &mut Vec<u8>, v: i64) {
    put_varint(out, ((v << 1) ^ (v >> 63)) as u64);
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    put_count(out, s.len());
    out.extend_from_slice(s.as_bytes());
}

/// The wire type Photon's serializer picks for a value.
fn type_of(v: &Value) -> u8 {
    match *v {
        Value::Null => T_NULL,
        Value::Bool(b) => {
            if b {
                T_TRUE
            } else {
                T_FALSE
            }
        }
        Value::Byte(0) => T_BYTE_ZERO,
        Value::Byte(_) => T_BYTE,
        Value::Short(0) => T_SHORT_ZERO,
        Value::Short(_) => T_SHORT,
        Value::Int(0) => T_INT_ZERO,
        Value::Int(i) if (1..=0xFF).contains(&i) => T_INT1,
        Value::Int(i) if (-0xFF..0).contains(&i) => T_INT1_NEG,
        Value::Int(i) if (1..=0xFFFF).contains(&i) => T_INT2,
        Value::Int(i) if (-0xFFFF..0).contains(&i) => T_INT2_NEG,
        Value::Int(_) => T_COMPRESSED_INT,
        Value::Long(0) => T_LONG_ZERO,
        Value::Long(i) if (1..=0xFF).contains(&i) => T_L1,
        Value::Long(i) if (-0xFF..0).contains(&i) => T_L1_NEG,
        Value::Long(i) if (1..=0xFFFF).contains(&i) => T_L2,
        Value::Long(i) if (-0xFFFF..0).contains(&i) => T_L2_NEG,
        Value::Long(_) => T_COMPRESSED_LONG,
        // Photon writes zero floats in full (seen on the real game); the
        // FloatZero/DoubleZero codes are only read.
        Value::Float(_) => T_FLOAT,
        Value::Double(_) => T_DOUBLE,
        Value::String(_) => T_STRING,
        Value::ByteArray(_) => T_BYTE_ARRAY,
        Value::BoolArray(_) => T_BOOL_ARRAY,
        Value::ShortArray(_) => T_SHORT_ARRAY,
        Value::IntArray(_) => T_INT_ARRAY,
        Value::LongArray(_) => T_LONG_ARRAY,
        Value::FloatArray(_) => T_FLOAT_ARRAY,
        Value::DoubleArray(_) => T_DOUBLE_ARRAY,
        Value::StringArray(_) => T_STRING_ARRAY,
        Value::ObjectArray(_) => T_OBJECT_ARRAY,
        Value::Array { .. } => T_ARRAY,
        Value::Hashtable(_) => T_HASHTABLE,
        Value::Dictionary { .. } => T_DICTIONARY,
        Value::HashtableArray(_) => T_HASHTABLE_ARRAY,
        Value::Custom { code, .. } if code < 0x80 => T_CUSTOM_SLIM | code,
        Value::Custom { .. } => T_CUSTOM,
        Value::CustomArray { .. } => T_CUSTOM_ARRAY,
    }
}

fn put_typed(out: &mut Vec<u8>, v: &Value) -> Result<()> {
    let t = type_of(v);
    out.push(t);
    put_body(out, t, v)
}

/// Writes the value's body as wire type `t` (without the type byte).
fn put_body(out: &mut Vec<u8>, t: u8, v: &Value) -> Result<()> {
    match (t, v) {
        (T_NULL | T_UNKNOWN | T_TRUE | T_FALSE, _) => {}
        (
            T_SHORT_ZERO | T_INT_ZERO | T_LONG_ZERO | T_FLOAT_ZERO | T_DOUBLE_ZERO | T_BYTE_ZERO,
            _,
        ) => {}
        (T_BOOL, Value::Bool(b)) => out.push(u8::from(*b)),
        (T_BYTE, Value::Byte(b)) => out.push(*b),
        (T_SHORT, Value::Short(s)) => out.extend_from_slice(&s.to_le_bytes()),
        (T_FLOAT, Value::Float(f)) => out.extend_from_slice(&f.to_le_bytes()),
        (T_DOUBLE, Value::Double(d)) => out.extend_from_slice(&d.to_le_bytes()),
        (T_STRING, Value::String(s)) => put_str(out, s),
        (T_COMPRESSED_INT, Value::Int(i)) => put_zigzag32(out, *i),
        (T_COMPRESSED_LONG, Value::Long(i)) => put_zigzag64(out, *i),
        (T_INT1 | T_INT1_NEG, Value::Int(i)) => out.push(i.unsigned_abs() as u8),
        (T_INT2 | T_INT2_NEG, Value::Int(i)) => {
            out.extend_from_slice(&(i.unsigned_abs() as u16).to_le_bytes())
        }
        (T_L1 | T_L1_NEG, Value::Long(i)) => out.push(i.unsigned_abs() as u8),
        (T_L2 | T_L2_NEG, Value::Long(i)) => {
            out.extend_from_slice(&(i.unsigned_abs() as u16).to_le_bytes())
        }
        (T_CUSTOM, Value::Custom { code, data }) => {
            out.push(*code);
            put_count(out, data.len());
            out.extend_from_slice(data);
        }
        (t, Value::Custom { data, .. }) if t >= T_CUSTOM_SLIM => {
            put_count(out, data.len());
            out.extend_from_slice(data);
        }
        (T_HASHTABLE, Value::Hashtable(e)) => put_entries(out, e)?,
        (
            T_DICTIONARY,
            Value::Dictionary {
                key_type,
                value_type,
                entries,
            },
        ) => {
            out.push(*key_type);
            out.push(*value_type);
            put_count(out, entries.len());
            for (k, v) in entries {
                if *key_type == T_UNKNOWN {
                    put_typed(out, k)?
                } else {
                    put_body(out, *key_type, k)?
                }
                if *value_type == T_UNKNOWN {
                    put_typed(out, v)?
                } else {
                    put_body(out, *value_type, v)?
                }
            }
        }
        (T_OBJECT_ARRAY, Value::ObjectArray(items)) => {
            put_count(out, items.len());
            for i in items {
                put_typed(out, i)?;
            }
        }
        (T_ARRAY, Value::Array { elem_type, items }) => {
            put_count(out, items.len());
            out.push(*elem_type);
            for i in items {
                put_body(out, *elem_type, i)?;
            }
        }
        (T_BOOL_ARRAY, Value::BoolArray(b)) => {
            put_count(out, b.len());
            let mut packed = vec![0u8; b.len().div_ceil(8)];
            for (i, _) in b.iter().enumerate().filter(|(_, x)| **x) {
                packed[i / 8] |= 1 << (i % 8);
            }
            out.extend_from_slice(&packed);
        }
        (T_BYTE_ARRAY, Value::ByteArray(b)) => {
            put_count(out, b.len());
            out.extend_from_slice(b);
        }
        (T_SHORT_ARRAY, Value::ShortArray(a)) => {
            put_count(out, a.len());
            a.iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
        }
        (T_FLOAT_ARRAY, Value::FloatArray(a)) => {
            put_count(out, a.len());
            a.iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
        }
        (T_DOUBLE_ARRAY, Value::DoubleArray(a)) => {
            put_count(out, a.len());
            a.iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
        }
        (T_STRING_ARRAY, Value::StringArray(a)) => {
            put_count(out, a.len());
            a.iter().for_each(|s| put_str(out, s));
        }
        (T_INT_ARRAY, Value::IntArray(a)) => {
            put_count(out, a.len());
            a.iter().for_each(|x| put_zigzag32(out, *x));
        }
        (T_LONG_ARRAY, Value::LongArray(a)) => {
            put_count(out, a.len());
            a.iter().for_each(|x| put_zigzag64(out, *x));
        }
        (T_CUSTOM_ARRAY, Value::CustomArray { code, items }) => {
            put_count(out, items.len());
            out.push(*code);
            for data in items {
                put_count(out, data.len());
                out.extend_from_slice(data);
            }
        }
        (T_HASHTABLE_ARRAY, Value::HashtableArray(tables)) => {
            put_count(out, tables.len());
            for e in tables {
                put_entries(out, e)?;
            }
        }
        _ => {
            return Err(Error::Unsupported(
                "value does not fit its declared array or dictionary type",
            ));
        }
    }
    Ok(())
}

fn put_entries(out: &mut Vec<u8>, e: &[(Value, Value)]) -> Result<()> {
    put_count(out, e.len());
    for (k, v) in e {
        put_typed(out, k)?;
        put_typed(out, v)?;
    }
    Ok(())
}

fn put_params(out: &mut Vec<u8>, p: &Params) -> Result<()> {
    let n = u8::try_from(p.0.len()).map_err(|_| Error::Unsupported("more than 255 parameters"))?;
    out.push(n);
    for (k, v) in &p.0 {
        out.push(*k);
        put_typed(out, v)?;
    }
    Ok(())
}

/// Encodes one message into `out` (appended).
pub fn encode_into(msg: &Message, out: &mut Vec<u8>) -> Result<()> {
    out.push(MAGIC);
    match msg {
        Message::Request { code, params } | Message::InternalRequest { code, params } => {
            out.push(if matches!(msg, Message::Request { .. }) {
                REQUEST
            } else {
                INTERNAL_REQUEST
            });
            out.push(*code);
            put_params(out, params)
        }
        Message::Event { code, params } => {
            out.extend_from_slice(&[EVENT, *code]);
            put_params(out, params)
        }
        Message::Response {
            code,
            return_code,
            debug_message,
            params,
        }
        | Message::InternalResponse {
            code,
            return_code,
            debug_message,
            params,
        } => {
            out.push(if matches!(msg, Message::Response { .. }) {
                RESPONSE
            } else {
                INTERNAL_RESPONSE
            });
            out.push(*code);
            out.extend_from_slice(&return_code.to_le_bytes());
            match debug_message {
                Some(s) => put_typed(out, &Value::String(s.clone()))?,
                None => out.push(T_NULL),
            }
            put_params(out, params)
        }
        Message::Other { msg_type, body } => {
            out.push(*msg_type);
            out.extend_from_slice(body);
            Ok(())
        }
        Message::Encrypted { .. } => Err(Error::Unsupported("encrypted messages")),
    }
}

/// Encodes one message into a new frame.
pub fn encode(msg: &Message) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(64);
    encode_into(msg, &mut out)?;
    Ok(out)
}
