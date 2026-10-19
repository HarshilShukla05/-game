#!/bin/bash
# Compute Engine startup script for the bot (runs as root on every boot).
# First boot: installs Node 22, Xvfb and Chromium, unpacks the code from
# gs://$BUCKET/code.tgz, and the WhatsApp login (plus the game's saved settings
# from the browser profile, e.g. region India) from gs://$BUCKET/auth.tgz once
# it is there. Every boot: (re)starts the systemd service. Logs also go to the
# serial console, readable with `gcloud compute instances get-serial-port-output`.
set -euo pipefail
exec > >(tee -a /var/log/smashbot-setup.log > /dev/ttyS0) 2>&1

META=http://metadata.google.internal/computeMetadata/v1/instance/attributes
BUCKET=$(curl -fsS -H "Metadata-Flavor: Google" "$META/smashbot-bucket")
PAIRING=$(curl -fsS -H "Metadata-Flavor: Google" "$META/smashbot-pairing-number" || true)
APP=/opt/smashbot
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

if [ ! -f "$APP/.installed" ]; then
  echo "smashbot: installing"
  apt-get update -q
  apt-get install -yq curl ca-certificates xvfb xauth
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
  id smashbot >/dev/null 2>&1 || useradd -m -s /bin/bash smashbot
  mkdir -p "$APP"
  gcloud storage cp "gs://$BUCKET/code.tgz" /tmp/code.tgz
  tar xzf /tmp/code.tgz -C "$APP"
  cd "$APP"
  npm ci --omit=dev
  npx playwright install --with-deps chromium
  chown -R smashbot:smashbot "$APP" /opt/pw-browsers
  touch "$APP/.installed"
fi

if [ ! -d "$APP/auth" ]; then
  echo "smashbot: waiting for the WhatsApp login (gs://$BUCKET/auth.tgz)"
  for _ in $(seq 1 360); do
    gcloud storage cp "gs://$BUCKET/auth.tgz" /tmp/auth.tgz 2>/dev/null && break
    sleep 10
  done
  if [ -f /tmp/auth.tgz ]; then
    tar xzf /tmp/auth.tgz -C "$APP" && rm -f /tmp/auth.tgz
    chown -R smashbot:smashbot "$APP/auth"
  fi
fi

cat > /etc/systemd/system/smashbot.service <<UNIT
[Unit]
Description=Smash Karts WhatsApp bot
After=network-online.target
Wants=network-online.target

[Service]
User=smashbot
WorkingDirectory=$APP
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
Environment=WA_PAIRING_NUMBER=$PAIRING
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1920x1080x24" /usr/bin/node src/index.js
Restart=always
RestartSec=10
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable smashbot
systemctl restart smashbot
echo "smashbot: service started"
