# osrm/Dockerfile
#
# Self-hosted OSRM routing service for Los Angeles only.
# Uses Contraction Hierarchies (CH) algorithm — ~300 MB RAM vs MLD's 1.5 GB.
#
# Builds the LA road network from BBBike OSM extract during docker build,
# then runs osrm-routed at runtime on a 512 MB Render service.
#
# API: standard OSRM HTTP interface
#   GET /route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=polyline6&steps=true
#   GET /nearest/v1/driving/{lng},{lat}

FROM ghcr.io/project-osrm/osrm-backend:v5.27.1 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /data

# Download Los Angeles OSM extract (~200MB compressed).
# BBBike LA extract covers LA, Orange, Ventura, San Bernardino, Riverside.
RUN curl -L -o la.osm.pbf \
    https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf

# Pre-process with CH: extract → contract (no partition/customize needed).
RUN osrm-extract -p /opt/car.lua la.osm.pbf
RUN osrm-contract la.osrm

# Clean up the source PBF.
RUN rm la.osm.pbf

# ---- Runtime: minimal image with just the binary + data ---------------------
FROM ghcr.io/project-osrm/osrm-backend:v5.27.1

WORKDIR /data
COPY --from=builder /data/la.osrm.* ./

EXPOSE 5000

# CH algorithm, 4 threads for concurrent requests.
CMD ["osrm-routed", \
     "--algorithm", "ch", \
     "--threading", "4", \
     "--max-table-size", "0", \
     "--max-trip-size", "0", \
     "la.osrm"]
