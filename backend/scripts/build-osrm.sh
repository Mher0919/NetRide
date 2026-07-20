#!/usr/bin/env bash
#
# scripts/build-osrm.sh
#
# Builds the in-process OSRM road-network extract for the NetRide routing
# engine. The result (data/socal.osrm) is loaded at runtime by
# src/modules/routing/local-osrm.engine.ts via @osrm/osrm — no separate
# routing service required.
#
# Region: Los Angeles area (default) — lightweight BBBike extract (~203MB),
# full road detail, builds comfortably on free-tier RAM (vs 666MB SoCal).
#   To target a larger area, override OSM_PBF (a .osm.pbf URL) and the
#   output filename. e.g.  OSM_PBF=https://.../socal-latest.osm.pbf \
#                          OUTPUT=./data/socal.osrm ./scripts/build-osrm.sh
#
# Requirements (only needed at BUILD time, not at runtime):
#   - osrm-backend (the `osrm-extract`, `osrm-partition`, `osrm-customize`
#     CLI tools) on PATH, OR the Docker image `ghcr.io/project-osrm/osrm-backend`.
#   - curl/wget, and ~3GB free disk for the working set.
#
# The produced .osrm is baked into the Docker image (see Dockerfile) so the
# running container needs no network access to route — sub-50ms, Google-level
# geometry, free tier friendly.

set -euo pipefail

# ---- Configuration ---------------------------------------------------------
REGION="${REGION:-la}"
# Lightweight, verified-live Los Angeles-area extract (BBBike).
OSM_PBF="${OSM_PBF:-https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf}"
OUT_DIR="${OUT_DIR:-./data}"
OUTPUT="${OUTPUT:-${OUT_DIR}/${REGION}.osrm}"
PROFILE="${PROFILE:-./scripts/car.lua}"

mkdir -p "${OUT_DIR}"

echo "==> Building OSRM extract for ${REGION}"
echo "    source : ${OSM_PBF}"
echo "    output : ${OUTPUT}"

# ---- Fetch the PBF (skipped if already present) ----------------------------
PBF_PATH="${OUT_DIR}/${REGION}.osm.pbf"
if [ ! -f "${PBF_PATH}" ]; then
  echo "==> Downloading OSM extract..."
  curl -L -o "${PBF_PATH}" "${OSM_PBF}"
else
  echo "==> Reusing existing ${PBF_PATH}"
fi

# ---- Use Dockerized OSRM if the CLI tools aren't on PATH -------------------
if ! command -v osrm-extract >/dev/null 2>&1; then
  echo "==> osrm-extract not on PATH — using ghcr.io/project-osrm/osrm-backend"
  OSRM_RUN="docker run --rm -v $(pwd):/data -w /data ghcr.io/project-osrm/osrm-backend"
  # Pull the default car profile if we don't ship one locally.
  if [ ! -f "${PROFILE}" ]; then
    curl -L -o "${PROFILE}" https://raw.githubusercontent.com/Project-OSRM/osrm-backend/master/profiles/car.lua
  fi
else
  OSRM_RUN=""
fi

echo "==> Extracting..."
${OSRM_RUN} osrm-extract -p "${PROFILE}" "${PBF_PATH}"
echo "==> Partitioning..."
${OSRM_RUN} osrm-partition "${PBF_PATH%.osm.pbf}.osrm"
echo "==> Customizing..."
${OSRM_RUN} osrm-customize "${PBF_PATH%.osm.pbf}.osrm"

# Move the final artifact to the configured output path.
if [ "${PBF_PATH%.osm.pbf}.osrm" != "${OUTPUT}" ]; then
  mv "${PBF_PATH%.osm.pbf}.osrm" "${OUTPUT}"
fi

echo "==> Done. Baked road network: ${OUTPUT}"
echo "    Set OSRM_DATA_PATH=${OUTPUT} (default already points here) and deploy."
