import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Custom icons using CDN for reliability in Vite environment
const driverIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3063/3063822.png',
  iconSize: [32, 32],
  iconAnchor: [16, 16]
});

const pickupIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/1216/1216733.png',
  iconSize: [32, 32],
  iconAnchor: [16, 32]
});

const destinationIcon = L.icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/684/684908.png',
  iconSize: [32, 32],
  iconAnchor: [16, 32]
});

interface RideMapProps {
  pickup?: { lat: number; lng: number; address?: string };
  destination?: { lat: number; lng: number; address?: string };
  driverLocation?: { lat: number; lng: number };
  trajectory?: { lat: number; lng: number; t?: string }[];
  live?: boolean;
}

const FitBounds: React.FC<{ bounds: L.LatLngBoundsExpression }> = ({ bounds }) => {
  const map = useMap();
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [bounds, map]);
  return null;
};

const RideMap: React.FC<RideMapProps> = ({ pickup, destination, driverLocation, trajectory = [], live = false }) => {
  const [bounds, setBounds] = useState<L.LatLngBoundsExpression | null>(null);

  useEffect(() => {
    const points: [number, number][] = [];
    if (pickup) points.push([pickup.lat, pickup.lng]);
    if (destination) points.push([destination.lat, destination.lng]);
    if (driverLocation) points.push([driverLocation.lat, driverLocation.lng]);
    if (trajectory.length > 0) {
      trajectory.forEach(p => points.push([p.lat, p.lng]));
    }

    if (points.length > 0) {
      const b = L.latLngBounds(points);
      setBounds(b.pad(0.1) as any);
    }
  }, [pickup, destination, driverLocation, trajectory.length]);

  const polylinePoints = trajectory.map(p => [p.lat, p.lng] as [number, number]);

  return (
    <MapContainer 
      center={[pickup?.lat || 34.0522, pickup?.lng || -118.2437]} 
      zoom={13} 
      style={{ height: '100%', width: '100%', borderRadius: '8px' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      
      {pickup && (
        <Marker position={[pickup.lat, pickup.lng]} icon={pickupIcon}>
          <Popup>Pickup: {pickup.address || 'Location'}</Popup>
        </Marker>
      )}

      {destination && (
        <Marker position={[destination.lat, destination.lng]} icon={destinationIcon}>
          <Popup>Destination: {destination.address || 'Location'}</Popup>
        </Marker>
      )}

      {driverLocation && (
        <Marker position={[driverLocation.lat, driverLocation.lng]} icon={driverIcon}>
          <Popup>Current Driver Location</Popup>
        </Marker>
      )}

      {polylinePoints.length > 1 && (
        <Polyline 
          positions={polylinePoints} 
          color="#3f51b5" 
          weight={4} 
          opacity={0.7} 
          dashArray={live ? "5, 10" : undefined}
        />
      )}

      {bounds && <FitBounds bounds={bounds} />}
    </MapContainer>
  );
};

export default RideMap;
