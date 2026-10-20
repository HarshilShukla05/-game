# Smash Karts WhatsApp bot

Someone types `@game` in the friends' WhatsApp group. The bot hosts a Smash Karts
private room (by default Nukes only, Smash Island, region India) in a real
browser and replies with the invite link. On a phone, the link opens the Smash
Karts app.

| Command | What happens |
|---|---|
| `@game` | Room with the defaults: Nukes only, Smash Island, Free For All, 10 min rounds (or the live room's link again). |
| `@game 20` | Room with 20 min rounds. Lengths: 3, 6, 10, 20. |
| `@game team` | Team Battle. |
| `@game tunnels` | Any of the 30 arenas, or `random`. Full names or a part only one arena has: `sky arena tunnels`, `tunnels`, `island`, `old graveyard`. |
| `@game nuke mines` / `@game all` | One or more of the 12 weapons, or all of them. Plurals and short names work: `nukes`, `gun`, `spikes`. |
| `@game 20 team tunnels nuke mines` | Everything together, in any order. A live room with other settings is replaced. |
| `@game help` | Lists the arenas and weapons. |
| `@start` | Starts the round. The host must start each round, and the bot is the host. |

Verified on the real game (smashkarts.io 2.16.007): rooms made on the first
attempt, about 65-80 s each in a cloud sandbox without a GPU, with links
checked for arena, weapons and round length. On 2.16.008, arenas from both ends
of the list (Toxic Towers, The Sand Box, SnowparkCTF, Boneyard Basin, Sky Arena
Tunnels, Random) with one to all twelve weapons: about 85-130 s each.

```
WhatsApp group ──@game──▶ whatsapp.js (Baileys) ──▶ roomManager.js ──▶ host.js (Playwright Chromium)
       ▲                                             one room at a time      replays recordings/create.json
       └──────────── reply with the invite link ◀─── link captured from the game's window.copyText()
```

- **Link capture:** the game copies its invite link with a page function,
  `window.copyText(link)`. The bot hooks that function, so it gets the exact
  text without OCR or clipboard access.
- **Room check:** the invite link encodes the room's settings (`wpns` is a
  bitmask of the weapons, e.g. 256 for Nukes only; round minutes in bits 8-15
  of `mode`; Team Battle in bit 1), and the copied share message names the
  arena (`Arena: Sky Arena - Tunnels`). The bot checks every room before
  posting it, so a misclick that builds a wrong room fails the attempt instead
  of reaching the group.
- **Arenas and weapons:** `recordings/create.json` holds a snapshot of every
  weapon tile (switched off) and arena tile, cut from the real game. The
  recording's `weapons` step becomes clicks on the chosen tiles (each checked
  to have switched on), or on "All ON"; its `arena` step scrolls the arena
  list (sorted by name) to the end that shows the tile, then clicks it.
- **Clicks:** the game is one WebGL canvas with no DOM buttons. You record your
  clicks once (`npm run calibrate`) and the bot replays them. Each recorded
  click also stores a 40×40 snapshot of what was under the cursor, cut from the
  frame before the press. Before each click, the replay waits until the screen
  has that shape again (luminance correlation, so hover/press tints do not
  matter). A slow load delays a click instead of wasting it. After each click
  it waits for the next spot, and clicks again if the game swallowed the click.
  Known popups (`popups` in the recording, e.g. the game's "Check out our NEW
  GAME" promo) are closed when they appear.
- **Screenshots:** always full-viewport, cropped in Node. A clipped
  `page.screenshot` makes Chromium relayout the page, and Unity then drops or
  misplaces the next click.
- **Reliability:**
  - One room creation at a time. Simultaneous `@game` messages share it, and a
    live room is reused and its timer extended.
  - Up to 3 attempts, each from a freshly loaded menu. Every failure saves a
    screenshot, which is also posted to the group.
  - The menu is kept loaded, and it is reloaded every hour and after a crash.
  - WhatsApp reconnects with backoff. `@game` messages older than 2 minutes are
    ignored after a reconnect.
- **Data:** every command, room and failure goes to `data/events.jsonl`. That
  is the start of the "learn from our matches" work.

## Setup on the Ubuntu laptop

Needs Node 20 or later.

```bash
git clone <this repo> && cd -game
npm install
npx playwright install --with-deps chromium   # or set browser.channel to "chrome" if Google Chrome is installed
```

### 1. Record the clicks (once, and again after a game update moves buttons)

```bash
npm run calibrate
```

A browser window opens at a fixed 1280×720 viewport.

1. **Wait** until the main menu is fully loaded and connected.
2. Once, before recording counts: set the region (globe button, bottom right)
   to **India**. The profile remembers it. Close any popup.
3. Create → Weapons **▲** → All OFF → Nuke → Select → Arena **▲** → sort **⇕** →
   Name → Smash Island → Play → Copy Link. Recording stops by itself when the
   link is copied, and is saved to `recordings/create.json`.

Rules that keep the replay reliable:
- Click spots that look the same in every state: the **▲ / ⇕ arrows**, not
  the labels next to them ("All", "Random" and "Sort: Newest" change).
- Leave Round Timer alone. The bot inserts the timer presses before Play.
- Click only what the bot should click. Wait for each screen before clicking.

A checked-in recording already exists (recorded at 1280×720). It should work on
the laptop as is; re-record only if a replay fails. The viewport is fixed, so
the monitor size does not matter.

### 2. Run

```bash
npm start            # visible browser window on the laptop's desktop
npm run start:xvfb   # no monitor / lid closed: virtual display
```

1. Scan the QR code with the **bot's phone**: WhatsApp → Linked devices → Link a device.
   No second screen? Start with `WA_PAIRING_NUMBER=<bot number with country code>`
   and enter the printed 8-character code under "Link with phone number instead".
2. Type `@game` in the group. The bot logs the group ID.
3. Put the ID in `config.json` → `whatsapp.groupIds` to lock the bot to that group.

### Keep it running

```bash
mkdir -p ~/.config/systemd/user
cp deploy/smashbot.service ~/.config/systemd/user/   # edit WorkingDirectory if needed
systemctl --user daemon-reload && systemctl --user enable --now smashbot
loginctl enable-linger "$USER"                        # keep it running when you are logged out
journalctl --user -u smashbot -f                      # logs
```

So the laptop keeps running with the lid closed, set `HandleLidSwitch=ignore`
in `/etc/systemd/logind.conf`, then run `sudo systemctl restart systemd-logind`.

## Config (`config.json`)

| Key | Meaning |
|---|---|
| `whatsapp.groupIds` | Allowed groups. Empty = setup mode (any group, IDs are logged). |
| `whatsapp.pairingNumber` | Bot number for code-based linking (or env `WA_PAIRING_NUMBER`). |
| `whatsapp.trigger` / `startTrigger` | Command texts, default `@game` and `@start`. |
| `whatsapp.replyTemplate` | Reply text with `{link}`, `{weapons}`, `{arena}`, `{format}`, `{minutes}`. |
| `whatsapp.sendFailureScreenshot` | Post the failure screenshot to the group. |
| `browser.channel` / `executablePath` | Use installed Chrome (`"chrome"`) or a specific binary (or env `CHROMIUM_PATH`). |
| `game.menuTimeoutMs` | How long to wait for the game to load and connect (default 3 min). |
| `game.createAttempts` | Full attempts per `@game`, each from a fresh reload. |
| `game.defaults` | Arena and weapons when `@game` names none (names as in the recording's tiles). |
| `game.timer` | Round lengths the game cycles through, the default, and the ▶ arrow position. |
| `game.photonPort443` | Moves Photon WebSockets to port 443 (env `SK_PHOTON_PORT_443=1`). Only for networks that block port 19093, e.g. the cloud sandbox. |
| `replay.strictVisual` | Fail instead of clicking when a spot never looks as recorded. |
| `replay.minSimilarity` | Shape similarity needed for a match (0.8; real matches 0.91-1.0, look-alikes ≤ 0.68). |
| `replay.debugShots` | Save a screenshot before every click to `data/screens/replay-*`. |
| `game.roomTtlMinutes` | The bot leaves the room this long after the last `@game`. |
| `replay.speed` | Below 1 replays faster than you recorded (pauses are capped at `maxGapMs`). |
| `replay.visualThreshold` | Max mean pixel difference (0–255) for a snapshot to count as a match. |

## Tests

```bash
npm test                                   # unit tests
xvfb-run -a npm test                       # plus end-to-end tests against test/fixtures/fake-game.html
```

The fake game copies the real game's JS surface (`window.copyText`,
`onLoadingToMainMenuComplete`, which fires before the canvas finishes loading).
The end-to-end test records a run at a 1.5 s load and replays it at an 8 s load
with 4× slower room creation. It must get the link with zero wasted clicks.

## Risks

- WhatsApp libraries like Baileys are unofficial. Use a spare number, never your main one.
- If a game update moves buttons, re-run `npm run calibrate` (2 minutes).
