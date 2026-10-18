# Handoff: get the bot working end to end on the real game

Read this whole file before acting. It holds everything decided and verified
so far, so you do not need to re-research or re-ask any of it.

## Goal

The owner's friends' WhatsApp group types `@game`. The bot hosts a Smash Karts
private room (**Nukes only, Smash Island map**) and replies with the invite link.
Friends play on Android/iOS. The owner has **confirmed** that smashkarts.io links
open the mobile app. Do not re-verify that.

## Decisions already made (do not re-litigate)

- Scope for now: **only `@game` → link**. No `@start`, `@status` or `@endgame` yet.
  The room auto-closes after `roomTtlMinutes`.
- Stack: Node 20+, Baileys `7.0.0-rc14` (WhatsApp), Playwright `1.63.0` with
  headed Chromium (Xvfb when there is no display). Rust was considered and
  rejected for now: the game load dominates, not our code.
- The bot **stays as host** in the lobby. Anyone in the group may trigger it.
- Clicks: **record and replay** (`recordings/create.json`). Each recorded click
  stores a 40×40 screen patch, and replay waits for that patch to match before
  clicking. This is what makes slow loads safe.
- Long-term home is the owner's Ubuntu laptop. A cloud session is a demo/test
  host only: it is reclaimed when idle.
- The owner values reliability and verification over speed. Verify on the real
  game. **Never present mocked results as real.**

## What exists (branch `claude/confident-archimedes-i18vzi`)

Base your work on this branch: check it out, or merge it into your designated branch.

| File | Role |
|---|---|
| `src/index.js` | Wires everything. Watchdog keeps a warm menu (reload hourly or after a crash). |
| `src/whatsapp.js` | Baileys listener: group allowlist, setup mode logs group IDs, reconnect with backoff, ignores commands older than 2 min. Supports a **pairing code** via `WA_PAIRING_NUMBER` (no QR needed). |
| `src/host.js` | Persistent headed Chromium, one serialized queue. Hooks the game page. |
| `src/hooks.js` | Injected page hooks. `window.copyText(link)` is how the real game copies its invite link (read from smashkarts.io `scripts/main.js`); we wrap it, plus `execCommand('copy')` and `navigator.clipboard`. `onLoadingToMainMenuComplete()` = menu-ready signal. |
| `src/recorder.js`, `src/calibrate.js` | Record a human click-through. Stops automatically when the game copies a link. Calibration also writes `data/game-console.log`. |
| `src/replay.js`, `src/vision.js` | Replay with the patch-match wait. The first click may wait up to `game.menuTimeoutMs`. |
| `src/roomManager.js` | One room at a time shared by all requests, reuse of a live room, 3 attempts from a fresh reload, failure screenshots, TTL. |
| `test/` | Unit tests plus end-to-end tests against `test/fixtures/fake-game.html` (mirrors the real JS surface). All 6 pass. With the visual check disabled, the slow-load test fails, which proves the check is needed. |

## Verified facts about the real game

- smashkarts.io loads in Playwright Chromium under Xvfb with WebGL (SwiftShader).
  Our hooks attach, and `onLoadingToMainMenuComplete` fires ~17 s after navigation.
- **That signal fires early.** The HTML loader hides, but the canvas still shows
  Unity's own "Loading…" screen while the game connects to Photon. The real
  menu comes later. The replay's first-click patch wait handles this.
- In the previous sandbox, the WebSocket to **`wss://ns.photonengine.io:19093`**
  (Photon name server, non-standard port) was cut every time: the proxy status
  showed `ws_closed_mid_exchange` after 39 B. So the game never reached the
  menu. WebSockets on port 443 worked fine (wss echo stayed open 20 s).
  **This is the one blocker.** The new environment was created with broader
  network access to fix it.

## Steps

### 0. Setup (≈2 min)

```bash
npm install
export CHROMIUM_PATH=/opt/pw-browsers/chromium   # pre-installed in the cloud image; do NOT run "playwright install"
xvfb-run -a -s '-screen 0 1920x1080x24' npm test # expect 6 passing
```

### 1. Photon connectivity probe. Do this first, it gates everything.

Write a scratch script (keep it out of the repo) that:
1. Creates `new Host(cfg, log, { record: true })` from `src/host.js`, using `loadConfig()`.
2. Calls `loadMenu()`.
3. Waits ~90 s and logs console lines matching `/photon|connect|disconnect/i`.
4. Takes `host.screenshot('probe')` and views it.

- **Pass:** the screenshot shows the real Smash Karts main menu (no "Loading…"),
  and there is no repeated `OnDisconnected cause: ExceptionOnConnect`.
- **Fail:** run `curl -sS "$HTTPS_PROXY/__agentproxy/status"` and look for
  `ns.photonengine.io:19093`. Tell the owner exactly what is blocked and stop
  the real-game steps. The fallback is running on the laptop (README). Do not fake the steps.

The game is slow under software WebGL. Allow 60–120 s for the menu.

### 2. Calibrate on the real game, acting as the human

`npm run calibrate` expects a human at the window. In the cloud, **you are the
human.** Follow the pattern in `test/integration.test.js`:
1. Start `Host({ record: true })` and call `loadMenu()`.
2. Before recording, dismiss any one-time popups (consent, name). The profile in
   `profile/` remembers them.
3. Wait, using screenshots, until the real menu is visible.
4. `const rec = startRecording(host, cfg.browser.viewport, log)`.
5. Drive the menus with `host.page.mouse.click(x, y, { delay: 70 })`. Find each
   button by taking a screenshot and viewing it before every click. Path:
   private game / create → mode **Nukes** only → map **Smash Island** → create
   the room → the button that copies the invite link.
6. Wait for `host.on('copy', text)` with an http(s) link. Then call
   `rec.finish({ sampleLink })` and write it to `recordings/create.json`.

**Every click while recording is replayed.** If you mis-click, throw the
recording away and start again from a fresh `loadMenu()`.

Save the lobby screenshot that shows Nukes + Smash Island. Send it and the
captured link to the owner as proof.

### 3. Verify replay on the real game

With a fresh `Host` (not record mode) and `RoomManager`, call `getLink()` from a
fresh reload **3 times**: `rooms.close('test')` between runs, or restart the Host.
Each run must return a link, and the lobby screenshot must show the right settings.

Then read `data/game-console.log`. Look for lines that mark "connected to
Photon / menu ready" and "room created / joined". If there are clean ones,
propose using them as a stronger readiness signal than the patch wait.

Commit `recordings/create.json`. It was recorded at the fixed 1280×720
viewport, so it should replay on the laptop too. The owner may still re-record there.

### 4. WhatsApp end to end

The owner is on a phone, so use the **pairing code**, not a QR:
1. Ask for the spare bot number (digits with country code, e.g. `9198…`).
2. Run in the background, logging to a file:
   `WA_PAIRING_NUMBER=<digits> CHROMIUM_PATH=/opt/pw-browsers/chromium xvfb-run -a -s '-screen 0 1920x1080x24' node src/index.js`
3. Read the code from the log, or from `data/events.jsonl` (`wa_pairing_code`).
   Give it to the owner. They enter it on the bot phone: WhatsApp → Linked
   devices → Link a device → "Link with phone number instead".
4. The owner types `@game` in the group. Confirm the link arrives.
5. Take the group ID from the setup-mode log line. Ask before committing it to
   `config.json` `whatsapp.groupIds`.
6. Never commit `auth/`, `profile/` or `data/` (already gitignored).

Remind the owner that this cloud bot stops when the session is reclaimed. The
permanent setup is the laptop (README: systemd unit, lid-close setting).

## Rules

- Develop on your designated branch (based on this one), with clear commit
  messages. No PR unless asked.
- Run `npm test` before every push.
- Keep the code style: small ES modules, comments only where the "why" is not obvious.
