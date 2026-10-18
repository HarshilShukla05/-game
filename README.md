# Smash Karts WhatsApp bot

Someone types `@game` in the friends' WhatsApp group. The bot hosts a Smash Karts
private room (Nukes only, Smash Island) in a real browser and replies with the
invite link. On a phone, the link opens the Smash Karts app.

```
WhatsApp group ──@game──▶ whatsapp.js (Baileys) ──▶ roomManager.js ──▶ host.js (Playwright Chromium)
       ▲                                             one room at a time      replays recordings/create.json
       └──────────── reply with the invite link ◀─── link captured from the game's window.copyText()
```

- **Link capture:** the game copies its invite link with a page function,
  `window.copyText(link)`. The bot hooks that function, so it gets the exact
  text without OCR or clipboard access.
- **Clicks:** the game is one WebGL canvas with no DOM buttons. You record your
  clicks once (`npm run calibrate`) and the bot replays them. Each recorded
  click also stores a 40×40 snapshot of what was under the cursor. Before each
  click, the replay waits until the screen matches that snapshot again, so a
  slow load or slow Photon connection delays a click instead of wasting it.
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
2. Create a private game, choose Nukes only and Smash Island, and create the room.
3. Press the game's copy-invite-link button. Recording stops by itself and is saved to `recordings/create.json`.

Click only what the bot should click. Record on the machine that runs the bot.
The viewport is fixed, so the monitor size does not matter. If the game shows a
one-time popup (name or consent), close it in this window first. The browser
profile in `profile/` keeps those choices for the bot.

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
| `whatsapp.trigger` | Command text, default `@game`. |
| `whatsapp.replyTemplate` | Reply text, `{link}` is replaced. |
| `whatsapp.sendFailureScreenshot` | Post the failure screenshot to the group. |
| `browser.channel` / `executablePath` | Use installed Chrome (`"chrome"`) or a specific binary (or env `CHROMIUM_PATH`). |
| `game.menuTimeoutMs` | How long to wait for the game to load and connect (default 3 min). |
| `game.createAttempts` | Full attempts per `@game`, each from a fresh reload. |
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
