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
  Snackbar,
  Alert,
  MenuItem,
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
  getDriverDocumentRequirements,
  requestDocumentResubmission,
  reviewDocumentRequirement,
  requestVehicleResubmission,
  updateLicense,
  uploadUserDocument,
  deleteUserDocument,
  blockUser,
  unblockUser,
  getDriverRidePreferences,
  listFleets,
  assignDriverFleet,
} from '../api/admin';
import { SpeedingBadge } from '../components/SpeedingBadge';
import EarningsPanel from '../components/EarningsPanel';
import GroupIcon from '@mui/icons-material/Groups';
import { format } from '../utils/date';

const UserDetail: React.FC = () => {
  const { id, section } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [violations, setViolations] = useState<any[]>([]);
  const [clearDangerousOpen, setClearDangerousOpen] = useState(false);
  const [clearNotes, setClearNotes] = useState('');
  const [docRequirements, setDocRequirements] = useState<any[]>([]);
  const [requestDocsOpen, setRequestDocsOpen] = useState(false);
  const [requestDocType, setRequestDocType] = useState('');
  const [requestDocReason, setRequestDocReason] = useState('');
  const [vehicleResubmitOpen, setVehicleResubmitOpen] = useState(false);
  const [vehicleResubmitReason, setVehicleResubmitReason] = useState('');
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [ridePrefs, setRidePrefs] = useState<any>(null);
  const [blockReason, setBlockReason] = useState('');
  const [licenseNumber, setLicenseNumber] = useState('');
  const [licenseExpiry, setLicenseExpiry] = useState('');
  const [licenseSaving, setLicenseSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string }>({ open: false, message: '' });
  const [erroredDocs, setErroredDocs] = useState<Record<string, boolean>>({});
  const [profileImgError, setProfileImgError] = useState(false);
  const [fleets, setFleets] = useState<any[]>([]);
  const [selectedFleetId, setSelectedFleetId] = useState<string>('');
  const [fleetSaving, setFleetSaving] = useState(false);
  const hasDriverProfile = !!user?.driver_profile;
  // When opened from a specific section, scope the view to that role even if
  // the account has both rider and driver profiles.
  const viewIsDriver =
    section === 'drivers' ? true : section === 'riders' ? false : user?.role === 'DRIVER';
  const isDriver = viewIsDriver;
  const isDangerous = isDriver && !!user?.driver_profile?.is_dangerous;

  const fetchUser = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/admin/users/${id}`);
      setUser(response.data);
      // Drivers: pull recent speeding history for the safety panel.
      if (response.data?.driver_profile) {
        try {
          const v = await getDriverSpeeding(id, { limit: 10 });
          setViolations(v.violations ?? []);
        } catch (err) {
          console.error('Failed to fetch speeding history', err);
          setViolations([]);
        }
        try {
          const docs = await getDriverDocumentRequirements(id);
          setDocRequirements(docs.requirements ?? []);
        } catch (err) {
          console.error('Failed to fetch document requirements', err);
          setDocRequirements([]);
        }
        const dp = response.data.driver_profile;
        setLicenseNumber(dp?.license_number ?? '');
        setLicenseExpiry(dp?.license_expiry_date
          ? format(new Date(dp.license_expiry_date), 'yyyy-MM-dd')
          : '');
        setSelectedFleetId(dp?.fleet_id ?? '');
        // Ride eligibility vs. preferences (clearly separated for admin).
        try {
          const rp = await getDriverRidePreferences(id);
          setRidePrefs(rp);
        } catch (err) {
          console.error('Failed to fetch driver ride preferences', err);
          setRidePrefs(null);
        }
        try {
          const fl = await listFleets();
          setFleets(fl?.fleets ?? []);
        } catch (err) {
          console.error('Failed to fetch fleet partners', err);
          setFleets([]);
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

  const handleTriggerFaceCheck = async () => {
    setActionLoading(true);
    try {
      await blockUser(id!, blockReason);
      setBlockDialogOpen(false);
      setBlockReason('');
      setSnackbar({ open: true, message: 'User blocked. They will see the block notice and reason.' });
      fetchUser();
    } catch (error) {
      console.error('Failed to block user', error);
      setSnackbar({ open: true, message: 'Failed to block user.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnblock = async () => {
    setActionLoading(true);
    try {
      await unblockUser(id!);
      setSnackbar({ open: true, message: 'User unblocked.' });
      fetchUser();
    } catch (error) {
      console.error('Failed to unblock user', error);
      setSnackbar({ open: true, message: 'Failed to unblock user.' });
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

  const handleRequestDocument = async () => {
    if (!requestDocType || !requestDocReason.trim()) return;
    setActionLoading(true);
    try {
      await requestDocumentResubmission(id, requestDocType, requestDocReason);
      setRequestDocsOpen(false);
      setRequestDocType('');
      setRequestDocReason('');
      const docs = await getDriverDocumentRequirements(id);
      setDocRequirements(docs.requirements ?? []);
    } catch (error) {
      console.error('Failed to request document', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReviewDocument = async (requirementId: string, decision: 'approved' | 'rejected') => {
    setActionLoading(true);
    try {
      await reviewDocumentRequirement(requirementId, decision);
      const docs = await getDriverDocumentRequirements(id);
      setDocRequirements(docs.requirements ?? []);
    } catch (error) {
      console.error('Failed to review document', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleVehicleResubmission = async () => {
    if (!vehicleResubmitReason.trim()) return;
    setActionLoading(true);
    try {
      await requestVehicleResubmission(id, vehicleResubmitReason);
      setVehicleResubmitOpen(false);
      setVehicleResubmitReason('');
      fetchUser();
    } catch (error) {
      console.error('Failed to request vehicle resubmission', error);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveLicense = async () => {
    setLicenseSaving(true);
    try {
      await updateLicense(id, {
        license_number: licenseNumber || undefined,
        license_expiry_date: licenseExpiry || undefined,
      });
      fetchUser();
    } catch (error) {
      console.error('Failed to update license', error);
    } finally {
      setLicenseSaving(false);
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

  const handleFileSelected = async (field: string, file: File) => {
    if (!id) return;
    setUploadingField(field);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = async () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        const mimetype = file.type || 'image/jpeg';
        await uploadUserDocument(id, field, base64, mimetype);
        fetchUser();
      };
      reader.onerror = () => {
        console.error('Failed to read file');
        setUploadingField(null);
      };
    } catch (error) {
      console.error('Failed to upload document', error);
    } finally {
      // Will be cleared after reader.onload completes
      setTimeout(() => setUploadingField(null), 1000);
    }
  };

  const handleSaveFleet = async () => {
    if (!id) return;
    setFleetSaving(true);
    try {
      const fleetId = selectedFleetId || null;
      await assignDriverFleet(id, fleetId);
      const fleet = fleetId ? fleets.find((f: any) => f.id === fleetId) : null;
      setSnackbar({
        open: true,
        message: fleet
          ? `Assigned to ${fleet.name}. Fleet earns ${fleet.platform_share_percent}% of the 40% platform pool on future rides.`
          : 'Fleet assignment removed. NetRide keeps the full platform pool on future rides.',
      });
      fetchUser();
    } catch (error: any) {
      console.error('Failed to save fleet assignment', error);
      setSnackbar({ open: true, message: error?.response?.data?.error || 'Failed to save fleet assignment.' });
    } finally {
      setFleetSaving(false);
    }
  };

  const handleDeleteDocument = async (field: string) => {
    if (!id) return;
    if (!window.confirm(`Are you sure you want to remove this document?`)) return;
    setUploadingField(field);
    try {
      await deleteUserDocument(id, field);
      fetchUser();
    } catch (error) {
      console.error('Failed to delete document', error);
    } finally {
      setUploadingField(null);
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
    if (status === 'REJECTED' || status === 'BLOCKED') return 'error';
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
            <Link component={RouterLink} underline="hover" color="inherit" to={section === 'riders' ? '/riders' : section === 'drivers' ? '/drivers' : isDriver ? '/drivers' : '/riders'} sx={{ fontWeight: 600, fontSize: '0.85rem' }}>
              {section === 'riders' ? 'Riders' : section === 'drivers' ? 'Drivers' : isDriver ? 'Drivers' : 'Riders'}
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
                src={profileImgError ? undefined : user.profile_image_url} 
                imgProps={{ onError: () => setProfileImgError(true) }}
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
              {user.verification_status === 'BLOCKED' && user.blocked_reason && (
                <Typography variant="caption" sx={{ display: 'block', mt: 1.5, color: '#C65A5A', fontWeight: 700 }}>
                  Block reason: {user.blocked_reason}
                </Typography>
              )}
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
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{isDriver ? 'DRIVER' : user.role}</Typography>
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
                startIcon={actionLoading ? undefined : <CheckIcon />}
                onClick={handleVerify}
                disabled={actionLoading || user.verification_status === 'VERIFIED'}
                fullWidth
                sx={{ borderRadius: '12px', height: 48 }}
              >
                {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Approve User'}
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
                startIcon={actionLoading ? undefined : <HistoryIcon />}
                onClick={handleSetPending}
                disabled={actionLoading || user.verification_status === 'PENDING'}
                fullWidth
                sx={{ mt: 1, fontWeight: 700, opacity: 0.6 }}
              >
                {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Reset to Pending'}
              </Button>
              {user.verification_status === 'BLOCKED' ? (
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={actionLoading ? undefined : <CheckIcon />}
                  onClick={handleUnblock}
                  disabled={actionLoading}
                  fullWidth
                  sx={{ mt: 1, borderRadius: '12px', height: 48 }}
                >
                  {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Unblock User'}
                </Button>
              ) : (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={actionLoading ? undefined : <CancelIcon />}
                  onClick={() => setBlockDialogOpen(true)}
                  disabled={actionLoading}
                  fullWidth
                  sx={{ mt: 1, borderRadius: '12px', height: 48 }}
                >
                  Block User
                </Button>
              )}
            </Box>
          </Paper>
        </Grid>

        {/* Detailed Info & Documents */}
        <Grid item xs={12} md={8} {...({ component: 'div' } as any)}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {isDriver && hasDriverProfile && (
              <>
                <EarningsPanel userId={id} />
                <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                      Fleet Partner
                    </Typography>
                    {user.driver_profile?.fleet ? (
                      <Chip
                        icon={<GroupIcon sx={{ fontSize: 14 }} />}
                        label={`${user.driver_profile.fleet.name} · ${user.driver_profile.fleet.platform_share_percent}% of platform pool`}
                        size="small"
                        color="success"
                        variant="outlined"
                        sx={{ fontWeight: 800, height: 24, fontSize: '0.7rem' }}
                      />
                    ) : (
                      <Chip
                        label="NO FLEET"
                        size="small"
                        variant="outlined"
                        sx={{ fontWeight: 800, height: 24, fontSize: '0.7rem' }}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                    Optional: assign this driver to a fleet partner. The fleet earns its configured
                    share of the 40% platform pool on <strong>future rides</strong> (driver share stays
                    60%). Without a fleet, NetRide keeps the full platform pool.
                  </Typography>
                  <Grid container spacing={2} alignItems="flex-end" {...({ component: 'div' } as any)}>
                    <Grid item xs={12} sm={7} {...({ component: 'div' } as any)}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                        FLEET PARTNER
                      </Typography>
                      <TextField
                        select
                        fullWidth
                        size="small"
                        variant="outlined"
                        value={selectedFleetId}
                        onChange={(e) => setSelectedFleetId(e.target.value)}
                        sx={{ mt: 0.5, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                      >
                        <MenuItem value="">
                          <em>None — NetRide keeps the platform pool</em>
                        </MenuItem>
                        {fleets.map((f: any) => (
                          <MenuItem key={f.id} value={f.id}>
                            {f.name} ({f.platform_share_percent}% of platform pool)
                          </MenuItem>
                        ))}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={5} {...({ component: 'div' } as any)}>
                      <Button
                        variant="contained"
                        size="small"
                        onClick={handleSaveFleet}
                        disabled={fleetSaving || selectedFleetId === (user.driver_profile?.fleet_id ?? '')}
                        sx={{ borderRadius: '10px', fontWeight: 700, px: 3 }}
                      >
                        {fleetSaving ? <CircularProgress size={16} color="inherit" /> : 'Save Fleet Assignment'}
                      </Button>
                    </Grid>
                  </Grid>
                </Paper>
                <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                      Driver Identity
                    </Typography>
                    {user.driver_profile.license_expiry_date && new Date(user.driver_profile.license_expiry_date) < new Date() && (
                      <Chip
                        label="EXPIRED"
                        size="small"
                        color="error"
                        sx={{ fontWeight: 800, height: 22, fontSize: '0.65rem' }}
                      />
                    )}
                  </Box>
                  <Grid container spacing={3} sx={{ mb: 3 }} {...({ component: 'div' } as any)}>
                    <Grid item xs={12} sm={6} {...({ component: 'div' } as any)}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>LICENSE NUMBER</Typography>
                      <TextField
                        fullWidth
                        size="small"
                        variant="outlined"
                        value={licenseNumber}
                        onChange={(e) => setLicenseNumber(e.target.value)}
                        sx={{ mt: 0.5, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                      />
                    </Grid>
                    <Grid item xs={12} sm={6} {...({ component: 'div' } as any)}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>EXPIRATION DATE</Typography>
                      <TextField
                        fullWidth
                        size="small"
                        type="date"
                        variant="outlined"
                        value={licenseExpiry}
                        onChange={(e) => setLicenseExpiry(e.target.value)}
                        sx={{ mt: 0.5, '& .MuiOutlinedInput-root': { borderRadius: 2 } }}
                        InputLabelProps={{ shrink: true }}
                      />
                    </Grid>
                  </Grid>
                  <Box sx={{ display: 'flex', gap: 2 }}>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={handleSaveLicense}
                      disabled={licenseSaving}
                      sx={{ borderRadius: '10px', fontWeight: 700 }}
                    >
                      {licenseSaving ? 'Saving...' : 'Save License Info'}
                    </Button>
                  </Box>
                </Paper>

                {/* Latest finalized vehicle submission — shown in the primary review section */}
                {(() => {
                  const finalizedSub = user.driver_profile?.latest_finalized_vehicle_submission;
                  const isApproved = finalizedSub?.status === 'APPROVED';
                  const isRejected = finalizedSub?.status === 'REJECTED';
                  return (
                    <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                          Latest Vehicle Review
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          {finalizedSub && (
                            <Chip
                              label={isApproved ? 'APPROVED' : isRejected ? 'REJECTED' : finalizedSub.status}
                              size="small"
                              color={isApproved ? 'success' : isRejected ? 'error' : 'warning' as any}
                              sx={{ fontWeight: 800, height: 22, fontSize: '0.65rem' }}
                            />
                          )}
                          {user.driver_profile?.active_vehicle && (
                            <Chip
                              label="ACTIVE"
                              size="small"
                              color="success"
                              variant="outlined"
                              sx={{ fontWeight: 800, height: 22, fontSize: '0.65rem' }}
                            />
                          )}
                        </Box>
                      </Box>
                      {finalizedSub ? (
                        <>
                          <Grid container spacing={3} sx={{ mb: 3 }} {...({ component: 'div' } as any)}>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>MAKE</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.make || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>MODEL</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.model || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>YEAR</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.year || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>COLOR</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.color || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PLATE NUMBER</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.license_plate_number || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PLATE STATE</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.license_plate_state || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>ZIP CODE</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>{finalizedSub.zip_code || '---'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>REVIEWED</Typography>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {finalizedSub.reviewed_at ? format(new Date(finalizedSub.reviewed_at), 'PP') : '---'}
                              </Typography>
                            </Grid>
                          </Grid>
                          {isRejected && finalizedSub.rejection_reason && (
                            <Box sx={{ mt: 2, p: 2, bgcolor: '#FCE9E9', borderRadius: 2 }}>
                              <Typography variant="caption" sx={{ fontWeight: 700, color: '#C65A5A' }}>REJECTION REASON</Typography>
                              <Typography variant="body2" sx={{ mt: 0.5 }}>{finalizedSub.rejection_reason}</Typography>
                            </Box>
                          )}
                          <Box sx={{ mt: 3, display: 'flex', gap: 2 }}>
                            <Button
                              variant="outlined"
                              color="warning"
                              size="small"
                              onClick={() => setVehicleResubmitOpen(true)}
                              disabled={actionLoading}
                              sx={{ borderRadius: '10px', fontWeight: 700 }}
                            >
                              Request Again
                            </Button>
                          </Box>
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                          No finalized vehicle submissions found.
                        </Typography>
                      )}
                    </Paper>
                  );
                })()}

                {/* All vehicle records (for reference) */}
                {user.driver_profile.vehicles && user.driver_profile.vehicles.length > 0 && (
                  <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 3 }}>
                      Vehicle Records ({user.driver_profile.vehicles.length})
                    </Typography>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Make</TableCell>
                            <TableCell>Model</TableCell>
                            <TableCell>Year</TableCell>
                            <TableCell>Color</TableCell>
                            <TableCell>Plate</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell>Approved At</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {user.driver_profile.vehicles.map((v: any, idx: number) => (
                            <TableRow key={v.id || idx} hover>
                              <TableCell>
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                  {v.make || v.catalog_make || '---'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">
                                  {v.model || v.catalog_model || '---'}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">{v.year || '---'}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">{v.color || '---'}</Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">{v.license_plate_number || '---'}</Typography>
                              </TableCell>
                              <TableCell>
                                <Chip
                                  label={v.vehicle_status || 'APPROVED'}
                                  size="small"
                                  color={
                                    v.vehicle_status === 'APPROVED' || v.vehicle_status === null ? 'success'
                                      : v.vehicle_status === 'PENDING_REVIEW' ? 'warning'
                                      : v.vehicle_status === 'REJECTED' || v.vehicle_status === 'INACTIVE' ? 'default'
                                      : 'default'
                                  }
                                  sx={{ fontWeight: 700, height: 22, fontSize: '0.65rem' }}
                                />
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2">
                                  {v.approved_at ? format(new Date(v.approved_at), 'PP') : '---'}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Paper>
                )}

                {/* Ride Eligibility vs. Driver Preferences */}
                {isDriver && ridePrefs && (
                  <Paper elevation={0} sx={{ p: 3, mt: 3, borderRadius: 3, border: '1px solid #eee' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 0.5 }}>
                      Ride Eligibility &amp; Preferences
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                      Vehicle class is derived from the verified vehicle. Eligible types are what the class
                      can serve. Enabled types are what the driver opted into.
                    </Typography>

                    <Grid container spacing={2} {...({ component: 'div' } as any)}>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                          VEHICLE CLASS
                        </Typography>
                        <Typography variant="body1" sx={{ fontWeight: 700, color: '#5B7760' }}>
                          {ridePrefs.vehicleClassLabel || ridePrefs.vehicleClass}
                        </Typography>
                      </Grid>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                          ELIGIBLE RIDE TYPES
                        </Typography>
                        <Box sx={{ mt: 0.5 }}>
                          {(ridePrefs.eligibleRideTypes || []).map((rt: string) => (
                            <Chip
                              key={rt}
                              label={ridePrefs.eligibleLabels?.[rt] || rt}
                              size="small"
                              sx={{ mr: 0.5, mb: 0.5, bgcolor: '#5B7760', color: 'white', fontWeight: 700 }}
                            />
                          ))}
                        </Box>
                      </Grid>
                      <Grid item xs={12} sm={4} {...({ component: 'div' } as any)}>
                        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
                          ENABLED RIDE TYPES
                        </Typography>
                        <Box sx={{ mt: 0.5 }}>
                          {(ridePrefs.eligibleRideTypes || []).map((rt: string) => {
                            const on = ridePrefs.preferences?.[rt] === true;
                            return (
                              <Chip
                                key={rt}
                                label={ridePrefs.eligibleLabels?.[rt] || rt}
                                size="small"
                                variant={on ? 'filled' : 'outlined'}
                                color={on ? 'success' : 'default'}
                                sx={{ mr: 0.5, mb: 0.5, fontWeight: 700 }}
                              />
                            );
                          })}
                        </Box>
                      </Grid>
                    </Grid>
                  </Paper>
                )}

                <Box>
                  <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 800 }}>General Compliance Documents</Typography>
                  <Grid container spacing={2} {...({ component: 'div' } as any)}>
                    {(() => {
                      const firstVeh = user.driver_profile.vehicles?.[0];
                      const items = [
                        { title: 'Driver License (Front)', key: 'license_photo_url', url: user.driver_profile.license_photo_url, requestable: true },
                        { title: 'Driver License (Back)', key: 'license_photo_back_url', url: user.driver_profile.license_photo_back_url, requestable: true },
                        { title: 'Commercial Insurance', key: 'insurance_photo_url', url: user.driver_profile.insurance_photo_url, requestable: false },
                        { title: 'Vehicle Registration', key: 'registration_photo_url', url: user.driver_profile.registration_photo_url, requestable: true },
                        { title: 'Vehicle Inspection', key: 'inspection_photo_url', url: firstVeh?.inspection_photo_url, requestable: true },
                      ];
                      return items.filter(Boolean).map((doc, idx) => (
                        <Grid item xs={12} sm={6} key={idx} {...({ component: 'div' } as any)}>
                          <Card sx={{ border: '1px solid #eee', boxShadow: 'none' }}>
                            <CardContent sx={{ py: 1.5, px: 2, bgcolor: '#fafafa', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Typography variant="caption" sx={{ fontWeight: 800 }}>{doc.title}</Typography>
                              <Stack direction="row" spacing={0.5}>
                                {doc.requestable && (
                                  <Button
                                    size="small"
                                    variant="text"
                                    color="warning"
                                    onClick={() => { setRequestDocType(doc.key); setRequestDocReason(''); setRequestDocsOpen(true); }}
                                    sx={{ fontSize: '0.65rem', fontWeight: 700 }}
                                  >
                                    Request
                                  </Button>
                                )}
                                <input
                                  type="file"
                                  accept="image/*"
                                  id={`upload-${doc.key}`}
                                  style={{ display: 'none' }}
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handleFileSelected(doc.key, file);
                                    e.target.value = '';
                                  }}
                                />
                                <label htmlFor={`upload-${doc.key}`}>
                                  <Button
                                    size="small"
                                    variant="text"
                                    color="primary"
                                    component="span"
                                    disabled={uploadingField === doc.key}
                                    sx={{ fontSize: '0.65rem', fontWeight: 700 }}
                                  >
                                    {uploadingField === doc.key ? '...' : (doc.url ? 'Replace' : 'Upload')}
                                  </Button>
                                </label>
                                  {doc.url ? (
                                  <Button
                                    size="small"
                                    variant="text"
                                    color="error"
                                    disabled={uploadingField === doc.key}
                                    onClick={() => handleDeleteDocument(doc.key)}
                                    sx={{ fontSize: '0.65rem', fontWeight: 700 }}
                                  >
                                    {uploadingField === doc.key ? <CircularProgress size={12} /> : 'Remove'}
                                  </Button>
                                ) : null}
                              </Stack>
                            </CardContent>
                            {doc.url && !erroredDocs[doc.key] ? (
                              <CardMedia
                                component="img"
                                height="220"
                                image={doc.url}
                                alt={doc.title}
                                sx={{ objectFit: 'cover', bgcolor: 'white', cursor: 'pointer' }}
                                onClick={() => window.open(doc.url, '_blank')}
                                onError={() => setErroredDocs((prev) => ({ ...prev, [doc.key]: true }))}
                              />
                            ) : doc.url ? (
                              <Box sx={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', bgcolor: 'white', gap: 1 }}>
                                <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 700 }}>IMAGE UNAVAILABLE</Typography>
                                <Button size="small" variant="text" onClick={() => window.open(doc.url, '_blank')}>Open in new tab</Button>
                              </Box>
                            ) : (
                              <Box sx={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'white' }}>
                                <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 700 }}>DOCUMENT NOT PROVIDED</Typography>
                              </Box>
                            )}
                          </Card>
                        </Grid>
                      ));
                    })()}
                  </Grid>
                </Box>

                {/* Document Requirements */}
                {docRequirements.length > 0 && (
                  <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
                    <Typography variant="subtitle1" sx={{ mb: 3, fontWeight: 800 }}>
                      Document Resubmission History
                    </Typography>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Document</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell>Reason</TableCell>
                            <TableCell>Requested</TableCell>
                            <TableCell>Actions</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {docRequirements.map((r: any) => {
                            const docLabels: Record<string, string> = {
                              license_photo_url: 'License (Front)',
                              license_photo_back_url: 'License (Back)',
                              insurance_photo_url: 'Insurance',
                              registration_photo_url: 'Registration',
                              inspection_photo_url: 'Inspection',
                              id_photo_front_url: 'ID (Front)',
                              id_photo_back_url: 'ID (Back)',
                            };
                            return (
                              <TableRow key={r.id} hover>
                                <TableCell>
                                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                    {docLabels[r.document_type] || r.document_type}
                                  </Typography>
                                </TableCell>
                                <TableCell>
                                  <Chip
                                    label={r.status.replace('_', ' ').toUpperCase()}
                                    size="small"
                                    color={
                                      r.status === 'reviewed' && r.review_decision === 'approved' ? 'success'
                                        : r.status === 'reviewed' && r.review_decision === 'rejected' ? 'error'
                                        : r.status === 'submitted' ? 'info'
                                        : 'warning'
                                    }
                                    sx={{ fontWeight: 800, height: 22, fontSize: '0.65rem' }}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Typography variant="body2" sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {r.request_reason}
                                  </Typography>
                                </TableCell>
                                <TableCell>
                                  <Typography variant="body2">
                                    {format(new Date(r.requested_at), 'PP')}
                                  </Typography>
                                </TableCell>
                                <TableCell>
                                  {r.status === 'submitted' && (
                                    <Stack direction="row" spacing={1}>
                                      {r.new_document_url && (
                                        <Button
                                          size="small"
                                          variant="text"
                                          color="info"
                                          onClick={() => {
                                            const urls = r.new_document_url.startsWith('[')
                                              ? JSON.parse(r.new_document_url)
                                              : [r.new_document_url];
                                            urls.forEach((u: string) => window.open(u, '_blank'));
                                          }}
                                          sx={{ borderRadius: '8px', height: 30, fontSize: '0.7rem' }}
                                        >
                                          View Docs
                                        </Button>
                                      )}
                                      <Button
                                        size="small"
                                        variant="contained"
                                        color="success"
                                        onClick={() => handleReviewDocument(r.id, 'approved')}
                                        disabled={actionLoading}
                                        sx={{ borderRadius: '8px', height: 30, fontSize: '0.7rem' }}
                                      >
                                        {actionLoading ? <CircularProgress size={14} color="inherit" /> : 'Accept'}
                                      </Button>
                                      <Button
                                        size="small"
                                        variant="outlined"
                                        color="error"
                                        onClick={() => handleReviewDocument(r.id, 'rejected')}
                                        disabled={actionLoading}
                                        sx={{ borderRadius: '8px', height: 30, fontSize: '0.7rem' }}
                                      >
                                        {actionLoading ? <CircularProgress size={14} color="inherit" /> : 'Reject'}
                                      </Button>
                                    </Stack>
                                  )}
                                  {r.status === 'reviewed' && (
                                    <Chip
                                      label={r.review_decision === 'approved' ? 'Accepted' : 'Rejected'}
                                      size="small"
                                      color={r.review_decision === 'approved' ? 'success' : 'error'}
                                      variant="outlined"
                                      sx={{ fontWeight: 700, height: 22, fontSize: '0.65rem' }}
                                    />
                                  )}
                                  {r.status === 'resubmission_required' && (
                                    <Chip label="Awaiting" size="small" variant="outlined" sx={{ fontWeight: 700, height: 22, fontSize: '0.65rem' }} />
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Paper>
                )}

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

            {!isDriver && user.role === 'RIDER' && (
              <Box>
                <Typography variant="subtitle1" sx={{ mb: 2, fontWeight: 800 }}>Identity Verification (KYC)</Typography>
                <Grid container spacing={2} {...({ component: 'div' } as any)}>
                  {[
                    { title: 'Identity Card (Front)', key: 'id_photo_front_url', url: user.id_photo_front_url },
                    { title: 'Identity Card (Back)', key: 'id_photo_back_url', url: user.id_photo_back_url }
                  ].map((doc, idx) => (
                    <Grid item xs={12} sm={6} key={idx} {...({ component: 'div' } as any)}>
                      <Card sx={{ border: '1px solid #eee', boxShadow: 'none' }}>
                        <CardContent sx={{ py: 1.5, px: 2, bgcolor: '#fafafa', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Typography variant="caption" sx={{ fontWeight: 800 }}>{doc.title}</Typography>
                          <Stack direction="row" spacing={0.5}>
                            <input
                              type="file"
                              accept="image/*"
                              id={`upload-${doc.key}`}
                              style={{ display: 'none' }}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileSelected(doc.key, file);
                                e.target.value = '';
                              }}
                            />
                            <label htmlFor={`upload-${doc.key}`}>
                              <Button
                                size="small"
                                variant="text"
                                color="primary"
                                component="span"
                                disabled={uploadingField === doc.key}
                                sx={{ fontSize: '0.65rem', fontWeight: 700 }}
                              >
                                {uploadingField === doc.key ? '...' : 'Replace'}
                              </Button>
                            </label>
                            {doc.url ? (
                              <Button
                                size="small"
                                variant="text"
                                color="error"
                                disabled={uploadingField === doc.key}
                                onClick={() => handleDeleteDocument(doc.key)}
                                sx={{ fontSize: '0.65rem', fontWeight: 700 }}
                              >
                                Remove
                              </Button>
                            ) : null}
                          </Stack>
                        </CardContent>
                        {doc.url ? (
                          <CardMedia
                            component="img"
                            height="340"
                            image={doc.url}
                            alt={doc.title}
                            sx={{ objectFit: 'cover', bgcolor: 'white', cursor: 'pointer' }}
                            onClick={() => window.open(doc.url, '_blank')}
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
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Confirm Rejection'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Request Document Resubmission Dialog */}
      <Dialog
        open={requestDocsOpen}
        onClose={() => setRequestDocsOpen(false)}
        {...({
          PaperProps: { sx: { borderRadius: 4, p: 1, maxWidth: 450 } }
        } as any)}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Request Document Resubmission</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 3, color: 'text.secondary', fontWeight: 500 }}>
            Request the driver to upload a new version of the selected document. The driver will be notified via email and in-app.
          </Typography>
          <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 1 }}>Document: {requestDocType}</Typography>
          <TextField
            autoFocus
            fullWidth
            label="Reason for resubmission"
            multiline
            rows={3}
            variant="filled"
            value={requestDocReason}
            onChange={(e) => setRequestDocReason(e.target.value)}
            sx={{ '& .MuiFilledInput-root': { borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button onClick={() => setRequestDocsOpen(false)} color="inherit" sx={{ fontWeight: 700 }}>Cancel</Button>
          <Button
            onClick={handleRequestDocument}
            color="warning"
            variant="contained"
            disabled={!requestDocReason.trim() || actionLoading}
            sx={{ px: 4, borderRadius: '12px' }}
          >
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Send Request'}
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
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Clear Flag'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Block User Dialog */}
      <Dialog
        open={blockDialogOpen}
        onClose={() => setBlockDialogOpen(false)}
        {...({
          PaperProps: { sx: { borderRadius: 4, p: 1, maxWidth: 450 } }
        } as any)}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Block User</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 3, color: 'text.secondary', fontWeight: 500 }}>
            This will immediately block the user. They will be shown a dedicated
            blocked-account screen stating the reason below. This action is logged
            in the audit trail.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Reason for blocking"
            multiline
            rows={4}
            variant="filled"
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            sx={{ '& .MuiFilledInput-root': { borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button onClick={() => setBlockDialogOpen(false)} color="inherit" sx={{ fontWeight: 700 }}>Cancel</Button>
          <Button
            onClick={handleTriggerFaceCheck}
            color="error"
            variant="contained"
            disabled={!blockReason.trim() || actionLoading}
            sx={{ px: 4, borderRadius: '12px' }}
          >
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Confirm Block'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Vehicle Resubmission Request Dialog */}
      <Dialog
        open={vehicleResubmitOpen}
        onClose={() => { setVehicleResubmitOpen(false); setVehicleResubmitReason(''); }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Request Vehicle Resubmission</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This will mark the driver's currently approved vehicle as requiring resubmission.
            The driver will see a notification on their home screen and must submit a new vehicle for review.
          </Typography>
          <TextField
            fullWidth
            multiline
            rows={3}
            variant="filled"
            label="Reason for resubmission"
            placeholder="Explain why the driver needs to resubmit their vehicle..."
            value={vehicleResubmitReason}
            onChange={(e) => setVehicleResubmitReason(e.target.value)}
            sx={{ '& .MuiFilledInput-root': { borderRadius: 2 } }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button
            onClick={() => { setVehicleResubmitOpen(false); setVehicleResubmitReason(''); }}
            color="inherit"
            sx={{ fontWeight: 700 }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleVehicleResubmission}
            color="warning"
            variant="contained"
            disabled={actionLoading || !vehicleResubmitReason.trim()}
            sx={{ px: 4, borderRadius: '12px' }}
          >
            {actionLoading ? 'Sending...' : 'Request Resubmission'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="info"
          onClose={() => setSnackbar({ open: false, message: '' })}
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default UserDetail;
