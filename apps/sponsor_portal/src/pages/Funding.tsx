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
  IconButton,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
} from '@mui/material';
import AddCardIcon from '@mui/icons-material/AddCard';
import SavingsIcon from '@mui/icons-material/Savings';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import {
  getPortalFunding,
  listPortalPaymentMethods,
  createPortalSetupIntent,
  confirmPortalSetupIntent,
  setPortalDefaultMethod,
  removePortalPaymentMethod,
  createPortalFundingIntent,
  confirmPortalFundingIntent,
  getPortalWithdrawals,
  requestPortalWithdrawal,
  type PortalFundingData,
  type SponsorWithdrawalState,
  type PortalPaymentMethod,
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

const cardLabel = (m: PortalPaymentMethod) =>
  `${(m.brand ?? 'CARD').toUpperCase()} •••• ${m.last4 ?? ''}${m.expMonth ? ` (${String(m.expMonth).padStart(2, '0')}/${(m.expYear ?? 0) % 100})` : ''}`;

const Funding: React.FC = () => {
  const [data, setData] = React.useState<PortalFundingData | null>(null);
  const [methods, setMethods] = React.useState<PortalPaymentMethod[]>([]);
  const [wState, setWState] = React.useState<SponsorWithdrawalState | null>(null);
  const [withdrawals, setWithdrawals] = React.useState<WithdrawalRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [addCardOpen, setAddCardOpen] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' | 'info' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [funding, pm, wd] = await Promise.all([
        getPortalFunding(),
        listPortalPaymentMethods().catch(() => [] as PortalPaymentMethod[]),
        getPortalWithdrawals().catch(() => null),
      ]);
      setData(funding);
      setMethods(pm);
      setWState(wd?.state ?? null);
      setWithdrawals(wd?.withdrawals ?? []);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    // Deferred so the initial `loading` state stays visible (avoids a
    // synchronous setState inside the effect body).
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const defaultMethod = methods.find((m) => m.isDefault) ?? null;

  const makeDefault = async (m: PortalPaymentMethod) => {
    try {
      await setPortalDefaultMethod(m.id);
      setSnack({ open: true, message: 'Default payment method updated.', severity: 'success' });
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Update failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    }
  };

  const removeCard = async (m: PortalPaymentMethod) => {
    if (!window.confirm(`Remove ${cardLabel(m)}?`)) return;
    try {
      await removePortalPaymentMethod(m.id);
      setSnack({ open: true, message: 'Payment method removed.', severity: 'success' });
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Remove failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    }
  };

  const startFunding = async () => {
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setSnack({ open: true, message: 'Enter a valid amount', severity: 'error' });
      return;
    }
    setSubmitting(true);
    try {
      const intent = await createPortalFundingIntent(amountCents);
      if (!intent.publishableKey) {
        setSnack({ open: true, message: 'Secure payments are not configured yet.', severity: 'error' });
        return;
      }
      const stripe = await loadStripe(intent.publishableKey);
      setFundingStripe(stripe);
      setFundingIntent({ ...intent, publishableKey: intent.publishableKey });
      setFundingCents(amountCents);
      setOpen(false);
      setAmount('');
      setFundingOpen(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Funding session failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  // In-dashboard card-entry flow state (Stripe Elements).
  const [cardSetup, setCardSetup] = React.useState<{
    setupIntentClientSecret: string;
    publishableKey: string;
    setupIntentId?: string;
  } | null>(null);
  const [cardStripe, setCardStripe] = React.useState<Stripe | null>(null);

  const [fundingIntent, setFundingIntent] = React.useState<{
    paymentRowId: string;
    clientSecret: string;
    paymentIntentId: string;
    publishableKey: string;
  } | null>(null);
  const [fundingCents, setFundingCents] = React.useState(0);
  const [fundingOpen, setFundingOpen] = React.useState(false);
  const [fundingStripe, setFundingStripe] = React.useState<Stripe | null>(null);

  const addCard = async () => {
    setSubmitting(true);
    try {
      const setup = await createPortalSetupIntent();
      if (!setup.publishableKey) {
        setSnack({ open: true, message: 'Secure payments are not configured yet.', severity: 'error' });
        setSubmitting(false);
        return;
      }
      const stripe = await loadStripe(setup.publishableKey);
      setCardSetup({ ...setup, publishableKey: setup.publishableKey });
      setCardStripe(stripe);
      setAddCardOpen(true);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Card setup failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
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
            Add funds with a card, manage saved payment methods, and withdraw unused budget manually (once per week — the next window always opens Monday).
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
                <Typography variant="caption" color="text.secondary">Saved payment method</Typography>
                <Typography variant="body1" sx={{ fontWeight: 700 }}>
                  {defaultMethod ? cardLabel(defaultMethod) : 'No card saved yet'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Used to pay top-ups and to receive withdrawals (refunded to the funding card).
                  Adding a card never charges it — charges only happen when you fund the budget.
                </Typography>
              </Box>
              <Button variant="outlined" startIcon={<AddCardIcon />} disabled={submitting} onClick={addCard}>
                {defaultMethod ? 'Add another card' : 'Add card'}
              </Button>
            </Stack>

            {methods.length > 1 && (
              <>
                <Divider sx={{ my: 1.5 }} />
                <List dense disablePadding>
                  {methods.map((m) => (
                    <ListItem key={m.id} disableGutters sx={{ px: 0 }}>
                      <ListItemText
                        primary={
                          <>
                            {cardLabel(m)}{' '}
                            {m.isDefault && (
                              <Chip
                                size="small"
                                icon={<CheckCircleIcon />}
                                label="Default"
                                sx={{ ml: 1, height: 20, '& .MuiChip-label': { fontSize: 11 }, color: 'success.main' }}
                              />
                            )}
                          </>
                        }
                        secondary={m.isDefault ? 'Used for payments and refunds' : 'Not in use'}
                      />
                      <ListItemSecondaryAction>
                        {!m.isDefault && (
                          <Button size="small" onClick={() => makeDefault(m)}>
                            Make default
                          </Button>
                        )}
                        {!m.isDefault && (
                          <IconButton size="small" color="error" onClick={() => removeCard(m)}>
                            <DeleteOutlinedIcon fontSize="small" />
                          </IconButton>
                        )}
                      </ListItemSecondaryAction>
                    </ListItem>
                  ))}
                </List>
              </>
            )}

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
            The card payment happens in this dashboard — no external redirect. Your budget is credited only after the payment is confirmed.
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
            Continue
          </Button>
        </DialogActions>
      </Dialog>

      {/* In-dashboard card payment (Payment Element) */}
      {fundingIntent && fundingStripe && (
        <Dialog open={fundingOpen} onClose={() => !submitting && setFundingOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle sx={{ fontWeight: 800 }}>Pay {fmtUSD(fundingCents)}</DialogTitle>
          <DialogContent>
            <Elements
              stripe={fundingStripe}
              options={{ clientSecret: fundingIntent.clientSecret, appearance: { theme: 'stripe' } }}
            >
              <FundPaymentForm
                paymentRowId={fundingIntent.paymentRowId}
                onDone={async () => {
                  setFundingOpen(false);
                  setSnack({ open: true, message: 'Budget funded — payment confirmed.', severity: 'success' });
                  await load();
                }}
                onError={(msg: string) => setSnack({ open: true, message: msg, severity: 'error' })}
              />
            </Elements>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setFundingOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}

      {/* In-dashboard card entry (Payment Element + SetupIntent) */}
      {cardSetup && cardStripe && (
        <Dialog open={addCardOpen} onClose={() => !submitting && setAddCardOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle sx={{ fontWeight: 800 }}>Add payment card</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Card details are entered securely with Stripe inside this dashboard. Adding a card never charges it.
            </Typography>
            <Elements
              stripe={cardStripe}
              options={{ clientSecret: cardSetup.setupIntentClientSecret, appearance: { theme: 'stripe' } }}
            >
              <CardSetupForm
                onDone={async () => {
                  setAddCardOpen(false);
                  setSnack({ open: true, message: 'Payment card saved.', severity: 'success' });
                  await load();
                }}
                onError={(msg: string) => setSnack({ open: true, message: msg, severity: 'error' })}
              />
            </Elements>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAddCardOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}

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

const CardSetupForm: React.FC<{ onDone: () => Promise<void> | void; onError: (msg: string) => void }> = ({
  onDone,
  onError,
}) => {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
      });
      if (error) {
        onError(error.message ?? 'Card setup failed');
        return;
      }
      if (setupIntent?.id) {
        await confirmPortalSetupIntent(setupIntent.id);
      }
      await onDone();
    } catch (err: unknown) {
      onError((err as Error)?.message ?? 'Card setup failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <PaymentElement />
      <Button
        fullWidth
        variant="contained"
        disabled={busy || !stripe}
        onClick={submit}
        sx={{ mt: 2 }}
      >
        {busy ? <CircularProgress size={20} color="inherit" /> : 'Save card'}
      </Button>
    </Box>
  );
};

const FundPaymentForm: React.FC<{
  paymentRowId: string;
  onDone: () => Promise<void> | void;
  onError: (msg: string) => void;
}> = ({ paymentRowId, onDone, onError }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
        confirmParams: {
          return_url: `${window.location.origin}/funding`,
        },
      });
      if (error) {
        onError(error.message ?? 'Payment failed');
        return;
      }
      if (paymentIntent) {
        await confirmPortalFundingIntent(paymentRowId, paymentIntent.id);
      }
      await onDone();
    } catch (err: unknown) {
      onError((err as Error)?.message ?? 'Payment failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <PaymentElement />
      <Button
        fullWidth
        variant="contained"
        disabled={busy || !stripe}
        onClick={submit}
        sx={{ mt: 2 }}
      >
        {busy ? <CircularProgress size={20} color="inherit" /> : 'Pay now'}
      </Button>
    </Box>
  );
};

export default Funding;