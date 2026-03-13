#!/bin/bash
# Update and restart. Run from repo dir: ./getit.sh
set -e
cd "$(dirname "$0")"

export GIT_SSH_COMMAND="ssh -i ~/.ssh/tbdeploy -o IdentitiesOnly=yes"
git pull

npm install --omit=dev

# Auth auto-disables when RESEND_API_KEY is not set (no .env needed)
node sqlite-init.js
node build.js

fuser -k 3334/tcp 2>/dev/null || true
sleep 1

nohup node server.js > /tmp/pitch-deck.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "Health check: HTTP %{http_code}\n" http://localhost:3334/
