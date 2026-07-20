#!/usr/bin/env bash
# Rebuild the pre-baked CH road network (backend/data/la.osrm) from the local
# OSM extract. Requires Docker. The resulting file is committed via Git LFS.
set -euo pipefail

REGION="${REGION:-la}"
PBF="${1:-data/LosAngeles.osm.pbf}"
OUT="data/${REGION}.osrm"

if [ ! -f "$PBF" ]; then
  echo "ERROR: extract not found at $PBF"
  echo "Download the LA BBBike extract first:"
  echo "  wget -O $PBF https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf"
  exit 1
fi

echo "==> Building CH road network from $PBF into $OUT"
docker run --rm -v "$(pwd)/data:/data" ghcr.io/project-osrm/osrm-backend:latest \
  sh -c "cd /data && osrm-extract -p /opt/car.lua $(basename "$PBF") && osrm-contract $(basename "$OUT")"

echo "==> Done. Commit the updated la.osrm (Git LFS will store the blob):"
echo "  git add data/la.osrm && git commit -m 'chore: rebuild OSRM road network' && git push"
