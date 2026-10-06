import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Tabs,
  Tab,
  Stack,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { format } from '../utils/date';
import { listProfileChanges } from '../api/admin';

const STATUS_TABS: Array<{ value: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'; label: string }> = [
  { value: 'PENDING', label: 'Pending Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All' },
];

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Name',
  phone_number: 'Phone',
  date_of_birth: 'Date of Birth',
  profile_image_url: 'Profile Photo',
  license_number: 'License #',
  license_photo_url: 'License Photo',
  vehicle_make: 'Vehicle Make',
  vehicle_model: 'Vehicle Model',
  vehicle_year: 'Vehicle Year',
  vehicle_color: 'Vehicle Color',
  license_plate_number: 'Plate',
  license_plate_photo_url: 'Plate Photo',
  inspection_photo_url: 'Inspection Photo',
  payout_card: 'Payout Card',
};

const fieldChip = (key: string) => (
  <Chip
    key={key}
    label={FIELD_LABELS[key] ?? key}
    size="small"
    sx={{
      mr: 0.5,
      mb: 0.5,
      backgroundColor: '#EEF1F4',
      color: 'text.primary',
      fontWeight: 600,
      fontSize: 11,
    }}
  />
);

const ProfileChanges: React.FC = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [requests, setRequests] = useState<any[]>([]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listProfileChanges(status);
      setRequests(data?.requests ?? []);
    } catch (err) {
      console.error('Failed to fetch profile changes', err);
      setRequests([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Poll every 60s for live counter accuracy.
    const id = window.setInterval(fetchData, 60_000);
    return () => window.clearInterval(id);
  }, [status]);

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Driver Profile Changes
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Edits awaiting admin approval. While pending, the driver is blocked from going online.
          </Typography>
        </Box>
      </Stack>

      <Paper sx={{ p: 0, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <Tabs
          value={status}
          onChange={(_, v) => setStatus(v)}
          sx={{
            borderBottom: '1px solid rgba(0,0,0,0.06)',
            px: 2,
            '& .MuiTab-root': { textTransform: 'none', fontWeight: 700, fontSize: 14 },
          }}
        >
          {STATUS_TABS.map((t) => (
            <Tab key={t.value} value={t.value} label={t.label} />
          ))}
        </Tabs>

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        ) : requests.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Typography sx={{ color: 'text.secondary' }}>No requests in this state.</Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#FAFAFA' }}>
                  <TableCell sx={{ fontWeight: 700 }}>Driver</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Fields Changed</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Card</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Submitted</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {requests.map((r) => {
                  const changes = r.requested_changes ?? {};
                  const changedKeys = Object.keys(changes).filter((k) => k !== 'payout_card');
                  return (
                    <TableRow
                      key={r.id}
                      hover
                      onClick={() => navigate(`/profile-changes/${r.id}`)}
                      sx={{ cursor: 'pointer' }}
                    >
                      <TableCell>
                        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                          <Typography sx={{ fontWeight: 700 }}>
                            {r.driver_name ?? '—'}
                          </Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            {r.driver_email ?? ''}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 320 }}>
                        {changedKeys.map(fieldChip)}
                        {changes.payout_card ? fieldChip('payout_card') : null}
                      </TableCell>
                      <TableCell>
                        {r.card_last4 ? (
                          <Chip
                            label={`${(r.card_brand ?? 'card').toUpperCase()} •••• ${r.card_last4}`}
                            size="small"
                            sx={{ backgroundColor: '#EEF1F4', fontWeight: 700 }}
                          />
                        ) : (
                          <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {r.created_at ? format(new Date(r.created_at), 'MMM d, yyyy · HH:mm') : '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={r.status}
                          size="small"
                          sx={{
                            fontWeight: 700,
                            backgroundColor:
                              r.status === 'PENDING' ? '#FCE9E9'
                              : r.status === 'APPROVED' ? '#E5F0EB'
                              : '#F2F2F2',
                            color:
                              r.status === 'PENDING' ? '#C65A5A'
                              : r.status === 'APPROVED' ? '#5B7760'
                              : 'text.secondary',
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Box>
  );
};

export default ProfileChanges;
