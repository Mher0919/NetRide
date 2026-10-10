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
  Stack,
  Divider,
} from '@mui/material';
import AddCardIcon from '@mui/icons-material/AddCard';
import SavingsIcon from '@mui/icons-material/Savings';
import {
  getPortalFunding,
  createPortalFundingSession,
  getPortalPaymentMethod,
  createPortalCardSetupSession,
  getPortalWithdrawals,
  requestPortalWithdrawal,
  type PortalFundingData,
  type SponsorWithdrawalState,
} from '../api/sponsor';

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
  COMPLETED: 'success',
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : '—';

interface WithdrawalRow {
  id: string;
  amount_cents: number;
  status: string;
  failure_reason: string | null;
  requested_at: string;
  completed_at: string | null;
}

const Funding: React.FC = () => {
  const [data, setData] = React.useState<PortalFundingData | null>(null);
  const [card, setCard] = React.useState<{ brand: string | null; last4: string } | null>(null);
  const [wState, setWState] = React.useState<SponsorWithdrawalState | null>(null);
  const [withdrawals, setWithdrawals] = React.useState<WithdrawalRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [funding, pm, wd] = await Promise.all([
        getPortalFunding(),
        getPortalPaymentMethod().catch(() => null),
        getPortalWithdrawals().catch(() => null),
      ]);
      setData(funding);
      setCard(pm?.card ?? null);
      setWState(wd?.state ?? null);
      setWithdrawals(wd?.withdrawals ?? []);
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

  const addCard = async () => {
    setSubmitting(true);
    try {
      const res = await createPortalCardSetupSession();
      window.location.assign(res.url);
      // Card is saved on Stripe's side; the payment profile refreshes on
      // return via the webhook.
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Card setup failed';
      setSnack({ open: true, message: msg, severity: 'error' });
      setSubmitting(false);
    }
  };

  const startWithdrawal = async () => {
    const amountCents = Math.round(Number(withdrawAmount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setSnack({ open: true, message: 'Enter a valid amount', severity: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await requestPortalWithdrawal(amountCents);
      setSnack({
        open: true,
        message:
          res.withdrawal.status === 'COMPLETED'
            ? `Withdrawal of ${fmtUSD(res.withdrawal.amount_cents)} processed — refunded to your funding card.`
            : `Withdrawal of ${fmtUSD(res.withdrawal.amount_cents)} requested — being processed.`,
        severity: res.withdrawal.status === 'COMPLETED' ? 'success' : 'info',
      });
      setWithdrawOpen(false);
      setWithdrawAmount('');
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Withdrawal failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const maxWithdraw = Math.max(0, (data?.budget.spendableBudgetCents ?? 0) / 100);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
            Budget &amp; funding
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Add funds with a card and withdraw unused budget manually (once per week — the next window always opens Monday).
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

          <Paper sx={{ p: 2.5, borderRadius: 3, mb: 3 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between">
              <Box>
                <Typography variant="caption" color="text.secondary">Saved card</Typography>
                <Typography variant="body1" sx={{ fontWeight: 700 }}>
                  {card
                    ? `${(card.brand ?? '').toUpperCase()} •••• ${card.last4}`
                    : 'No card saved yet'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Used to pay top-ups and to receive withdrawals (refunded to the funding card).
                </Typography>
              </Box>
              <Button variant="outlined" startIcon={<AddCardIcon />} disabled={submitting} onClick={addCard}>
                {card ? 'Replace card' : 'Add card'}
              </Button>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between">
              <Box>
                <Typography variant="caption" color="text.secondary">Manual withdrawal</Typography>
                <Typography variant="body1" sx={{ fontWeight: 700 }}>
                  {wState?.eligible === false
                    ? `Next withdrawal opens ${fmtDate(wState.nextAvailableAt)}`
                    : 'A withdrawal is available now'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Once per week — withdrawals open every Monday, no matter when you last withdrew. Refunded to your funding card.
                </Typography>
              </Box>
              <Button
                variant="contained"
                startIcon={<SavingsIcon />}
                disabled={submitting || wState?.eligible === false || data.budget.spendableBudgetCents <= 0}
                onClick={() => setWithdrawOpen(true)}
              >
                Withdraw funds
              </Button>
            </Stack>
            {wState?.eligible === false && (
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                The weekly window opens on Mondays; you can make one withdrawal per week.
              </Typography>
            )}
          </Paper>

          <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
            <Button size="large" startIcon={<AddCardIcon />} onClick={() => setOpen(true)}>
              Add funds
            </Button>
          </Stack>

          <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>Funding history</Typography>
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

          <Typography variant="h6" sx={{ fontWeight: 800, mb: 1, mt: 4 }}>Withdrawal history</Typography>
          <Paper sx={{ borderRadius: 3, overflow: 'hidden' }}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Requested</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Completed</TableCell>
                    <TableCell>Failure</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {withdrawals.map((w) => (
                    <TableRow key={w.id} hover>
                      <TableCell>{fmtDate(w.requested_at)}</TableCell>
                      <TableCell align="right">{fmtUSD(w.amount_cents)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={w.status} color={STATUS_COLOR[w.status] ?? 'default'} />
                      </TableCell>
                      <TableCell>{fmtDate(w.completed_at)}</TableCell>
                      <TableCell>
                        <Typography variant="caption" color="error">{w.failure_reason ?? ''}</Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                  {withdrawals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        No withdrawals yet.
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

      <Dialog open={withdrawOpen} onClose={() => setWithdrawOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Withdraw funds</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The amount is refunded to your funding card. Maximum{' '}
            {fmtUSD(data?.budget.spendableBudgetCents ?? 0)} (your available budget). One withdrawal per week — the next window always opens Monday.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Amount (USD)"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            helperText={`Max ${maxWithdraw.toFixed(2)}`}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWithdrawOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={submitting} onClick={startWithdrawal}>
            Withdraw
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