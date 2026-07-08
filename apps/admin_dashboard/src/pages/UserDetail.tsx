import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Avatar, 
  Chip, 
  Button, 
  Divider, 
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Card,
  CardMedia,
  CardContent,
  Breadcrumbs,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import CheckIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HistoryIcon from '@mui/icons-material/History';
import BackIcon from '@mui/icons-material/ArrowBack';
import api from '../api';
import {
  getDriverSpeeding,
  clearDangerousFlag,
} from '../api/admin';
import { SpeedingBadge } from '../components/SpeedingBadge';
import { format } from 'date-fns';

const UserDetail: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [violations, setViolations] = useState<any[]>([]);
  const [clearDangerousOpen, setClearDangerousOpen] = useState(false);
  const [clearNotes, setClearNotes] = useState('');
  const isDriver = user?.role === 'DRIVER';
  const isDangerous = isDriver && !!user?.driver_profile?.is_dangerous;

  const fetchUser = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/admin/users/${id}`);
      setUser(response.data);
      // Drivers: pull recent speeding history for the safety panel.
      if (response.data?.role === 'DRIVER') {
        try {
          const v = await getDriverSpeeding(id, { limit: 10 });
          setViolations(v.violations ?? []);
        } catch (err) {
          console.error('Failed to fetch speeding history', err);
          setViolations([]);
        }
      }
    } catch (error) {
      console.error('Failed to fetch user', error);
      navigate('/');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUser();
  }, [id]);

  const handleVerify = async () => {
    setActionLoading(true);
    try {
      await api.patch(`/admin/users/${id}/verify`);
      fetchUser();
    } catch (error) {
      console.error('Verification failed', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    setActionLoading(true);
    try {
      await api.patch(`/admin/users/${id}/reject`, { reason: rejectReason });
      setRejectDialogOpen(false);
      fetchUser();
    } catch (error) {
      console.error('Rejection failed', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetPending = async () => {
    setActionLoading(true);
    try {
      await api.patch(`/admin/users/${id}/pending`);
      fetchUser();
    } catch (error) {
      console.error('Failed to set pending', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleVerifyInspection = async (vehicleId: string, status: string) => {
    setActionLoading(true);
    try {
      await api.patch(`/admin/vehicles/${vehicleId}/inspection`, { status });
      fetchUser();
    } catch (error) {
      console.error('Inspection verification failed', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleClearDangerous = async () => {
    setActionLoading(true);
    try {
      await clearDangerousFlag(id, clearNotes || undefined);
      setClearDangerousOpen(false);
      setClearNotes('');
      fetchUser();
    } catch (error) {
      console.error('Failed to clear dangerous flag', error);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress thickness={5} size={50} />
      </Box>
    );
  }

  const getStatusColor = (status: string) => {
    if (status === 'VERIFIED') return 'success';
    if (status === 'PENDING') return 'warning';
    if (status === 'REJECTED') return 'error';
    return 'default';
  };

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Box sx={{ mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Button 
            startIcon={<BackIcon />} 
            onClick={() => navigate(-1)}
            variant="outlined"
            sx={{ borderRadius: '10px' }}
          >
            Back
          </Button>
          <Breadcrumbs aria-label="breadcrumb" sx={{ '& .MuiBreadcrumbs-separator': { mx: 1 } }}>
            <Link component={RouterLink} underline="hover" color="inherit" to="/" sx={{ fontWeight: 600, fontSize: '0.85rem' }}>
              Admin
            </Link>
            <Link component={RouterLink} underline="hover" color="inherit" to={user.role === 'RIDER' ? '/riders' : '/drivers'} sx={{ fontWeight: 600, fontSize: '0.85rem' }}>
              {user.role === 'RIDER' ? 'Riders' : 'Drivers'}
            </Link>
            <Typography color="text.primary" sx={{ fontWeight: 600, fontSize: '0.85rem' }}>User Profile</Typography>
          </Breadcrumbs>
        </Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Manage User
        </Typography>
      </Box>

      <Grid container spacing={3} {...({ component: 'div' } as any)}>
        {/* User Info Card */}
        <Grid item xs={12} md={4} {...({ component: 'div' } as any)}>
          <Paper sx={{ p: 4, borderRadius: 4, border: 'none', position: 'sticky', top: 100 }}>
            <Box sx={{ textAlign: 'center', mb: 4 }}>
              <Avatar 
                src={user.profile_image_url} 
                sx={{ 
                  width: 140, 
                  height: 140, 
                  mx: 'auto', 
                  mb: 3, 
                  bgcolor: 'primary.main',
                  border: '4px solid white',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.1)'
                }}
              >
                {user.full_name.charAt(0)}
              </Avatar>
              <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>{user.full_name}</Typography>
              <Chip 
                label={user.verification_status} 
                color={getStatusColor(user.verification_status) as any} 
                sx={{ fontWeight: 800, height: 26, fontSize: '0.75rem' }} 
              />
            </Box>
            
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>EMAIL ADDRESS</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{user.email}</Typography>
              </Box>
              
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PHONE NUMBER</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{user.phone_number || '---'}</Typography>
              </Box>
              
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PLATFORM ROLE</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{user.role}</Typography>
              </Box>
              
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>MEMBER SINCE</Typography>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{format(new Date(user.created_at), 'PPP')}</Typography>
              </Box>
            </Box>

            <Box sx={{ mt: 5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              <Button 
                variant="contained" 
                color="success" 
                startIcon={<CheckIcon />}
                onClick={handleVerify}
                disabled={actionLoading || user.verification_status === 'VERIFIED'}
                fullWidth
                sx={{ borderRadius: '12px', height: 48 }}
              >
                Approve User
              </Button>
              <Button 
                variant="outlined" 
                color="error" 
                startIcon={<CancelIcon />}
                onClick={() => setRejectDialogOpen(true)}
                disabled={actionLoading || user.verification_status === 'REJECTED'}
                fullWidth
                sx={{ borderRadius: '12px', height: 48 }}
              >
                Reject Request
              </Button>
              <Button 
                variant="text" 
                color="inherit" 
                startIcon={<HistoryIcon />}
                onClick={handleSetPending}
                disabled={actionLoading || user.verification_status === 'PENDING'}
                fullWidth
                sx={{ mt: 1, fontWeight: 700, opacity: 0.6 }}
              >
                Reset to Pending
              </Button>
            </Box>
          </Paper>
        </Grid>

        {/* Detailed Info & Documents */}
        <Grid item xs={12} md={8} {...({ component: 'div' } as any)}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {user.role === 'DRIVER' && user.driver_profile && (
              <>
                <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                  <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 800, mb: 3 }}>
                    Driver Identity
                  </Typography>
                  <Grid container spacing={3} {...({ component: 'div' } as any)}>
                    <Grid item xs={12} sm={6} {...({ component: 'div' } as any)}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>LICENSE NUMBER</Typography>
                      <Typography variant="body1" sx={{ fontWeight: 700 }}>{user.driver_profile.license_number || '---'}</Typography>
                    </Grid>
                    <Grid item xs={12} sm={6} {...({ component: 'div' } as any)}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>VALID UNTIL</Typography>
                      <Typography variant="body1" sx={{ fontWeight: 700 }}>
                        {user.driver_profile.license_expiry_date ? format(new Date(user.driver_profile.license_expiry_date), 'PPP') : '---'}
                      </Typography>
                    </Grid>
                  </Grid>
                </Paper>

                {user.driver_profile.vehicles && user.driver_profile.vehicles.map((v: any, vIdx: number) => (
                  <Paper key={vIdx} sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                        Vehicle: {v.make} {v.model}
                      </Typography>
                      <Chip 
                        label={v.inspection_status || 'PENDING'} 
                        size="small"
                        color={getStatusColor(v.inspection_status) as any}
                        sx={{ fontWeight: 800, height: 22, fontSize: '0.65rem' }}
                      />
                    </Box>
                    <Grid container spacing={3} sx={{ mb: 4 }} {...({ component: 'div' } as any)}>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PLATE NUMBER</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{v.license_plate_number}</Typography>
                      </Grid>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>CONFIGURATION</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{v.color} / {v.interior_color} Int</Typography>
                      </Grid>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PRODUCTION YEAR</Typography>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{v.year}</Typography>
                      </Grid>
                    </Grid>

                    <Divider sx={{ my: 3, borderStyle: 'dashed' }} />

                    <Typography variant="caption" sx={{ fontWeight: 800, mb: 2, display: 'block', color: 'text.secondary' }}>VEHICLE INSPECTION CERTIFICATE</Typography>
                    <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <Card sx={{ maxWidth: 350, border: '1px solid #eee', boxShadow: 'none' }}>
                        {v.inspection_photo_url ? (
                          <CardMedia
                            component="img"
                            height="200"
                            image={v.inspection_photo_url}
                            alt="Inspection Certificate"
                            sx={{ objectFit: 'cover', cursor: 'pointer', transition: 'opacity 0.2s', '&:hover': { opacity: 0.9 } }}
                            onClick={() => window.open(v.inspection_photo_url, '_blank')}
                          />
                        ) : (
                          <Box sx={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', width: 280 }}>
                            <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 700 }}>CERTIFICATE NOT UPLOADED</Typography>
                          </Box>
                        )}
                      </Card>
                      
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
                        <Button 
                          variant="contained" 
                          color="success" 
                          size="small"
                          onClick={() => handleVerifyInspection(v.id, 'APPROVED')}
                          disabled={actionLoading || v.inspection_status === 'APPROVED'}
                          sx={{ borderRadius: '10px', height: 40, px: 3 }}
                        >
                          Approve Inspection
                        </Button>
                        <Button 
                          variant="outlined" 
                          color="error" 
                          size="small"
                          onClick={() => handleVerifyInspection(v.id, 'REJECTED')}
                          disabled={actionLoading || v.inspection_status === 'REJECTED'}
                          sx={{ borderRadius: '10px', height: 40, px: 3 }}
                        >
                          Flag Documents
                        </Button>
                      </Box>
                    </Box>
                  </Paper>
                ))}

                <Box>
                  <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 800 }}>General Compliance Documents</Typography>
                  <Grid container spacing={2} {...({ component: 'div' } as any)}>
                    {[
                      { title: 'Driver License (Front)', url: user.driver_profile.license_photo_url },
                      { title: 'Driver License (Back)', url: user.driver_profile.license_photo_back_url },
                      { title: 'Commercial Insurance', url: user.driver_profile.insurance_photo_url },
                      { title: 'Vehicle Registration', url: user.driver_profile.registration_photo_url }
                    ].map((doc, idx) => (
                      <Grid item xs={12} sm={6} key={idx} {...({ component: 'div' } as any)}>
                        <Card sx={{ border: '1px solid #eee', boxShadow: 'none' }}>
                          <CardContent sx={{ py: 1.5, px: 2, bgcolor: '#fafafa', borderBottom: '1px solid #eee' }}>
                            <Typography variant="caption" sx={{ fontWeight: 800 }}>{doc.title}</Typography>
                          </CardContent>
                          {doc.url ? (
                            <CardMedia
                              component="img"
                              height="220"
                              image={doc.url}
                              alt={doc.title}
                              sx={{ objectFit: 'cover', bgcolor: 'white', cursor: 'pointer' }}
                              onClick={() => window.open(doc.url, '_blank')}
                            />
                          ) : (
                            <Box sx={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'white' }}>
                              <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 700 }}>DOCUMENT NOT PROVIDED</Typography>
                            </Box>
                          )}
                        </Card>
                      </Grid>
                    ))}
                  </Grid>
                </Box>

                {/* Safety */}
                <Paper
                  sx={{
                    p: 4,
                    borderRadius: 4,
                    border: 'none',
                    borderLeft: isDangerous ? '4px solid #C65A5A' : '4px solid #5B7760',
                  }}
                >
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                    sx={{ mb: 2 }}
                  >
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                        Safety
                      </Typography>
                      <SpeedingBadge isDangerous={isDangerous} />
                    </Stack>
                    {isDangerous && (
                      <Button
                        variant="outlined"
                        size="small"
                        color="inherit"
                        onClick={() => setClearDangerousOpen(true)}
                        sx={{ borderRadius: '10px', fontWeight: 700 }}
                      >
                        Clear dangerous flag
                      </Button>
                    )}
                  </Stack>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                    Speeding violations in the last 90 days. Continuous
                    over-limit streaks of ≥45 s count as one violation.
                    Drivers with 3+ violation-trips in this window are
                    flagged dangerous.
                  </Typography>

                  {violations.length === 0 ? (
                    <Box
                      sx={{
                        p: 3,
                        textAlign: 'center',
                        bgcolor: 'background.default',
                        borderRadius: 2,
                      }}
                    >
                      <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                        No speeding violations on record.
                      </Typography>
                    </Box>
                  ) : (
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>When</TableCell>
                            <TableCell>Road</TableCell>
                            <TableCell align="right">Max over</TableCell>
                            <TableCell align="right">Avg mph</TableCell>
                            <TableCell align="right">Duration</TableCell>
                            <TableCell>Trip</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {violations.map((v) => (
                            <TableRow key={v.id} hover>
                              <TableCell>
                                <Typography variant="body2">
                                  {format(new Date(v.created_at), 'PP p')}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">
                                  {v.road_name ?? '—'}
                                </Typography>
                                {v.is_freeway && (
                                  <Chip
                                    label="Freeway"
                                    size="small"
                                    sx={{
                                      mt: 0.5,
                                      height: 18,
                                      fontSize: 10,
                                      backgroundColor: '#D8D2CA',
                                      color: '#2F3A32',
                                    }}
                                  />
                                )}
                              </TableCell>
                              <TableCell align="right">
                                <Typography
                                  variant="body2"
                                  sx={{
                                    fontWeight: 700,
                                    color:
                                      v.max_over_mph >= 25 ? '#C65A5A' : '#2F3A32',
                                  }}
                                >
                                  +{v.max_over_mph} mph
                                </Typography>
                              </TableCell>
                              <TableCell align="right">
                                <Typography variant="body2">
                                  {v.avg_speed_mph}
                                </Typography>
                              </TableCell>
                              <TableCell align="right">
                                <Typography variant="body2">
                                  {Math.max(
                                    Math.round(v.duration_seconds),
                                    45,
                                  )}s
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography
                                  variant="body2"
                                  component={RouterLink}
                                  to={`/rides/${v.trip_id}`}
                                  sx={{
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    color: 'primary.main',
                                    textDecoration: 'none',
                                    fontWeight: 600,
                                  }}
                                >
                                  {String(v.trip_id).slice(0, 8)}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Paper>
              </>
            )}

            {user.role === 'RIDER' && (
              <Box>
                <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 800 }}>Identity Verification (KYC)</Typography>
                <Grid container spacing={2} {...({ component: 'div' } as any)}>
                  {[
                    { title: 'Identity Card (Front)', url: user.id_photo_front_url },
                    { title: 'Identity Card (Back)', url: user.id_photo_back_url }
                  ].map((doc, idx) => (
                    <Grid item xs={12} sm={6} key={idx} {...({ component: 'div' } as any)}>
                      <Card sx={{ border: '1px solid #eee', boxShadow: 'none' }}>
                        <CardContent sx={{ py: 1.5, px: 2, bgcolor: '#fafafa', borderBottom: '1px solid #eee' }}>
                          <Typography variant="caption" sx={{ fontWeight: 800 }}>{doc.title}</Typography>
                        </CardContent>
                        {doc.url ? (
                          <CardMedia
                            component="img"
                            height="340"
                            image={doc.url}
                            alt={doc.title}
                            sx={{ objectFit: 'cover', bgcolor: 'white' }}
                          />
                        ) : (
                          <Box sx={{ height: 340, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'white' }}>
                            <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 700 }}>NOT UPLOADED</Typography>
                          </Box>
                        )}
                      </Card>
                    </Grid>
                  ))}
                </Grid>
              </Box>
            )}
          </Box>
        </Grid>
      </Grid>

      {/* Reject Dialog */}
      <Dialog 
        open={rejectDialogOpen} 
        onClose={() => setRejectDialogOpen(false)}
        {...({
          PaperProps: { sx: { borderRadius: 4, p: 1, maxWidth: 450 } }
        } as any)}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Reject Verification</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 3, color: 'text.secondary', fontWeight: 500 }}>
            Please state the official reason for rejection. This will be visible to the support team and logged in audit trails.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Internal Rejection Note"
            multiline
            rows={4}
            variant="filled"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            sx={{ '& .MuiFilledInput-root': { borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button onClick={() => setRejectDialogOpen(false)} color="inherit" sx={{ fontWeight: 700 }}>Cancel</Button>
          <Button 
            onClick={handleReject} 
            color="error" 
            variant="contained" 
            disabled={!rejectReason || actionLoading}
            sx={{ px: 4, borderRadius: '12px' }}
          >
            Confirm Rejection
          </Button>
        </DialogActions>
      </Dialog>

      {/* Clear Dangerous Dialog */}
      <Dialog
        open={clearDangerousOpen}
        onClose={() => setClearDangerousOpen(false)}
        {...({
          PaperProps: { sx: { borderRadius: 4, p: 1, maxWidth: 450 } }
        } as any)}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Clear Dangerous Flag</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 3, color: 'text.secondary', fontWeight: 500 }}>
            Removing the flag will write an audit log entry. Use a short note
            describing the reason (counseling completed, false positive, etc.).
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Internal note"
            multiline
            rows={3}
            variant="filled"
            value={clearNotes}
            onChange={(e) => setClearNotes(e.target.value)}
            sx={{ '& .MuiFilledInput-root': { borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button
            onClick={() => setClearDangerousOpen(false)}
            color="inherit"
            sx={{ fontWeight: 700 }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleClearDangerous}
            color="primary"
            variant="contained"
            disabled={actionLoading}
            sx={{ px: 4, borderRadius: '12px' }}
          >
            Clear Flag
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default UserDetail;
