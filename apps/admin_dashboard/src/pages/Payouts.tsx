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
  Button,
  Drawer,
  Divider,
  Stack,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/CheckCircle';
import PaidIcon from '@mui/icons-material/Paid';
import { format } from '../utils/date';
import api from '../api';
import { listPayouts, markPayoutPaid } from '../api/admin';

const fmtUSD = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_TABS: Array<{ value: 'PENDING' | 'PAID' | 'ALL'; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'PAID', label: 'Paid' },
  { value: 'ALL', label: 'All' },
];

const Payouts: React.FC = () => {
  const [status, setStatus] = useState<'PENDING' | 'PAID' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [payouts, setPayouts] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listPayouts(status);
      setPayouts(data?.payouts ?? []);
    } catch (err) {
      console.error('Failed to fetch payouts', err);
      setPayouts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = window.setInterval(fetchData, 60_000);
    return () => window.clearInterval(id);
  }, [status]);

  const handleMarkPaid = async () => {
    if (!selected || !reference.trim()) return;
    setActionLoading(true);
    try {
      await markPayoutPaid(selected.id, reference.trim(), notes.trim() || undefined);
      setSelected(null);
      setMarkPaidOpen(false);
      setReference('');
      setNotes('');
      await fetchData();
    } catch (err) {
      console.error('Mark-paid failed', err);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Payouts
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            On-demand and weekly auto-payouts. Mark-paid marks the transfer complete outside the app.
          </Typography>
        </Box>
      </Stack>

      <Paper sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
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
        ) : payouts.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Typography sx={{ color: 'text.secondary' }}>No payouts in this state.</Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#FAFAFA' }}>
                  <TableCell sx={{ fontWeight: 700 }}>Driver</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Method</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Amount</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Fee</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Net</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Requested</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {payouts.map((p) => (
                  <TableRow key={p.id} hover onClick={() => setSelected(p)} sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                        <Typography sx={{ fontWeight: 700 }}>{p.full_name ?? '—'}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {p.email ?? ''}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={p.method === 'WEEKLY_AUTO' ? 'Weekly Auto' : p.method === 'ON_DEMAND' ? 'On-Demand' : p.method}
                        size="small"
                        sx={{ fontWeight: 700, backgroundColor: '#EEF1F4' }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{fmtUSD(Number(p.amount_cents))}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{fmtUSD(Number(p.fee_cents))}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{fmtUSD(Number(p.net_cents))}</TableCell>
                    <TableCell>
                      {p.requested_at ? format(new Date(p.requested_at), 'MMM d, yyyy · HH:mm') : '—'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={p.status}
                        size="small"
                        sx={{
                          fontWeight: 700,
                          backgroundColor: p.status === 'PAID' ? '#E5F0EB' : '#FCE9E9',
                          color: p.status === 'PAID' ? '#5B7760' : '#C65A5A',
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Detail drawer */}
      <Drawer
        anchor="right"
        open={!!selected}
        onClose={() => setSelected(null)}
        {...({ PaperProps: { sx: { width: { xs: '100%', sm: 440 }, p: 3 } } } as any)}
      >
        {selected && (
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800, mb: 0.5 }}>
              Payout {selected.id.slice(0, 8)}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {selected.method === 'WEEKLY_AUTO' ? 'Weekly Auto-Payout' : 'On-Demand'}
            </Typography>
            <Divider sx={{ my: 2 }} />
            <Stack spacing={1.5}>
              <Row label="Driver" value={selected.full_name ?? '—'} />
              <Row label="Email" value={selected.email ?? '—'} />
              <Row label="Amount" value={fmtUSD(Number(selected.amount_cents))} />
              <Row label="Fee" value={fmtUSD(Number(selected.fee_cents))} />
              <Row label="Net" value={fmtUSD(Number(selected.net_cents))} />
              <Row label="Requested" value={selected.requested_at ? format(new Date(selected.requested_at), 'MMM d, yyyy · HH:mm') : '—'} />
              <Row label="Processed" value={selected.processed_at ? format(new Date(selected.processed_at), 'MMM d, yyyy · HH:mm') : '—'} />
              <Row label="Reference" value={selected.reference ?? '—'} />
              <Row label="Notes" value={selected.notes ?? '—'} />
              <Row label="Ride ID" value={selected.ride_id ?? '—'} />
            </Stack>
            {selected.status === 'PENDING' && selected.method !== 'RIDE_CREDIT' && (
              <>
                <Divider sx={{ my: 3 }} />
                <Button
                  variant="contained"
                  startIcon={<PaidIcon />}
                  disabled={actionLoading}
                  onClick={() => setMarkPaidOpen(true)}
                  sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700, py: 1.2 }}
                >
                  Mark as Paid…
                </Button>
              </>
            )}
          </Box>
        )}
      </Drawer>

      <Dialog open={markPaidOpen} onClose={() => setMarkPaidOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ fontWeight: 800 }}>Mark Payout as Paid</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
            Process the bank transfer outside the app, then enter the transfer reference so it shows up on the
            receipt emailed to the driver.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Payment reference"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            multiline
            minRows={2}
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={() => setMarkPaidOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            onClick={handleMarkPaid}
            disabled={!reference.trim() || actionLoading}
            variant="contained"
            startIcon={actionLoading ? undefined : <CheckIcon />}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700 }}
          >
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Confirm Paid'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

const Row: React.FC<{ label: string; value: any }> = ({ label, value }) => (
  <Box>
    <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
      {label}
    </Typography>
    <Typography sx={{ fontWeight: 600, wordBreak: 'break-word' }}>{value ?? '—'}</Typography>
  </Box>
);

export default Payouts;