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
import { getRideById, getRideRoutes, getRideLedger, cancelRideByAdmin, completeRideByAdmin } from '../api/admin';
import RideMap from '../components/RideMap';
import { format } from 'date-fns';
import { io } from 'socket.io-client';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000';

const fmtUSD = (cents: any) => '$' + (Number(cents ?? 0) / 100).toFixed(2);

const RideDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [ride, setRide] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [trajectory, setTrajectory] = useState<any[]>([]);
  const [driverLocation, setDriverLocation] = useState<{lat: number, lng: number} | null>(null);
  const [plannedRoute, setPlannedRoute] = useState<[number, number][]>([]);
  const [actualRoute, setActualRoute] = useState<[number, number][]>([]);
  const [actualAvailable, setActualAvailable] = useState(false);
  const [ledger, setLedger] = useState<any>(null);
  const [opsPending, setOpsPending] = useState(false);

  const handleAdminCancel = async () => {
    if (opsPending) return;
    const reasonText = window.prompt('Reason for cancelling this ride (shown to the parties):', '');
    if (reasonText === null) return;
    if (!window.confirm(`Cancel ride #${ride?.id?.substring(0, 8)}? Both parties will be notified that the ride ended.`)) return;
    setOpsPending(true);
    try {
      await cancelRideByAdmin(id!, reasonText || undefined);
      const data = await getRideById(id!);
      setRide(data);
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to cancel ride');
    } finally {
      setOpsPending(false);
    }
  };

  const handleAdminComplete = async () => {
    if (opsPending) return;
    if (!window.confirm(`Force-complete ride #${ride?.id?.substring(0, 8)}? The full settlement pipeline (wallet, ledger) will run exactly like a driver completion.`)) return;
    setOpsPending(true);
    try {
      await completeRideByAdmin(id!);
      const data = await getRideById(id!);
      setRide(data);
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to complete ride');
    } finally {
      setOpsPending(false);
    }
  };

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

    const fetchRoutes = async () => {
      try {
        const routes = await getRideRoutes(id!);
        if (routes.planned?.available) {
          const legs = routes.planned.legs ?? [];
          setPlannedRoute(legs.flatMap((leg: any) => leg.polyline ?? []));
        }
        if (routes.actual?.available) {
          setActualRoute(routes.actual.polyline ?? []);
          setActualAvailable(true);
        }
      } catch (error) {
        console.error('Failed to fetch ride routes:', error);
      }
    };

    const fetchLedger = async () => {
      try {
        const data = await getRideLedger(id!);
        setLedger(data);
      } catch (error) {
        console.error('Failed to fetch ride ledger:', error);
      }
    };

    fetchRide();
    fetchRoutes();
    fetchLedger();

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
        {isActive && (
          <>
            <Button
              variant="outlined"
              color="success"
              startIcon={<CheckCircleIcon />}
              onClick={handleAdminComplete}
              disabled={opsPending}
              sx={{ borderRadius: '12px' }}
            >
              Force Complete
            </Button>
            <Button
              variant="outlined"
              color="error"
              startIcon={<CancelIcon />}
              onClick={handleAdminCancel}
              disabled={opsPending}
              sx={{ borderRadius: '12px' }}
            >
              Cancel Ride
            </Button>
          </>
        )}
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
          <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ width: 28, height: 0, borderTop: '4px dashed #3f51b5' }} />
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>PLANNED ROUTE</Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ width: 28, height: 0, borderTop: '4px solid #ff9800' }} />
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>ACTUAL GPS</Typography>
            </Box>
            {!isActive && !actualAvailable && (
              <Chip size="small" color="warning" sx={{ fontWeight: 700, fontSize: '0.65rem', height: 22 }}
                label="Actual route unavailable — no GPS samples captured" />
            )}
          </Box>
          <Paper sx={{ height: 650, p: 0, borderRadius: 4, overflow: 'hidden', border: 'none' }}>
            <RideMap 
              pickup={{ lat: ride.pickup_lat, lng: ride.pickup_lng, address: ride.pickup_address }}
              destination={{ lat: ride.destination_lat, lng: ride.destination_lng, address: ride.destination_address }}
              driverLocation={driverLocation || (isActive ? { lat: ride.pickup_lat, lng: ride.pickup_lng } : undefined)}
              trajectory={isActive ? trajectory : []}
              plannedRoute={plannedRoute.length > 1 ? plannedRoute : undefined}
              actualRoute={actualAvailable && actualRoute.length > 1 ? actualRoute : undefined}
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
                Financial Settlement
              </Typography>
              {ledger?.settlement ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>STATUS</Typography>
                    <Chip
                      size="small"
                      label={ledger.settlement.status}
                      sx={{ fontWeight: 800, fontSize: '0.65rem', height: 22,
                        bgcolor: ledger.settlement.status === 'SETTLED' ? 'success.main' : 'warning.main',
                        color: 'white' }}
                    />
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>FARE</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ledger.settlement.fare_cents)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PROMO / CREDITS</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      −{fmtUSD(ledger.settlement.promotion_cents + ledger.settlement.credits_cents)}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>TIP</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ledger.settlement.tip_cents)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>WALLET PAID</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ledger.settlement.wallet_payment_cents)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>DRIVER (60%)</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ledger.settlement.driver_share_cents)}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PLATFORM</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ledger.settlement.platform_share_cents)}</Typography>
                  </Box>
                  {Number(ledger.settlement.amount_owed_cents) > 0 && (
                    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Typography variant="caption" color="warning.main" sx={{ fontWeight: 700 }}>AMOUNT OWED</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 700, color: 'warning.main' }}>{fmtUSD(ledger.settlement.amount_owed_cents)}</Typography>
                    </Box>
                  )}
                </Box>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>SETTLEMENT</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700, color: isActive ? 'primary.main' : 'text.disabled' }}>
                      {isActive ? 'Pending completion' : 'Not recorded'}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>DRIVER EARNINGS</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(ride.driver_earnings_cents)}</Typography>
                  </Box>
                </Box>
              )}
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
