import React from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Snackbar,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
} from '@mui/material';
import AddCardIcon from '@mui/icons-material/AddCard';
import { getPortalFunding, createPortalFundingSession, type PortalFundingData } from '../api/sponsor';

const fmtUSD = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  SUCCEEDED: 'success',
  PENDING: 'info',
  PROCESSING: 'info',
  REQUIRES_ACTION: 'warning',
  FAILED: 'error',
  CANCELED: 'default',
  REFUNDED: 'warning',
};

const Funding: React.FC = () => {
  const [data, setData] = React.useState<PortalFundingData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await getPortalFunding();
      setData(res);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    load();
  }, []);

  const startFunding = async () => {
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setSnack({ open: true, message: 'Enter a valid amount', severity: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await createPortalFundingSession(amountCents);
      // Checkout is Stripe-hosted; the budget is only credited from the
      // verified webhook, never from this redirect.
      window.location.assign(res.url);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Funding session failed';
      setSnack({ open: true, message: msg, severity: 'error' });
      setSubmitting(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
            Budget &amp; funding
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Prepay your budget with a card. Costs are reserved and settled only when riders redeem your codes.
          </Typography>
        </Box>
        {data && (
          <Chip
            label={`Stripe: ${data.mode}${data.configured ? '' : ' (not configured)'}`}
            color={data.mode === 'test' ? 'warning' : data.mode === 'live' ? 'success' : 'default'}
          />
        )}
      </Box>

      {loading && <CircularProgress />}

      {!loading && data && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2, mb: 3 }}>
            {[
              { label: 'Funded (total)', value: fmtUSD(data.budget.initialBudgetCents) },
              { label: 'Available', value: fmtUSD(data.budget.spendableBudgetCents), hint: 'remaining minus reserved' },
              { label: 'Reserved', value: fmtUSD(data.budget.reservedBudgetCents), hint: 'held for pending specials' },
              { label: 'Used', value: fmtUSD(data.budget.usedBudgetCents), hint: 'settled redemptions' },
            ].map((m) => (
              <Paper key={m.label} sx={{ p: 2.5, borderRadius: 3 }}>
                <Typography variant="caption" color="text.secondary">{m.label}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }}>{m.value}</Typography>
                {m.hint && <Typography variant="caption" color="text.secondary">{m.hint}</Typography>}
              </Paper>
            ))}
          </Box>

          <Button variant="contained" size="large" startIcon={<AddCardIcon />} onClick={() => setOpen(true)} sx={{ mb: 3 }}>
            Add funds
          </Button>

          <Paper sx={{ borderRadius: 3, overflow: 'hidden' }}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Payment intent</TableCell>
                    <TableCell>Failure</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.payments.map((p) => (
                    <TableRow key={p.id} hover>
                      <TableCell>{new Date(p.created_at).toLocaleString()}</TableCell>
                      <TableCell align="right">{fmtUSD(p.amount_cents)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={p.status} color={STATUS_COLOR[p.status] ?? 'default'} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                          {p.stripe_payment_intent_id ?? '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="error">{p.failure_reason ?? ''}</Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.payments.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        No funding payments yet. Add funds to start offering deals.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Add funds</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            You will be redirected to Stripe Checkout. Your budget is credited only after the payment is confirmed.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Amount (USD)"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={submitting} onClick={startFunding}>
            Continue to payment
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack.open}
        autoHideDuration={6000}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snack.severity} onClose={() => setSnack((s) => ({ ...s, open: false }))}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Funding;