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
import CancelIcon from '@mui/icons-material/Cancel';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import { format } from 'date-fns';
import api from '../api';
import { listPayoutCards, approvePayoutCard, rejectPayoutCard } from '../api/admin';

const STATUS_TABS: Array<{ value: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'; label: string }> = [
  { value: 'PENDING', label: 'Pending Review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'ALL', label: 'All' },
];

const PayoutCards: React.FC = () => {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await listPayoutCards(status);
      setCards(data?.cards ?? []);
    } catch (err) {
      console.error('Failed to fetch payout cards', err);
      setCards([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = window.setInterval(fetchData, 60_000);
    return () => window.clearInterval(id);
  }, [status]);

  const handleApprove = async () => {
    if (!selected) return;
    setActionLoading(true);
    try {
      await approvePayoutCard(selected.id);
      setSelected(null);
      await fetchData();
    } catch (err) {
      console.error('Approve failed', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!selected || !rejectReason.trim()) return;
    setActionLoading(true);
    try {
      await rejectPayoutCard(selected.id, rejectReason.trim());
      setSelected(null);
      setRejectOpen(false);
      setRejectReason('');
      await fetchData();
    } catch (err) {
      console.error('Reject failed', err);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Payout Cards
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Drivers attach a card to receive wallet payouts. Only masked card data is shown — PAN/CVC are never stored.
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
        ) : cards.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Typography sx={{ color: 'text.secondary' }}>No cards in this state.</Typography>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow sx={{ backgroundColor: '#FAFAFA' }}>
                  <TableCell sx={{ fontWeight: 700 }}>Driver</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Card</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Expiry</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Submitted</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cards.map((c) => (
                  <TableRow key={c.id} hover onClick={() => setSelected(c)} sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                        <Typography sx={{ fontWeight: 700 }}>{c.driver?.full_name ?? c.cardholder_name ?? '—'}</Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          {c.driver?.email ?? ''}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <CreditCardIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                        <Typography sx={{ fontWeight: 700 }}>
                          {(c.brand ?? 'CARD').toUpperCase()} •••• {c.last4}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {String(c.exp_month ?? '??').padStart(2, '0')}/{c.exp_year ?? '????'}
                    </TableCell>
                    <TableCell>
                      {c.created_at ? format(new Date(c.created_at), 'MMM d, yyyy · HH:mm') : '—'}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={c.status}
                        size="small"
                        sx={{
                          fontWeight: 700,
                          backgroundColor:
                            c.status === 'PENDING' ? '#FCE9E9'
                            : c.status === 'APPROVED' ? '#E5F0EB'
                            : '#F2F2F2',
                          color:
                            c.status === 'PENDING' ? '#C65A5A'
                            : c.status === 'APPROVED' ? '#5B7760'
                            : 'text.secondary',
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
              Payout Card
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Submitted {selected.created_at ? format(new Date(selected.created_at), 'MMM d, yyyy · HH:mm') : '—'}
            </Typography>
            <Divider sx={{ my: 2 }} />
            <Stack spacing={1.5}>
              <Row label="Driver" value={selected.driver?.full_name ?? '—'} />
              <Row label="Email" value={selected.driver?.email ?? '—'} />
              <Row label="Cardholder" value={selected.cardholder_name ?? '—'} />
              <Row label="Brand" value={(selected.brand ?? '').toUpperCase()} />
              <Row label="Last 4" value={selected.last4} />
              <Row label="Expiry" value={`${String(selected.exp_month ?? '??').padStart(2, '0')}/${selected.exp_year ?? '????'}`} />
              <Row label="ZIP" value={selected.zip ?? '—'} />
              <Row label="Status" value={selected.status} />
            </Stack>
            {selected.status === 'PENDING' && (
              <>
                <Divider sx={{ my: 3 }} />
                <Stack spacing={1.5}>
                  <Button
                    variant="contained"
                    startIcon={<CheckIcon />}
                    disabled={actionLoading}
                    onClick={handleApprove}
                    sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700, py: 1.2 }}
                  >
                    Approve Card
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
              </>
            )}
          </Box>
        )}
      </Drawer>

      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ fontWeight: 800 }}>Reject Payout Card</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={3}
            label="Reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={() => setRejectOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            onClick={handleReject}
            disabled={!rejectReason.trim() || actionLoading}
            variant="contained"
            sx={{ backgroundColor: '#C65A5A', '&:hover': { backgroundColor: '#B14848' }, textTransform: 'none', fontWeight: 700 }}
          >
            Reject
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

export default PayoutCards;
