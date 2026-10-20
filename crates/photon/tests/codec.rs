use photon::{Message, Params, Value, decode, encode};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn fixtures() -> Vec<(String, Vec<u8>)> {
    include_str!("fixtures/frames.hex")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(|l| {
            let (name, h) = l.split_once(' ').unwrap();
            (name.to_owned(), hex(h))
        })
        .collect()
}

/// What a client sends must re-encode byte for byte: that is what the bot
/// sends. The Photon server writes some values in other forms (a zero float
/// as FloatZero), so what it sends must only keep its meaning.
fn check(frame: &[u8]) -> Result<(), String> {
    let msg = decode(frame).map_err(|e| e.to_string())?;
    let again = encode(&msg).map_err(|e| e.to_string())?;
    let from_client = matches!(
        msg,
        Message::Request { .. } | Message::InternalRequest { .. }
    );
    if from_client && again != frame {
        return Err(format!("re-encodes differently: {msg:?}"));
    }
    if decode(&again).map_err(|e| e.to_string())? != msg {
        return Err(format!("changes meaning: {msg:?}"));
    }
    Ok(())
}

#[test]
fn real_frames_round_trip() {
    for (name, frame) in fixtures() {
        check(&frame).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}

#[test]
fn join_response_carries_the_room_properties() {
    let frame = fixtures()
        .into_iter()
        .find(|(n, _)| n == "joinResponse")
        .unwrap()
        .1;
    let Message::Response {
        code: 226,
        return_code: 0,
        params,
        ..
    } = decode(&frame).unwrap()
    else {
        panic!("not a join response")
    };
    let props = params.get(248).unwrap();
    assert_eq!(
        props.get(&"gl".into()).and_then(Value::as_str),
        Some("Smash Island")
    );
    assert_eq!(
        props.get(&"wm".into()).and_then(Value::as_i64),
        Some(8_547_820)
    );
}

#[test]
fn every_integer_width_round_trips() {
    for v in [
        0,
        1,
        255,
        256,
        65535,
        65536,
        -1,
        -255,
        -256,
        -65535,
        -65536,
        i32::MAX,
        i32::MIN,
    ] {
        let msg = Message::Request {
            code: 1,
            params: Params::new()
                .with(1, Value::Int(v))
                .with(2, Value::Long(i64::from(v) * 3)),
        };
        assert_eq!(decode(&encode(&msg).unwrap()).unwrap(), msg, "{v}");
    }
}

#[test]
fn corrupt_frames_fail_cleanly() {
    assert!(decode(&[0x00, 0x02]).is_err());
    assert!(
        decode(&[0xF3, 0x02, 0x01, 0x05, 0x01, 0x07, 0xFF, 0xFF, 0xFF, 0x0F]).is_err(),
        "string longer than the frame"
    );
    let frame = fixtures().remove(0).1;
    for cut in 2..frame.len() {
        let _ = decode(&frame[..cut]); // must not panic
    }
}

/// Decodes and re-encodes every frame of a captured room when PHOTON_CORPUS
/// points at a capture file (one JSON object per line with a `b64` field).
#[test]
fn corpus_round_trips_when_given() {
    let Ok(path) = std::env::var("PHOTON_CORPUS") else {
        return;
    };
    let text = std::fs::read_to_string(path).unwrap();
    let (mut n, mut bad) = (0, 0);
    for line in text.lines() {
        let Some(b64) = line
            .split("\"b64\":\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
        else {
            continue;
        };
        let frame = base64(b64);
        n += 1;
        if let Err(e) = check(&frame) {
            bad += 1;
            if bad <= 3 {
                eprintln!("frame {n}: {e}");
            }
        }
    }
    assert_eq!(bad, 0, "{bad} of {n} frames did not round-trip");
    eprintln!("{n} frames round-trip");
}

fn base64(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => 0,
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').map(val).collect();
    bytes
        .chunks(4)
        .flat_map(|c| {
            let n = c
                .iter()
                .enumerate()
                .fold(0u32, |a, (i, &v)| a | (u32::from(v) << (18 - 6 * i)));
            let take = c.len() * 6 / 8;
            (0..take).map(move |i| (n >> (16 - 8 * i)) as u8)
        })
        .collect()
}
