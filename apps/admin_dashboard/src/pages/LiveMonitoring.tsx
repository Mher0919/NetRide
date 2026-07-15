import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  Avatar,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Divider,
  Button,
  CircularProgress
} from '@mui/material';
import Grid from '@mui/material/Grid';
import TaxiIcon from '@mui/icons-material/LocalTaxi';
import RefreshIcon from '@mui/icons-material/Refresh';
import StatusIcon from '@mui/icons-material/Circle';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { getLiveDrivers } from '../api/admin';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000';

const driverIcon = (status: string) => L.icon({
  iconUrl: status === 'BUSY' 
    ? 'https://cdn-icons-png.flaticon.com/512/3063/3063822.png'
    : 'https://cdn-icons-png.flaticon.com/512/3063/3063822.png',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  className: status === 'BUSY' ? 'marker-busy' : 'marker-available'
});

const FitDrivers: React.FC<{ drivers: any[] }> = ({ drivers }) => {
  const map = useMap();
  useEffect(() => {
    if (drivers.length > 0) {
      const bounds = L.latLngBounds(drivers.map(d => [d.lat, d.lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
  }, [drivers.length, map]);
  return null;
};

const LiveMonitoring: React.FC = () => {
  const [drivers, setDrivers] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDrivers = async () => {
    setRefreshing(true);
    try {
      const data = await getLiveDrivers();
      setDrivers(data);
    } catch (error) {
      console.error('Failed to fetch live drivers:', error);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDrivers();

    const socket = io(API_URL, {
      auth: { token: localStorage.getItem('admin_token') }
    });

    socket.on('connect', () => {
      socket.emit('subscribeToMonitoring');
    });

    socket.on('driverLocationUpdate', (data: any) => {
      setDrivers(prev => {
        const index = prev.findIndex(d => d.id === data.driverId);
        if (index !== -1) {
          const newDrivers = [...prev];
          newDrivers[index] = { ...newDrivers[index], lat: data.lat, lng: data.lng };
          return newDrivers;
        }
        return prev;
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
    <Box sx={{ height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Live Dispatch
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
            Real-time driver positions and status tracking
          </Typography>
        </Box>
        <Button 
          startIcon={refreshing ? undefined : <RefreshIcon />} 
          onClick={async () => { setRefreshing(true); try { await fetchDrivers(); } finally { setRefreshing(false); } }} 
          variant="contained"
          disabled={refreshing}
          sx={{ borderRadius: '12px' }}
        >
          {refreshing ? <CircularProgress size={20} color="inherit" /> : 'Refresh Dispatch'}
        </Button>
      </Box>

      <Grid container spacing={3} sx={{ flexGrow: 1, minHeight: 0 }} {...({ component: 'div' } as any)}>
        <Grid item xs={12} lg={9} sx={{ height: '100%' }} {...({ component: 'div' } as any)}>
          <Paper sx={{ height: '100%', p: 0, borderRadius: 4, overflow: 'hidden', border: 'none' }}>
            <MapContainer center={[34.0522, -118.2437]} zoom={11} style={{ height: '100%', width: '100%' }}>
              <TileLayer 
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png" 
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              />
              {drivers.map(driver => (
                <Marker 
                  key={driver.id} 
                  position={[driver.lat, driver.lng]} 
                  icon={driverIcon(driver.status)}
                >
                  <Popup>
                    <Box sx={{ p: 1 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{driver.info?.full_name}</Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', mt: 1, gap: 1 }}>
                        <StatusIcon sx={{ fontSize: 10, color: driver.status === 'BUSY' ? 'primary.main' : 'success.main' }} />
                        <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                          {driver.status}
                        </Typography>
                      </Box>
                      {driver.activeTripId && (
                        <Button 
                          size="small" 
                          variant="contained" 
                          sx={{ mt: 1.5, height: 24, fontSize: '0.65rem' }}
                          onClick={() => window.location.href = `/rides/${driver.activeTripId}`}
                        >
                          View Ride
                        </Button>
                      )}
                    </Box>
                  </Popup>
                </Marker>
              ))}
              <FitDrivers drivers={drivers} />
            </MapContainer>
          </Paper>
        </Grid>

        <Grid item xs={12} lg={3} sx={{ height: '100%' }} {...({ component: 'div' } as any)}>
          <Paper sx={{ height: '100%', borderRadius: 4, display: 'flex', flexDirection: 'column', border: 'none', overflow: 'hidden' }}>
            <Box sx={{ p: 3, borderBottom: '1px solid rgba(0,0,0,0.05)', bgcolor: '#fafafa' }}>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                Online Drivers 
                <Chip 
                  label={drivers.length} 
                  size="small" 
                  sx={{ ml: 1.5, fontWeight: 800, bgcolor: 'primary.main', color: 'white', height: 20 }} 
                />
              </Typography>
            </Box>
            <Box sx={{ flexGrow: 1, overflow: 'auto', bgcolor: 'white' }}>
              <List sx={{ p: 0 }}>
                {drivers.map((driver, index) => (
                  <React.Fragment key={driver.id}>
                    <ListItem 
                      alignItems="flex-start" 
                      sx={{ 
                        py: 2, 
                        px: 3, 
                        transition: 'background-color 0.2s',
                        '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' }
                      }}
                    >
                      <ListItemAvatar>
                        <Avatar sx={{ bgcolor: driver.status === 'BUSY' ? 'primary.main' : 'success.main', width: 40, height: 40 }}>
                          <TaxiIcon sx={{ fontSize: 20 }} />
                        </Avatar>
                      </ListItemAvatar>
                      <ListItemText
                        primary={
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>
                            {driver.info?.full_name || 'Unknown Driver'}
                          </Typography>
                        }
                        secondary={
                          <Box sx={{ mt: 0.5 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center' }}>
                              <StatusIcon sx={{ fontSize: 8, mr: 1, color: driver.status === 'BUSY' ? 'primary.main' : 'success.main' }} />
                              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                {driver.status}
                              </Typography>
                            </Box>
                            {driver.activeTripId && (
                              <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'primary.main', fontWeight: 500, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }} onClick={() => window.location.href = `/rides/${driver.activeTripId}`}>
                                Active Trip: #{driver.activeTripId.substring(0, 8)}
                              </Typography>
                            )}
                          </Box>
                        }
                      />
                    </ListItem>
                    {index < drivers.length - 1 && <Divider component="li" sx={{ opacity: 0.5 }} />}
                  </React.Fragment>
                ))}
                {drivers.length === 0 && (
                  <Box sx={{ p: 6, textAlign: 'center', opacity: 0.5 }}>
                    <TaxiIcon sx={{ fontSize: 48, mb: 2 }} />
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>No drivers are currently online</Typography>
                  </Box>
                )}
              </List>
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default LiveMonitoring;
