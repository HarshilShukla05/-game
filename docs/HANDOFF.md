# Handoff: deploy the bot to Inframan

Read this whole file before acting. It holds what was built, verified and
decided, so nothing needs re-researching or re-asking.

## What the bot does (live-tested with the owner's friends)

In the WhatsApp group "Info alsi", `@game` makes a Smash Karts private room
(Nukes only, Smash Island, region India) and replies with the invite link,
which opens the app on phones.

| Command | Room |
|---|---|
| `@game` | Free For All, 10 min rounds (a live room's link is resent) |
| `@game 20` | 20 min (lengths: 3, 6, 10, 20) |
| `@game team` / `@game 20 team` | Team Battle |
| `@start` | starts the round (only the host can, and the bot is the host) |

Every link is checked before it is posted: `arena=smashisland`, `wpns=256`,
round minutes in bits 8-15 of `mode`, Team Battle in bit 1 of `mode`.

The host cannot spectate (no such option for the host), so the bot keeps a
kart and taps steering every 20 s to avoid the idle kick. It also marks a room
closed if it lands back on the main menu.

## Why move to Inframan

The cloud sandbox kills background processes after 2 hours. The bot must run
24/7. Inframan is the owner's startup's platform (docs:
https://inframan.mintlify.site/llms.txt).

## Deployment design (files on branch `claude/confident-archimedes-i18vzi`)

- `Dockerfile`: Playwright 1.63.0 image (Chromium plus system libraries), Xvfb,
  `npm ci --omit=dev`. An optional build secret `ca` is only for building behind
  the sandbox's TLS proxy; Inframan's builder does not need it.
- `inframan.yaml`: one `worker` service, `scaling: "off"`, `min_replicas: 1`,
  `rollout: recreate`. **Never two replicas, never blue-green**: two bots on one
  WhatsApp number would both answer `@game`. CPU 1-2, memory 2-4 Gi
  (software WebGL).
- WhatsApp login: `src/authStore.js` keeps it in Redis when `REDIS_URL` is set
  (`connections: REDIS_URL: redis/smashbot`). The container disk is lost on
  every restart. Tested against a real Redis.
- Region: a fresh browser profile may not be on India. Before each room the
  bot reads the region badge and switches to India if needed. Verified on the
  real game that the badge reads IN at 1.000; the actual switch has not been
  exercised on the real game yet.
- `SK_PHOTON_PORT_443` is **not** needed on Inframan. It was a workaround for
  the sandbox, which blocks port 19093.

## Steps (with the Inframan MCP connector)

1. Read the `inframan://instructions` resource first. It is the platform's own
   playbook.
2. Make sure an infrastructure exists. Prefer region `asia-south1` (Mumbai);
   the friends are in India.
3. Install the **Redis** add-on named `smashbot` **with persistence on**.
4. The secret `wa-pairing-number` = `917905878588` must be set by the owner
   (setting secret values is a person-only step).
5. Create the application from `github.com/HarshilShukla05/-game`, branch
   `claude/confident-archimedes-i18vzi` (it has `inframan.yaml` and the
   `Dockerfile`). Check the node pool can fit 2 CPU / 4 Gi.
6. Before the first start: the **old bot must not be running**. Ask the owner;
   it may still run in the previous sandbox session until it hits its 2-hour
   limit.
7. Deploy. In the service logs, find
   `On the bot phone: ... enter XXXXXXXX`. Give the code to the owner. They
   enter it on the bot phone (+91 79058 78588): WhatsApp → Linked devices →
   Link a device → "Link with phone number instead". Codes expire in about
   2 minutes; the bot makes a new one by itself.
8. Owner sends `@game` in the group. Watch for `room_created` in the logs.
9. Optional: lock the bot to the group via `config.json` `whatsapp.groupIds` =
   `["120363043845509965@g.us"]` (ask the owner first).

## Tests

`npm test` gives 18 tests: unit, plus end-to-end against
`test/fixtures/fake-game.html` under `xvfb-run`. `REDIS_TEST_URL=redis://...`
adds the Redis login test.
