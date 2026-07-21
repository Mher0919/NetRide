#!/usr/bin/env bash
# scripts/start.sh
#
# Entrypoint for the production Docker container.
# OSRM runs as a separate Render service (netride-osrm).
# This script starts the Node backend + match/cron workers.

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
  kill "${KEEPALIVE_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "==> Shutdown complete"
  exit 0
}
trap shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# Wait for any process to exit
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Keep-alive: ping self + OSRM every 2 minutes to prevent Render free-tier
# spin-down. Without this the service goes to sleep after ~60 s idle,
# killing all active socket connections.
# ---------------------------------------------------------------------------
echo "==> Starting backend self-keep-alive (every 60s)..."
while true; do
  sleep 60
  curl -sf "http://localhost:${NODE_PORT}/health/live" > /dev/null 2>&1 || \
    echo "[KEEPALIVE] Self-ping failed"
  if [ -n "${OSRM_BASE_URL:-}" ]; then
    curl -sf "${OSRM_BASE_URL}/health" > /dev/null 2>&1 || \
      echo "[KEEPALIVE] OSRM ping failed (may be spinning up)"
  fi
done &
KEEPALIVE_PID=$!

# ---------------------------------------------------------------------------
# Wait for any process to exit
# ---------------------------------------------------------------------------
wait -n ${BACKEND_PID} ${MATCH_PID} ${CRON_PID}
echo "==> One process exited, shutting down all..."
shutdown
