#!/usr/bin/env bash
# Rebuild the pre-baked CH road network (backend/data/la.osrm + sidecars) from
# the local OSM extract. Requires Docker. The resulting files are committed via
# Git LFS so future Docker builds just COPY them (no 8-min extract/contract).
set -euo pipefail

REGION="${REGION:-la}"
PBF="${1:-data/LosAngeles.osm.pbf}"
WORK="$(pwd)/data"

if [ ! -f "$PBF" ]; then
  echo "ERROR: extract not found at $PBF"
  echo "Download the LA BBBike extract first:"
  echo "  wget -O $PBF https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf"
  exit 1
fi

echo "==> Building CH road network from $PBF into $WORK/${REGION}.osrm*"
docker run --rm -v "$WORK:/data" ghcr.io/project-osrm/osrm-backend:latest \
  sh -c "cd /data && osrm-extract -p /opt/car.lua $(basename "$PBF") && osrm-contract $(basename "$REGION").osrm && touch $(basename "$REGION").osrm"

echo "==> Done. Commit the updated ${REGION}.osrm family (Git LFS stores the blobs):"
echo "  git add data/${REGION}.osrm* && git commit -m 'chore: rebuild OSRM road network' && git push"
