#!/usr/bin/env bash
# scripts/start.sh
#
# Entrypoint for the production Docker container.
# OSRM runs as a separate Render service (netride-osrm).
# This script starts the Node backend + match/cron workers.
# Keep-alive is handled inside the Node process (app.ts) via http.get()
# because curl is not available in the Docker image.

set -euo pipefail

NODE_PORT="${NODE_PORT:-3000}"

# ---------------------------------------------------------------------------
# Start Node backend
# ---------------------------------------------------------------------------
echo "==> Starting Node backend on port ${NODE_PORT}..."
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024 --expose-gc}"
NODE_PORT="${NODE_PORT}" node ${NODE_OPTIONS} dist/app.js &
BACKEND_PID=$!

# ---------------------------------------------------------------------------
# Start match worker (processes ride matching + dispatch queue jobs)
# ---------------------------------------------------------------------------
echo "==> Starting match worker..."
node ${NODE_OPTIONS} dist/queue/matchWorker.js &
MATCH_PID=$!

# ---------------------------------------------------------------------------
# Start cron worker (stale ride cleanup + driver score refresh)
# ---------------------------------------------------------------------------
echo "==> Starting cron worker..."
node ${NODE_OPTIONS} dist/queue/cronWorker.js &
CRON_PID=$!

# ---------------------------------------------------------------------------
# Forward signals for graceful shutdown
# ---------------------------------------------------------------------------
shutdown() {
  echo "==> Shutting down..."
  kill "${BACKEND_PID}" 2>/dev/null || true
  kill "${MATCH_PID}" 2>/dev/null || true
  kill "${CRON_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "==> Shutdown complete"
  exit 0
}
trap shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# Wait for any process to exit
# ---------------------------------------------------------------------------
wait -n ${BACKEND_PID} ${MATCH_PID} ${CRON_PID}
echo "==> One process exited, shutting down all..."
shutdown
