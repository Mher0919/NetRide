#!/usr/bin/env bash
# scripts/start.sh
#
# Entrypoint for the production Docker container.
# OSRM now runs as a separate Render service (netride-osrm).
# This script only starts the Node backend.
#
# Environment variables (with defaults):
#   NODE_PORT  — port the Node backend listens on (default: 3000)

set -euo pipefail

NODE_PORT="${NODE_PORT:-3000}"

# ---------------------------------------------------------------------------
# Start Node backend
# ---------------------------------------------------------------------------
echo "==> Starting Node backend on port ${NODE_PORT}..."
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024 --expose-gc}"
NODE_PORT="${NODE_PORT}" node ${NODE_OPTIONS} dist/app.js &
NODE_PID=$!

# ---------------------------------------------------------------------------
# Forward signals for graceful shutdown
# ---------------------------------------------------------------------------
shutdown() {
  echo "==> Shutting down..."
  kill "${NODE_PID}" 2>/dev/null || true
  wait "${NODE_PID}" 2>/dev/null || true
  echo "==> Shutdown complete"
  exit 0
}
trap shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# Wait for the process to exit
# ---------------------------------------------------------------------------
wait
