#!/usr/bin/env bash
# Deploy cc-mp (Clockwork Climb multiplayer / Colyseus) to the droplet.
#
# - Builds locally (server/cc-mp/dist).
# - Backs up the live deployment if present.
# - Uploads dist + package manifests.
# - On the droplet: install prod-only deps, restart pm2 process `cc-mp`, save.
# - Smoke-tests https://mp.tommyato.com/health.
#
# Idempotent. Safe to re-run.

set -euo pipefail

SSH_KEY="${SSH_KEY:-/Users/tommyato/.config/tommyato/ssh/id_ed25519}"
HOST="${HOST:-root@67.205.167.181}"
REMOTE_DIR="/root/cc-mp"
LOCAL_DIR="server/cc-mp"

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "error: $LOCAL_DIR not found — run this from the project root" >&2
  exit 1
fi
if [[ ! -f "$SSH_KEY" ]]; then
  echo "error: ssh key not found at $SSH_KEY" >&2
  exit 1
fi

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $HOST"
SCP="scp -i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> [1/5] build (server/cc-mp)"
( cd "$LOCAL_DIR" && npm install && npm run build )
if [[ ! -f "$LOCAL_DIR/dist/index.js" ]]; then
  echo "error: build did not produce dist/index.js" >&2
  exit 1
fi

echo "==> [2/5] backup current deployment (if any)"
$SSH "if [ -d $REMOTE_DIR ]; then cp -r $REMOTE_DIR ${REMOTE_DIR}.bak-\$(date +%Y%m%d-%H%M); fi; mkdir -p $REMOTE_DIR"

echo "==> [3/5] upload"
# Uploading dist as a single tree, plus package manifests for prod install.
$SSH "rm -rf $REMOTE_DIR/dist"
$SCP -r "$LOCAL_DIR/dist" "$HOST:$REMOTE_DIR/dist"
$SCP "$LOCAL_DIR/package.json" "$HOST:$REMOTE_DIR/package.json"
if [[ -f "$LOCAL_DIR/package-lock.json" ]]; then
  $SCP "$LOCAL_DIR/package-lock.json" "$HOST:$REMOTE_DIR/package-lock.json"
fi

echo "==> [4/5] install prod deps + (re)start pm2 cc-mp"
$SSH "
  set -e
  cd $REMOTE_DIR
  npm install --omit=dev
  if pm2 describe cc-mp >/dev/null 2>&1; then
    pm2 restart cc-mp --update-env
  else
    pm2 start dist/index.js --name cc-mp
  fi
  pm2 save
"

echo "==> [5/5] smoke https://mp.tommyato.com/health"
# LE may take ~5s on a brand-new domain — retry up to 6x.
for i in 1 2 3 4 5 6; do
  body=$(curl -fsS --max-time 8 https://mp.tommyato.com/health 2>/dev/null || true)
  if [[ "$body" == *'"ok":true'* ]]; then
    echo "OK: $body"
    exit 0
  fi
  echo "  attempt $i: $body — retrying in 5s"
  sleep 5
done
echo "error: smoke test failed (no {\"ok\":true} from mp.tommyato.com)" >&2
exit 1
