# Smash Karts WhatsApp bot. Runs headed Chromium on a virtual display (the
# game's WebGL is unreliable headless). The Playwright image ships Chromium and
# its system libraries for the exact Playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Optional build secret "ca": an extra CA for builds behind a TLS-inspecting
# proxy. Absent on normal builders; never stored in the image.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --omit=dev
COPY config.json ./
COPY src ./src
COPY recordings ./recordings

ENV NODE_ENV=production
# The browser profile and logs live here; the WhatsApp login goes to Redis
# when REDIS_URL is set, so nothing here needs to survive a restart.
VOLUME ["/app/data", "/app/profile"]
CMD ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24", "node", "src/index.js"]
