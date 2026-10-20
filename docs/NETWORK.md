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
| 202 | Instantiate | `pv` = a player's kart (view = actor × 1000 + life number), `bv` = a built-in bot. Position and rotation as floats |
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

Smash Island spans about x −200..200, z −208..205. Human players drive at
28-34 units/s on average and up to ~62 (the velocity field's range is ±64).
Updates arrive every ~130 ms per kart when the sender runs at full speed.

Checked: x and heading against the spawn position and rotation; velocity
against position differences (fit 1/506 and 1/514 per raw unit, so 1/512).
**Open:** z reads 3-4.6 units lower than the float positions in RPCs and
spawns. Distances between karts are unaffected; we will pin it down with
more reference points.

## RPCs (code 200), by method index

Confirmed on a round with four human players (2026-10-20, Smash Island,
Nuke only) unless marked otherwise. Weapon ids are the bit numbers of the
link's `wpns` mask (Nuke = 8, see `recordings/create.json`).

| Index | Sent by | Arguments | Meaning |
|---|---|---|---|
| 8 | the shooter's kart | weapon id, position, [3 bytes], 0, **seed**, n, n | Fires its weapon. The seed names the shot. |
| 11 | the victim's kart | attacker **actor**, position, direction of travel, 210, weapon id, seed | Direct hit (210 damage) |
| 10 | the victim's kart | attacker actor, position, direction, damage (26-153), weapon id, seed | Splash damage; one shot can hurt several karts. Attacker −1: the arena (fell off) |
| 7 | a built-in bot | position, rotation | Bot respawns (bots-only room) |
| 9 | scene views 1-10 | position (y = 0.15) | A pickup box (re)appears (bots-only room) |
| 3 | built-in bots | 1, position, up vector, n, 2 | Unknown |
| 5 | a player | none | Unknown (once) |

Hits are sent twice; count each victim + seed + index once.

**Health and death:** a kart has 200 health. Damage adds up; when it reaches
200 the kart is wrecked, and its view is destroyed (code 204) **7 s later**,
followed at once by a new kart (202) with the next view id (`2001` → `2002`).
Deaths, who caused them, and kills per player follow from this
(`tools/combat.mjs`).

**Nuke flight** (19 hits matched to their shots by seed): a Nuke flies
straight along the shooter's heading (direct hits 0-3° off it) at about
**105 units/s**, out to at least 300 units (2.7 s). The shot's start
position and time come from RPC 8 and the shooter's heading from its kart
state, so every shot's path can be predicted as it is fired.

## Room and player properties

Room properties include `gl` (arena name), `gm` (mode bits: round minutes
in bits 8-15, Team Battle bit 1), `wm` (weapons mask). Score-like
properties use hashed keys and scrambled values (anti-cheat), for example
`452855911`, and are not needed so far.

## What this means for the bot

- Every kart's position, heading and speed are available at the network
  rate, with no image processing. Between updates, positions are predicted
  from velocity.
- Smashes are visible as damage RPCs plus a destroy and respawn: the bot's
  main number (how often the bot itself gets smashed) can be counted from
  the stream. `tools/combat.mjs` prints deaths, kills and every shot's
  flight; `tools/map-paths.mjs` draws all paths on a top-down map.
- The sandbox runs the game at about 16 fps, which limits the bot's own
  update rate. A machine with a GPU should send and receive more often.
