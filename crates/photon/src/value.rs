//! Photon's typed values (protocol 1.8, "GpBinaryV18").
//!
//! Integers decode to their logical width (`Int`, `Long`, ...) whatever wire
//! form carried them; encoding picks the same compact form Photon's own
//! serializer picks, so a decoded frame re-encodes to the identical bytes.

/// A typed Photon value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Byte(u8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    String(String),
    ByteArray(Vec<u8>),
    BoolArray(Vec<bool>),
    ShortArray(Vec<i16>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
    FloatArray(Vec<f32>),
    DoubleArray(Vec<f64>),
    StringArray(Vec<String>),
    ObjectArray(Vec<Value>),
    /// Elements of one type, written without per-element type codes.
    Array {
        elem_type: u8,
        items: Vec<Value>,
    },
    Hashtable(Vec<(Value, Value)>),
    /// A type code of 0 means each key (or value) carries its own type.
    Dictionary {
        key_type: u8,
        value_type: u8,
        entries: Vec<(Value, Value)>,
    },
    HashtableArray(Vec<Vec<(Value, Value)>>),
    /// A type registered by the application (e.g. PUN's Vector3 is code 86).
    Custom {
        code: u8,
        data: Vec<u8>,
    },
    CustomArray {
        code: u8,
        items: Vec<Vec<u8>>,
    },
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    /// Any integer width, widened.
    pub fn as_i64(&self) -> Option<i64> {
        match *self {
            Value::Byte(v) => Some(v.into()),
            Value::Short(v) => Some(v.into()),
            Value::Int(v) => Some(v.into()),
            Value::Long(v) => Some(v),
            _ => None,
        }
    }

    /// Looks a key up in a hashtable or dictionary.
    pub fn get(&self, key: &Value) -> Option<&Value> {
        match self {
            Value::Hashtable(e) | Value::Dictionary { entries: e, .. } => {
                e.iter().find(|(k, _)| k == key).map(|(_, v)| v)
            }
            _ => None,
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_owned())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
impl From<u8> for Value {
    fn from(v: u8) -> Self {
        Value::Byte(v)
    }
}
impl From<i32> for Value {
    fn from(v: i32) -> Self {
        Value::Int(v)
    }
}

/// Parameters of a request, response or event: byte keys, in wire order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Params(pub Vec<(u8, Value)>);

impl Params {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn get(&self, key: u8) -> Option<&Value> {
        self.0.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    #[must_use]
    pub fn with(mut self, key: u8, value: impl Into<Value>) -> Self {
        self.0.push((key, value.into()));
        self
    }
}

/// One Photon message.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        code: u8,
        params: Params,
    },
    Response {
        code: u8,
        return_code: i16,
        debug_message: Option<String>,
        params: Params,
    },
    Event {
        code: u8,
        params: Params,
    },
    InternalRequest {
        code: u8,
        params: Params,
    },
    InternalResponse {
        code: u8,
        return_code: i16,
        debug_message: Option<String>,
        params: Params,
    },
    /// Init exchange and other message types, kept as raw bytes.
    Other {
        msg_type: u8,
        body: Vec<u8>,
    },
    /// Encrypted payloads are not decoded.
    Encrypted {
        msg_type: u8,
    },
}
