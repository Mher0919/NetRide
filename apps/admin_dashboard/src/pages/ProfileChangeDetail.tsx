import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
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
  Breadcrumbs,
  Link,
  Stack,
  Card,
  CardContent,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import CheckIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import BackIcon from '@mui/icons-material/ArrowBack';
import { format } from '../utils/date';
import api from '../api';
import { approveProfileChange, rejectProfileChange } from '../api/admin';

interface ChangeRow {
  label: string;
  before: any;
  after: any;
  type?: 'text' | 'image' | 'card' | 'date';
}

const ProfileChangeDetail: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/profile-changes/${id}`);
      setData(r.data);
    } catch (err) {
      console.error('Failed to fetch profile change', err);
      navigate('/profile-changes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [id]);

  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await approveProfileChange(id!);
      await fetchData();
    } catch (err) {
      console.error('Approve failed', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!reason.trim()) return;
    setActionLoading(true);
    try {
      await rejectProfileChange(id!, reason.trim());
      setRejectOpen(false);
      await fetchData();
    } catch (err) {
      console.error('Reject failed', err);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!data) return null;

  const change: any = data.change;
  const driver: any = data.driver;
  const vehicle: any = data.vehicle;
  const requested: Record<string, any> = change?.requested_changes ?? {};
  const status: string = change?.status ?? 'PENDING';

  // Build before/after diff rows
  const rows: ChangeRow[] = [];
  const pushRow = (label: string, before: any, after: any, type: ChangeRow['type'] = 'text') =>
    rows.push({ label, before, after, type });

  if (requested.full_name !== undefined) pushRow('Full Name', driver?.full_name ?? '—', requested.full_name);
  if (requested.phone_number !== undefined) pushRow('Phone', '—', requested.phone_number);
  if (requested.date_of_birth !== undefined) pushRow('Date of Birth', change?.date_of_birth ? new Date(change.date_of_birth).toISOString().split('T')[0] : 'Not set', requested.date_of_birth, 'date');
  if (requested.profile_image_url !== undefined) pushRow('Profile Photo', '—', requested.profile_image_url, 'image');
  if (requested.license_number !== undefined) pushRow('License #', driver?.license_number ?? '—', requested.license_number);
  if (requested.make !== undefined) pushRow('Vehicle Make', vehicle?.make ?? '—', requested.make);
  if (requested.model !== undefined) pushRow('Vehicle Model', vehicle?.model ?? '—', requested.model);
  if (requested.year !== undefined) pushRow('Vehicle Year', vehicle?.year ?? '—', requested.year);
  if (requested.color !== undefined) pushRow('Vehicle Color', vehicle?.color ?? '—', requested.color);
  if (requested.license_plate_number !== undefined) pushRow('Plate', vehicle?.license_plate_number ?? '—', requested.license_plate_number);
  if (requested.license_plate_photo_url !== undefined) pushRow('Plate Photo', '—', requested.license_plate_photo_url, 'image');
  if (requested.inspection_photo_url !== undefined) pushRow('Inspection Photo', '—', requested.inspection_photo_url, 'image');
  if (requested.car_photo_urls !== undefined) pushRow('Car Photos', '—', 'Updated', 'image');
  if (requested.payout_card !== undefined) {
    pushRow(
      'Payout Card',
      '—',
      `${(change?.card_brand ?? 'card').toUpperCase()} •••• ${change?.card_last4 ?? ''}`,
      'card'
    );
  }

  const renderCell = (val: any, type?: string) => {
    if (val === null || val === undefined || val === '') return <Typography sx={{ color: 'text.disabled' }}>—</Typography>;
    if (type === 'image') {
      return (
        <Box
          component="img"
          src={val}
          alt=""
          onClick={() => setPreviewImage(val)}
          sx={{ width: 100, height: 70, objectFit: 'cover', borderRadius: 1.5, border: '1px solid rgba(0,0,0,0.06)', cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
        />
      );
    }
    if (type === 'date') {
      try {
        return <Typography sx={{ wordBreak: 'break-word' }}>{format(new Date(val), 'MMM d, yyyy')}</Typography>;
      } catch {
        return <Typography>{val}</Typography>;
      }
    }
    return <Typography sx={{ wordBreak: 'break-word' }}>{String(val)}</Typography>;
  };

  return (
    <Box>
      <Breadcrumbs sx={{ mb: 2 }}>
        <Link component={RouterLink as any} to="/profile-changes" underline="hover" color="inherit">
          Profile Changes
        </Link>
        <Typography color="text.primary">{change?.id?.slice(0, 8) ?? '—'}</Typography>
      </Breadcrumbs>

      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Profile Change Review
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Submitted {change?.created_at ? format(new Date(change.created_at), 'MMM d, yyyy · HH:mm') : '—'}
          </Typography>
        </Box>
        <Chip
          label={status}
          sx={{
            fontWeight: 800,
            backgroundColor:
              status === 'PENDING' ? '#FCE9E9'
              : status === 'APPROVED' ? '#E5F0EB'
              : '#F2F2F2',
            color:
              status === 'PENDING' ? '#C65A5A'
              : status === 'APPROVED' ? '#5B7760'
              : 'text.secondary',
          }}
        />
      </Stack>

      <Grid container spacing={3}>
        {/* LEFT — driver snapshot */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
            <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
              <Avatar
                src={change?.profile_image_url ?? undefined}
                onClick={() => change?.profile_image_url && setPreviewImage(change.profile_image_url)}
                sx={{ width: 56, height: 56, bgcolor: 'primary.main', fontWeight: 700, cursor: change?.profile_image_url ? 'pointer' : 'default' }}
              >
                {(change?.full_name ?? '?').charAt(0)}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700 }}>{change?.full_name ?? '—'}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>
                  {change?.email ?? ''}
                </Typography>
              </Box>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <DetailRow label="Current License #" value={driver?.license_number} />
            <DetailRow label="Current Vehicle" value={vehicle ? `${vehicle.make ?? ''} ${vehicle.model ?? ''} (${vehicle.year ?? ''})` : null} />
            <DetailRow label="Current Plate" value={vehicle?.license_plate_number} />
            <Box sx={{ mt: 2 }}>
              <Button
                startIcon={<BackIcon />}
                size="small"
                onClick={() => navigate(`/users/${change?.driver_id}`)}
                sx={{ textTransform: 'none' }}
              >
                Open full driver record
              </Button>
            </Box>
          </Paper>

          {/* Action card */}
          <Card sx={{ mt: 2, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
            {requested._reason && (
              <Box sx={{ px: 3, pt: 2 }}>
                <Typography sx={{ fontSize: 11, fontWeight: 700, color: '#8B7A3A', textTransform: 'uppercase', mb: 0.5 }}>
                  Driver's Note
                </Typography>
                <Typography sx={{ fontSize: 14, color: '#5C4E1E', mb: 1 }}>{requested._reason}</Typography>
              </Box>
            )}
            <CardContent>
              <Typography sx={{ fontWeight: 800, mb: 1.5 }}>Decision</Typography>
              {status === 'PENDING' ? (
                <Stack spacing={1.5}>
                  <Button
                    variant="contained"
                    startIcon={actionLoading ? undefined : <CheckIcon />}
                    disabled={actionLoading}
                    onClick={handleApprove}
                    sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700, py: 1.2 }}
                  >
                    {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Approve Changes'}
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<CancelIcon />}
                    disabled={actionLoading}
                    onClick={() => setRejectOpen(true)}
                    sx={{ textTransform: 'none', fontWeight: 700, py: 1.2, borderColor: '#C65A5A', color: '#C65A5A' }}
                  >
                    Reject…
                  </Button>
                </Stack>
              ) : (
                <Typography sx={{ color: 'text.secondary' }}>
                  Reviewed by admin on{' '}
                  {change?.reviewed_at ? format(new Date(change.reviewed_at), 'MMM d, yyyy · HH:mm') : '—'}.
                  {change?.rejection_reason ? ` Reason: ${change.rejection_reason}` : ''}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* RIGHT — before/after diff */}
        <Grid size={{ xs: 12, md: 8 }}>
          <Paper sx={{ p: 0, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
            <Box sx={{ p: 3, pb: 1.5 }}>
              <Typography sx={{ fontWeight: 800 }}>Requested Changes</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Card data shown is masked — PAN and CVC are never stored.
              </Typography>
            </Box>
            <Divider />
            {rows.length === 0 ? (
              <Box sx={{ p: 4, textAlign: 'center' }}>
                <Typography sx={{ color: 'text.secondary' }}>No fields to compare.</Typography>
              </Box>
            ) : (
              rows.map((row, idx) => (
                <Box key={row.label}>
                  <Grid container sx={{ px: 3, py: 2 }} spacing={2}>
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {row.label}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4.5 }}>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.disabled', textTransform: 'uppercase', mb: 0.5 }}>
                        Current
                      </Typography>
                      <Box sx={{ p: 1.5, backgroundColor: '#FAFAFA', borderRadius: 2, minHeight: 44 }}>
                        {renderCell(row.before, row.type)}
                      </Box>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4.5 }}>
                      <Typography sx={{ fontSize: 11, fontWeight: 700, color: '#5B7760', textTransform: 'uppercase', mb: 0.5 }}>
                        Requested
                      </Typography>
                      <Box sx={{ p: 1.5, backgroundColor: '#E5F0EB', borderRadius: 2, minHeight: 44 }}>
                        {renderCell(row.after, row.type)}
                      </Box>
                    </Grid>
                  </Grid>
                  {idx < rows.length - 1 && <Divider />}
                </Box>
              ))
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Image preview dialog */}
      <Dialog open={!!previewImage} onClose={() => setPreviewImage(null)} maxWidth="lg">
        <Box
          component="img"
          src={previewImage ?? ''}
          alt="Preview"
          onClick={() => setPreviewImage(null)}
          sx={{ maxWidth: '90vw', maxHeight: '90vh', cursor: 'pointer', objectFit: 'contain' }}
        />
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ fontWeight: 800 }}>Reject Profile Change</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
            The driver will receive an email with this reason. The driver's account is NOT suspended — they remain
            unblocked from going online.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={() => setRejectOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            onClick={handleReject}
            disabled={!reason.trim() || actionLoading}
            variant="contained"
            sx={{ backgroundColor: '#C65A5A', '&:hover': { backgroundColor: '#B14848' }, textTransform: 'none', fontWeight: 700 }}
          >
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Reject'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

const DetailRow: React.FC<{ label: string; value: any }> = ({ label, value }) => (
  <Box sx={{ mb: 1.5 }}>
    <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label}
    </Typography>
    <Typography sx={{ wordBreak: 'break-word' }}>{value ?? '—'}</Typography>
  </Box>
);

export default ProfileChangeDetail;
