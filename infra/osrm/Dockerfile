FROM osrm/osrm-backend:v5.27.1 AS extract

WORKDIR /data

# Download LA metro extract (203MB)
ADD https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf /data/la.osm.pbf

# Extract car profile
RUN osrm-extract -p /opt/car.lua /data/la.osm.pbf

# Partition and customize (MLD algorithm)
RUN osrm-partition /data/la.osrm
RUN osrm-customize /data/la.osrm

FROM osrm/osrm-backend:v5.27.1

COPY --from=extract /data/ /data/

EXPOSE 5000

CMD ["osrm-routed", "--algorithm", "mld", "/data/la.osrm"]
