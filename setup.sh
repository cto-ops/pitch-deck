#!/bin/bash
# Fresh VPS bootstrap. Run from anywhere:
#   curl -sL <raw-url> | bash
# Or copy to VPS and run: bash setup.sh
set -e

REPO=git@github.com:cto-ops/pitch-deck.git
DIR=/root/pitch-deck
KEY=~/.ssh/tbdeploy
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes"

echo "=== Cleaning old install ==="
fuser -k 3334/tcp 2>/dev/null || true
sleep 1
rm -rf "$DIR"

echo "=== Cloning ==="
git clone "$REPO" "$DIR"
cd "$DIR"

echo "=== Installing deps ==="
npm install --omit=dev

echo "=== Creating .env ==="
cat > .env <<'EOF'
SKIP_AUTH=1
SITE_URL=https://deck-test.healthybuddy.ai
EOF

echo "=== Init DB ==="
node sqlite-init.js

echo "=== Building deck ==="
node build.js

echo "=== Starting server ==="
export SKIP_AUTH=1
nohup node server.js > /tmp/pitch-deck.log 2>&1 &
PID=$!
sleep 2

if kill -0 $PID 2>/dev/null; then
  echo ""
  echo "========================================="
  echo " Server running (PID $PID)"
  echo " Auth: DISABLED (ZTNA handles access)"
  echo " Logs: tail -f /tmp/pitch-deck.log"
  echo "========================================="
  echo ""
  curl -s -o /dev/null -w "Health check: HTTP %{http_code}\n" http://localhost:3334/
else
  echo "FAILED:"
  cat /tmp/pitch-deck.log
  exit 1
fi
