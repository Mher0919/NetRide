#!/usr/bin/env bash
# scripts/start.sh
#
# Entrypoint for the production Docker container. Starts two processes:
#   1. osrm-routed — serves the LA OSRM road network on port 5000
#   2. Node backend — serves the API on port 3000
#
# osrm-routed starts in the background. The script waits for it to be ready
# before launching Node, so routing requests never hit a cold OSRM.
#
# Environment variables (with defaults):
#   OSRM_DATA_PATH  — path to the .osrm file (default: ./data/LosAngeles.osrm)
#   OSRM_ALGORITHM  — MLD (multi-level) or CH (contraction-hierarchy) (default: mld)
#   OSRM_PORT       — port osrm-routed listens on (default: 5000)
#   NODE_PORT       — port the Node backend listens on (default: 3000)

set -euo pipefail

OSRM_DATA_PATH="${OSRM_DATA_PATH:-./data/la.osrm}"
OSRM_ALGORITHM="${OSRM_ALGORITHM:-mld}"
OSRM_PORT="${OSRM_PORT:-5000}"
NODE_PORT="${NODE_PORT:-3000}"

# ---------------------------------------------------------------------------
# 1. Start OSRM sidecar
# ---------------------------------------------------------------------------
echo "==> Starting osrm-routed (${OSRM_ALGORITHM}) with ${OSRM_DATA_PATH} on port ${OSRM_PORT}..."

osrm-routed \
  --algorithm "${OSRM_ALGORITHM}" \
  --port "${OSRM_PORT}" \
  "${OSRM_DATA_PATH}" &
OSRM_PID=$!

# Wait for OSRM to be ready (up to 30 seconds).
echo "==> Waiting for OSRM to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${OSRM_PORT}/route/v1/driving/-118.4455,34.0639;-118.4400,34.0700?overview=simplified" > /dev/null 2>&1; then
    echo "==> OSRM ready (attempt ${i})"
    break
  fi
  if [ "${i}" -eq 30 ]; then
    echo "==> WARNING: OSRM did not become ready within 30s. Starting backend anyway."
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 2. Start Node backend
# ---------------------------------------------------------------------------
echo "==> Starting Node backend on port ${NODE_PORT}..."
# Cap V8 heap at 768 MB to prevent OOM (standard Render plan = 2 GB RAM,
# leaving headroom for OSRM + OS + TensorFlow native bindings).
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=768}"
NODE_PORT="${NODE_PORT}" node ${NODE_OPTIONS} dist/app.js &
NODE_PID=$!

# ---------------------------------------------------------------------------
# 3. Forward signals to child processes for graceful shutdown
# ---------------------------------------------------------------------------
shutdown() {
  echo "==> Shutting down..."
  kill "${NODE_PID}" 2>/dev/null || true
  kill "${OSRM_PID}" 2>/dev/null || true
  wait "${NODE_PID}" 2>/dev/null || true
  wait "${OSRM_PID}" 2>/dev/null || true
  echo "==> Shutdown complete"
  exit 0
}
trap shutdown SIGTERM SIGINT

# ---------------------------------------------------------------------------
# 4. Wait for either process to exit
# ---------------------------------------------------------------------------
wait
