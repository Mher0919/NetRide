import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Divider, 
  Chip, 
  Avatar,
  CircularProgress,
  Button
} from '@mui/material';
import Grid from '@mui/material/Grid';
import BackIcon from '@mui/icons-material/ArrowBack';
import TaxiIcon from '@mui/icons-material/LocalTaxi';
import PersonIcon from '@mui/icons-material/Person';
import TimeIcon from '@mui/icons-material/Schedule';
import DistanceIcon from '@mui/icons-material/Map';
import FareIcon from '@mui/icons-material/Payments';
import AuditIcon from '@mui/icons-material/History';
import { useNavigate, useParams } from 'react-router-dom';
import { getRideById } from '../api/admin';
import RideMap from '../components/RideMap';
import { format } from 'date-fns';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000';

const RideDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [ride, setRide] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [trajectory, setTrajectory] = useState<any[]>([]);
  const [driverLocation, setDriverLocation] = useState<{lat: number, lng: number} | null>(null);

  useEffect(() => {
    const fetchRide = async () => {
      try {
        const data = await getRideById(id!);
        setRide(data);
        if (data.trajectory) {
          setTrajectory(typeof data.trajectory === 'string' ? JSON.parse(data.trajectory) : data.trajectory);
        }
      } catch (error) {
        console.error('Failed to fetch ride:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchRide();

    const socket = io(API_URL, {
      auth: { token: localStorage.getItem('admin_token') }
    });

    socket.on('connect', () => {
      socket.emit('subscribeToMonitoring');
    });

    socket.on('tripUpdate', (updatedTrip: any) => {
      if (updatedTrip.id === id) {
        setRide(updatedTrip);
        if (updatedTrip.trajectory) {
          setTrajectory(typeof updatedTrip.trajectory === 'string' ? JSON.parse(updatedTrip.trajectory) : updatedTrip.trajectory);
        }
      }
    });

    socket.on('driverLocationUpdate', (data: any) => {
      if (ride?.driver_id === data.driverId) {
        setDriverLocation({ lat: data.lat, lng: data.lng });
        setTrajectory(prev => [...prev, { lat: data.lat, lng: data.lng, t: new Date().toISOString() }]);
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [id, ride?.driver_id]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress thickness={5} size={50} />
      </Box>
    );
  }

  if (!ride) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography variant="h6">Ride record not found</Typography>
        <Button onClick={() => navigate(-1)} sx={{ mt: 2 }}>Go Back</Button>
      </Box>
    );
  }

  const isActive = !['COMPLETED', 'CANCELLED'].includes(ride.status);

  return (
    <Box sx={{ maxWidth: 1400, mx: 'auto' }}>
      <Box sx={{ mb: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Button 
          startIcon={<BackIcon />} 
          onClick={() => navigate(-1)}
          variant="outlined"
          sx={{ borderRadius: '10px' }}
        >
          Back
        </Button>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Ride Details <Typography component="span" variant="h5" color="text.secondary" sx={{ fontWeight: 400 }}>#{ride.id.substring(0, 8)}</Typography>
        </Typography>
        <Chip 
          label={ride.status} 
          sx={{ 
            fontWeight: 800, 
            bgcolor: isActive ? 'primary.main' : (ride.status === 'COMPLETED' ? 'success.main' : 'error.main'),
            color: 'white',
            px: 1
          }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button 
          variant="contained" 
          startIcon={<AuditIcon />}
          onClick={() => navigate(`/rides/${ride.id}/audit`)}
          sx={{ borderRadius: '12px', bgcolor: 'primary.main' }}
        >
          Investigation Report
        </Button>
      </Box>

      <Grid container spacing={3} {...({ component: 'div' } as any)}>
        <Grid item xs={12} lg={8} {...({ component: 'div' } as any)}>
          <Paper sx={{ height: 650, p: 0, borderRadius: 4, overflow: 'hidden', border: 'none' }}>
            <RideMap 
              pickup={{ lat: ride.pickup_lat, lng: ride.pickup_lng, address: ride.pickup_address }}
              destination={{ lat: ride.destination_lat, lng: ride.destination_lng, address: ride.destination_address }}
              driverLocation={driverLocation || (isActive ? { lat: ride.pickup_lat, lng: ride.pickup_lng } : undefined)}
              trajectory={trajectory}
              live={isActive}
            />
          </Paper>
        </Grid>

        <Grid item xs={12} lg={4} {...({ component: 'div' } as any)}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Paper sx={{ p: 3, borderRadius: 4, border: 'none' }}>
              <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 700, mb: 3 }}>
                Trip Information
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Avatar sx={{ bgcolor: 'background.default', color: 'text.secondary', mr: 2, width: 40, height: 40 }}>
                    <TimeIcon fontSize="small" />
                  </Avatar>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>REQUESTED AT</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{format(new Date(ride.created_at), 'PPP p')}</Typography>
                  </Box>
                </Box>
                <Divider sx={{ borderStyle: 'dashed' }} />
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Avatar sx={{ bgcolor: 'background.default', color: 'text.secondary', mr: 2, width: 40, height: 40 }}>
                    <DistanceIcon fontSize="small" />
                  </Avatar>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>METRICS</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {ride.distance_meters ? (ride.distance_meters / 1000).toFixed(2) + ' km' : '---'} • 
                      {ride.duration_seconds ? Math.round(ride.duration_seconds / 60) + ' min' : '---'}
                    </Typography>
                  </Box>
                </Box>
                <Divider sx={{ borderStyle: 'dashed' }} />
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Avatar sx={{ bgcolor: '#e8f5e9', color: 'success.main', mr: 2, width: 40, height: 40 }}>
                    <FareIcon fontSize="small" />
                  </Avatar>
                  <Box>
                    <Typography variant="caption" color="success.main" sx={{ fontWeight: 700 }}>ESTIMATED FARE</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 800, color: 'success.main' }}>
                      {ride.fare_amount ? `$${parseFloat(ride.fare_amount).toFixed(2)}` : '$0.00'}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </Paper>

            <Paper sx={{ p: 3, borderRadius: 4, border: 'none' }}>
              <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 700, mb: 3 }}>
                Participants
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Avatar 
                    src={ride.rider?.profile_image_url} 
                    sx={{ bgcolor: 'primary.main', mr: 2, width: 48, height: 48, border: '2px solid white', boxShadow: '0 0 0 2px #eee' }}
                  >
                    <PersonIcon />
                  </Avatar>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>RIDER</Typography>
                    <Typography variant="body1" sx={{ fontWeight: 700 }}>{ride.rider?.full_name}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{ride.rider?.phone_number}</Typography>
                  </Box>
                </Box>
                {ride.driver && (
                  <>
                    <Divider />
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <Avatar 
                        src={ride.driver?.profile_image_url} 
                        sx={{ bgcolor: 'secondary.main', mr: 2, width: 48, height: 48, border: '2px solid white', boxShadow: '0 0 0 2px #eee' }}
                      >
                        <TaxiIcon />
                      </Avatar>
                      <Box>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>DRIVER</Typography>
                        <Typography variant="body1" sx={{ fontWeight: 700 }}>{ride.driver?.full_name}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{ride.driver?.phone_number}</Typography>
                      </Box>
                    </Box>
                  </>
                )}
              </Box>
            </Paper>

            <Paper sx={{ p: 3, borderRadius: 4, border: 'none' }}>
              <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 700, mb: 3 }}>
                Route Summary
              </Typography>
              <Box sx={{ position: 'relative', pl: 4 }}>
                <Box sx={{ 
                  position: 'absolute', 
                  left: 7, 
                  top: 10, 
                  bottom: 10, 
                  width: 2, 
                  bgcolor: '#eee',
                  '&:before': { content: '""', position: 'absolute', top: -10, left: -4, width: 10, height: 10, borderRadius: '50%', border: '2px solid #2e7d32', bgcolor: 'white' },
                  '&:after': { content: '""', position: 'absolute', bottom: -10, left: -4, width: 10, height: 10, borderRadius: '2px', border: '2px solid #d32f2f', bgcolor: 'white' }
                }} />
                <Box sx={{ mb: 4 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PICKUP</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5 }}>{ride.pickup_address}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>DESTINATION</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600, mt: 0.5 }}>{ride.destination_address}</Typography>
                </Box>
              </Box>
            </Paper>
          </Box>
        </Grid>
      </Grid>
    </Box>
  );
};

export default RideDetail;
