#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "=== Pulling latest code ==="
GIT_SSH_COMMAND="ssh -i ~/.ssh/tbdeploy -o IdentitiesOnly=yes" git pull

echo "=== Installing dependencies ==="
npm install --omit=dev

echo "=== Creating .env if missing ==="
if [ ! -f .env ]; then
  cat > .env <<'ENVEOF'
SKIP_AUTH=1
SITE_URL=https://deck-test.healthybuddy.ai
ENVEOF
  echo "Created .env with SKIP_AUTH=1"
else
  echo ".env already exists"
fi

echo "=== Loading .env ==="
set -a
source .env
set +a

echo "=== Initializing database ==="
node sqlite-init.js

echo "=== Building deck ==="
node build.js

echo "=== Killing any existing server on port 3334 ==="
kill $(lsof -ti:3334) 2>/dev/null || true
sleep 1

echo "=== Starting server ==="
echo "SKIP_AUTH=$SKIP_AUTH"
nohup node server.js > /tmp/pitch-deck.log 2>&1 &
SERVER_PID=$!
sleep 2

if kill -0 $SERVER_PID 2>/dev/null; then
  echo "=== Server running (PID $SERVER_PID) ==="
  echo "Logs: tail -f /tmp/pitch-deck.log"
  echo ""
  curl -s -o /dev/null -w "Health check: HTTP %{http_code} at http://localhost:3334/\n" http://localhost:3334/
else
  echo "=== SERVER FAILED TO START ==="
  cat /tmp/pitch-deck.log
  exit 1
fi
