# What the game sends over the network

Learned on 2026-10-20 from two captured rounds on smashkarts.io 2.16.008:

1. Our bot alone with the game's built-in bots (Team Battle, all weapons).
2. Our bot and a second browser that joined by the invite link (Free For All, Nuke only).

Code: `src/photon.js` decodes frames, `src/smashkarts.js` turns them into game
events, `test/photon.test.js` checks both against real frames.
Capture: `new Host(cfg, log, { capture: true })` emits `'net'` with every
WebSocket frame both ways (`src/hooks.js`).

## Transport

| Socket | Use |
|---|---|
| `wss://ns.photonengine.io` | Photon name server (regions, auth) |
| `wss://gcmumNNN.exitgames.com/Master/` | Photon master (find/create the room) |
| `wss://gcmumNNN.exitgames.com/game/` | Photon game server: **everything that happens in the room** |
| `wss://*.firebaseio.com` | Firebase (accounts, not gameplay) |

Frames are Photon binary protocol 1.8 (client libversion 4.1.6.11): `0xF3`,
message type, typed body. Unencrypted inside the page. The game uses PUN
(Photon Unity Networking): game events travel as `RaiseEvent` with PUN's codes.

## PUN events

| Code | Meaning | Seen |
|---|---|---|
| 201 / 206 | State of networked objects (unreliable / reliable) | Kart states, about 6 per second per kart here (one every 130-210 ms) |
| 202 | Instantiate | `pv` = a player's kart (view = actor × 1000 + n), `bv` = a built-in bot. Position and rotation as floats |
| 204 | Destroy | A kart removed: smashed, or the round ended |
| 200 | RPC | Methods are sent by **index**, not name (table below) |
| 255 / 254 | Photon join / leave | Player name, actor list |

**No state is sent while one player is alone in the room** (PUN skips it).
Built-in bots run on the host's game and are sent to the others like karts.

## Kart state (in 201/206): 20 bytes, little-endian

| Bytes | Field | Decoding |
|---|---|---|
| 0-5 | position x, y, z | uint16: (v − 32768) / 16 (1/16-unit steps, ±2048 range) |
| 6-13 | rotation | quaternion, int16 / 32767, Unity order (x, y, z, w); heading = 2·atan2(y, w), forward = (sin, 0, cos) |
| 14-19 | velocity x, y, z | int16 / 512 units/s (±64) |

Smash Island spans about x −200..200, z −208..205; karts reach ~30 units/s.

Checked: x and heading against the spawn position and rotation; velocity
against position differences (fit 1/506 and 1/514 per raw unit, so 1/512).
**Open:** z reads 3-4.6 units lower than the float positions in RPCs and
spawns. Distances between karts are unaffected; we will pin it down with
more reference points.

## RPCs (code 200), by method index

Meanings are from their arguments and timing. They are hypotheses until
checked against more rounds.

| Index | Arguments | Likely meaning |
|---|---|---|
| 8 | weapon id, position, [3 bytes], 0, seed, ~330, n | A kart fires its weapon |
| 11 | attacker view, position, direction, damage (200), weapon id, seed | A kart takes a hit (7 s before its 204 destroy) |
| 10 | −1, position (below the floor), normal, damage (100), −1, −1 | Damage from the arena (fell off) |
| 7 | position, rotation | A built-in bot respawns |
| 9 | position (y = 0.15) | A pickup box (re)appears, on scene views 1-10 |
| 3 | 1, position, up vector, n, 2 | Built-in bots only; unknown |

## Room and player properties

Room properties include `gl` (arena name), `gm` (mode bits: round minutes
in bits 8-15, Team Battle bit 1), `wm` (weapons mask). Score-like
properties use hashed keys and scrambled values (anti-cheat), for example
`452855911`, and are not needed so far.

## What this means for the bot

- Every kart's position, heading and speed are available at the network
  rate, with no image processing. Between updates, positions are predicted
  from velocity.
- Smashes are visible as hit RPCs plus a destroy and respawn: the bot's
  main number (how often the bot itself gets smashed) can be counted from
  the stream.
- The sandbox runs the game at about 16 fps, which limits the bot's own
  update rate. A machine with a GPU should send and receive more often.
