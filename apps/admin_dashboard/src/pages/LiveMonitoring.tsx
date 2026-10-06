import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Chip,
  Button,
  CircularProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { MapContainer, TileLayer, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getLiveDrivers } from '../api/admin';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000';

// Same basemap the rider/driver mobile apps use, so ops sees the exact same
// map style as the fleet.
const TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}';

// Dots only — no names, no popups. Everyone online is the same red marker.
const DOT_COLOR = '#C65A5A';

/**
 * Fits the camera to all online drivers exactly ONCE per mount. Subsequent
 * live location updates move the dots without yanking the admin's viewport
 * around (a re-fit on every ping made the map unusable).
 */
const FitDriversOnce: React.FC<{ drivers: any[] }> = ({ drivers }) => {
  const map = useMap();
  const fittedRef = useRef(false);

  useEffect(() => {
    if (fittedRef.current || drivers.length === 0) return;
    fittedRef.current = true;
    const bounds = L.latLngBounds(
      drivers.map((d) => [d.lat, d.lng] as [number, number]),
    );
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }, [drivers, map]);

  return null;
};

const LiveMonitoring: React.FC = () => {
  const [drivers, setDrivers] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDrivers = async () => {
    setRefreshing(true);
    try {
      const data = await getLiveDrivers();
      setDrivers(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to fetch live drivers:', error);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDrivers();

    const socket = io(API_URL, {
      auth: { token: localStorage.getItem('admin_token') },
    });

    socket.on('connect', () => {
      socket.emit('subscribeToMonitoring');
    });

    socket.on('driverLocationUpdate', (data: any) => {
      setDrivers((prev) => {
        const index = prev.findIndex((d) => d.id === data.driverId);
        if (index !== -1) {
          const next = [...prev];
          next[index] = { ...next[index], lat: data.lat, lng: data.lng };
          return next;
        }
        // A location ping for an unknown driver means someone just came
        // online between polls — show their dot immediately.
        return [
          ...prev,
          {
            id: data.driverId,
            lat: data.lat,
            lng: data.lng,
            status: 'AVAILABLE',
          },
        ];
      });
    });

    socket.on('tripUpdate', () => {
      fetchDrivers();
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        // Desktop: fill the viewport under the app bar. Phones: let the page
        // scroll and give the map a comfortable fixed share of the screen.
        height: { xs: 'auto', md: 'calc(100vh - 160px)' },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: { xs: 'flex-start', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2,
        }}
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Live Dispatch
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
            <Chip
              label={`${drivers.length} online`}
              size="small"
              sx={{ fontWeight: 800, bgcolor: DOT_COLOR, color: 'white', height: 22 }}
            />
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
              Real-time driver positions
            </Typography>
          </Box>
        </Box>
        <Button
          startIcon={refreshing ? undefined : <RefreshIcon />}
          onClick={fetchDrivers}
          variant="contained"
          disabled={refreshing}
          sx={{ borderRadius: '12px', flexShrink: 0 }}
        >
          {refreshing ? <CircularProgress size={20} color="inherit" /> : 'Refresh'}
        </Button>
      </Box>

      <Paper
        sx={{
          flexGrow: 1,
          minHeight: 0,
          // Phone: 65% of the viewport is a normal, usable map size.
          height: { xs: '65vh', md: 'auto' },
          borderRadius: 4,
          overflow: 'hidden',
          border: 'none',
          position: 'relative',
        }}
      >
        <MapContainer
          center={[34.0522, -118.2437]}
          zoom={11}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            url={TILE_URL}
            maxZoom={18}
            maxNativeZoom={16}
            attribution="Tiles &copy; Esri"
          />
          {drivers.map((driver) => (
            <CircleMarker
              key={driver.id}
              center={[driver.lat, driver.lng]}
              radius={7}
              pathOptions={{
                color: '#ffffff',
                weight: 2,
                fillColor: DOT_COLOR,
                fillOpacity: 1,
              }}
            />
          ))}
          <FitDriversOnce drivers={drivers} />
        </MapContainer>
      </Paper>
    </Box>
  );
};

export default LiveMonitoring;
