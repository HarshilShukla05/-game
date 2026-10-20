# Handoff: deploy the bot to Inframan

Read this whole file before acting. It holds what was built, verified and
decided, so nothing needs re-researching or re-asking.

## What the bot does (live-tested with the owner's friends)

In the WhatsApp group "Info alsi" (the only group in `whatsapp.groupIds`),
anyone can send `@game`: the bot makes a Smash Karts private room (region
India) and replies with the invite link, which opens the app on phones.

| Command | Room |
|---|---|
| `@game` | Nukes only, Smash Island, Free For All, 10 min rounds (a live room's link is resent) |
| `@game 20` | 20 min (lengths: 3, 6, 10, 20) |
| `@game team` / `@game 20 team` | Team Battle |
| `@game tunnels nuke mines` / `@game random all` | any of the 30 arenas, any weapons (in any order with the above) |
| `@game new …` | a fresh room even while a round runs (otherwise other settings wait for the round to end) |
| `@game help` | lists arenas, weapons and commands |
| `@start` | starts the round (only the host can, and the bot is the host) |

Every room is checked before it is posted: the weapons in the link's `wpns`
bitmask, round minutes in bits 8-15 of `mode`, Team Battle in bit 1 of `mode`,
and the arena named in the game's share message.

The host has a kart, so the bot taps steering every 20 s to avoid the idle
kick. A room is marked closed when the game-server connection drops or the bot
lands back on the main menu.

## Why move to Inframan

The cloud sandbox kills background processes after 2 hours. The bot must run
24/7. Inframan is the owner's startup's platform (docs:
https://inframan.mintlify.site/llms.txt).

## Deployment design

`main` is production: Inframan deploys every push to it. Work happens on
branches and reaches `main` through pull requests, which CI tests
(`.github/workflows/test.yml`).


- `Dockerfile`: Playwright 1.63.0 image (Chromium plus system libraries), Xvfb,
  `npm ci --omit=dev`.
- `inframan.yaml`: one `worker` service, `scaling: "off"`, `min_replicas: 1`,
  `rollout: recreate`. **Never two replicas, never blue-green**: two bots on one
  WhatsApp number would both answer `@game`. Requests 0.7 CPU / 1.5 GiB,
  limits 2 CPU / 2.5 GiB (software WebGL), to fit the `application-pool`'s
  e2-medium nodes. Those nodes are Spot: a preemption restarts the bot (the
  login is in Redis; a live room is lost).
- WhatsApp login: `src/authStore.js` keeps it in Redis when `REDIS_URL` is set
  (`connections: REDIS_URL: redis/smashbot`). The container disk is lost on
  every restart. Tested against a real Redis.
- Region: a fresh browser profile may not be on India. Before each room the
  bot reads the region badge and switches to India if needed. Verified on the
  real game that the badge reads IN at 1.000; the actual switch has not been
  exercised on the real game yet.
- `SK_PHOTON_PORT_443` is **not** needed on Inframan. It was a workaround for
  the sandbox, which blocks port 19093.
- Network capture (training data for the AI teammate) is **off** in
  production; `SK_CAPTURE_DIR` turns it on. Training runs in the sandbox.

## Steps (with the Inframan MCP connector)

1. Read the `inframan://instructions` resource first. It is the platform's own
   playbook.
2. Make sure an infrastructure exists. Prefer region `asia-south1` (Mumbai);
   the friends are in India.
3. Install the **Redis** add-on named `smashbot` **with persistence on**.
4. The secret `wa-pairing-number` = `917905878588` must be set by the owner
   (setting secret values is a person-only step).
5. Create the application from `github.com/HarshilShukla05/-game`, branch
   `main` (it has `inframan.yaml` and the `Dockerfile`). Check the node pool
   can fit 2 CPU / 4 Gi.
6. Before the first start: the **old bot must not be running**. Ask the owner;
   it may still run in the previous sandbox session until it hits its 2-hour
   limit.
7. Deploy. In the service logs, find
   `On the bot phone: ... enter XXXXXXXX`. Give the code to the owner. They
   enter it on the bot phone (+91 79058 78588): WhatsApp → Linked devices →
   Link a device → "Link with phone number instead". Codes expire in about
   2 minutes; the bot makes a new one by itself.
8. Owner sends `@game` in the group. Watch for `room_created` in the logs.

## Tests

`npm test` runs unit tests, and under `xvfb-run` end-to-end runs against
`test/fixtures/fake-game.html`. `REDIS_TEST_URL=redis://...`
adds the Redis login test.
