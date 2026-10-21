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
  InputAdornment,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import AddCardIcon from '@mui/icons-material/AddCard';
import SavingsIcon from '@mui/icons-material/Savings';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CreditCardIcon from '@mui/icons-material/CreditCard';
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

/** Stripe Elements themed to the NetRide dashboard. */
const STRIPE_APPEARANCE = {
  theme: 'stripe' as const,
  variables: {
    fontFamily: 'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    colorPrimary: '#1a1a1a',
    colorText: '#1a1a1a',
    colorDanger: '#d32f2f',
    borderRadius: '12px',
    spacingUnit: '4px',
    fontSizeBase: '15px',
  },
};

/** Keeps only digits and a single decimal separator (max two decimals). */
const sanitizeAmount = (raw: string) => {
  let cleaned = raw.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  if (parts.length > 2) cleaned = `${parts[0]}.${parts.slice(1).join('')}`;
  const [intPart, decPart] = cleaned.split('.');
  return decPart !== undefined ? `${intPart}.${decPart.slice(0, 2)}` : intPart;
};

const tableNumSx = { fontVariantNumeric: 'tabular-nums' } as const;

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
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  const [data, setData] = React.useState<PortalFundingData | null>(null);
  const [methods, setMethods] = React.useState<PortalPaymentMethod[]>([]);
  const [wState, setWState] = React.useState<SponsorWithdrawalState | null>(null);
  const [withdrawals, setWithdrawals] = React.useState<WithdrawalRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [addCardOpen, setAddCardOpen] = React.useState(false);
  const [removeTarget, setRemoveTarget] = React.useState<PortalPaymentMethod | null>(null);
  const [paymentBusy, setPaymentBusy] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' | 'info' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const load = React.useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
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
      setLoadError(null);
    } catch {
      setLoadError('We could not load your funding information. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // Deferred so the initial `loading` state stays visible (avoids a
    // synchronous setState inside the effect body).
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const defaultMethod = methods.find((m) => m.isDefault) ?? null;

  const makeDefault = async (m: PortalPaymentMethod) => {
    try {
      await setPortalDefaultMethod(m.id);
      setSnack({ open: true, message: 'Default payment method updated.', severity: 'success' });
      await load({ silent: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Update failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    }
  };

  const removeCard = async (m: PortalPaymentMethod) => {
    setSubmitting(true);
    try {
      await removePortalPaymentMethod(m.id);
      setRemoveTarget(null);
      setSnack({ open: true, message: 'Payment method removed.', severity: 'success' });
      await load({ silent: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Remove failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const minFundingCents = data?.minFundingCents ?? 5000;
  const amountCents = Math.round(Number(amount) * 100);
  const amountValid = Number.isFinite(amountCents) && amountCents >= minFundingCents;

  const withdrawAmountCents = Math.round(Number(withdrawAmount) * 100);
  const maxWithdrawCents = Math.max(0, data?.budget.spendableBudgetCents ?? 0);
  const withdrawOverMax = Number.isFinite(withdrawAmountCents) && withdrawAmountCents > maxWithdrawCents;
  const withdrawValid = Number.isFinite(withdrawAmountCents) && withdrawAmountCents > 0 && !withdrawOverMax;

  const startFunding = async () => {
    if (!amountValid) return;
    setSubmitting(true);
    try {
      const intent = await createPortalFundingIntent(amountCents);
      if (!intent.publishableKey) {
        setSnack({ open: true, message: 'Secure payments are not configured yet.', severity: 'error' });
        return;
      }
      const stripe = await loadStripe(intent.publishableKey);
      if (!stripe) {
        setSnack({ open: true, message: 'Stripe could not be loaded — check your connection and try again.', severity: 'error' });
        return;
      }
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
        return;
      }
      const stripe = await loadStripe(setup.publishableKey);
      if (!stripe) {
        setSnack({ open: true, message: 'Stripe could not be loaded — check your connection and try again.', severity: 'error' });
        setSubmitting(false);
        return;
      }
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
    if (!withdrawValid) return;
    setSubmitting(true);
    try {
      const res = await requestPortalWithdrawal(withdrawAmountCents);
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
      await load({ silent: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Withdrawal failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const maxWithdraw = maxWithdrawCents / 100;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4">
            Budget &amp; funding
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 760 }}>
            Add funds with a card, manage saved payment methods, and withdraw unused budget manually (once per week — the next window always opens Monday).
          </Typography>
        </Box>
        {data && (
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            <Chip
              label={data.isLive ? 'Live' : 'Offline'}
              sx={{
                fontWeight: 800,
                bgcolor: data.isLive ? '#E5F0EB' : '#FCE9E9',
                color: data.isLive ? '#2E7D32' : '#C65A5A',
              }}
            />
            <Chip
              label={`Stripe: ${data.mode}${data.configured ? '' : ' (not configured)'}`}
              color={data.mode === 'test' ? 'warning' : data.mode === 'live' ? 'success' : 'default'}
            />
          </Stack>
        )}
      </Box>

      {loading && !data && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
          <CircularProgress />
        </Box>
      )}

      {!loading && !data && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => load()}>
              Retry
            </Button>
          }
        >
          {loadError ?? 'Funding information is unavailable right now.'}
        </Alert>
      )}

      {data && (
        <>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, minmax(0, 1fr))',
                lg: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 2,
              mb: 3,
            }}
          >
            {[
              { label: 'Funded (total)', value: fmtUSD(data.budget.initialBudgetCents) },
              { label: 'Available', value: fmtUSD(data.budget.spendableBudgetCents), hint: 'remaining minus reserved' },
              { label: 'Reserved', value: fmtUSD(data.budget.reservedBudgetCents), hint: 'held for pending specials' },
              { label: 'Used', value: fmtUSD(data.budget.usedBudgetCents), hint: 'settled redemptions' },
            ].map((m) => (
              <Paper key={m.label} sx={{ p: 2.5, borderRadius: '16px', minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">{m.label}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, ...tableNumSx }}>{m.value}</Typography>
                {m.hint && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {m.hint}
                  </Typography>
                )}
              </Paper>
            ))}
          </Box>

          {data.budget.spendableBudgetCents < minFundingCents && (
            <Alert severity="error" sx={{ mb: 3 }}>
              At least {fmtUSD(minFundingCents)} in available funding is required to go Live.
              Add funds to be visible to riders.
            </Alert>
          )}

          <Paper sx={{ p: 2.5, borderRadius: '16px', mb: 3 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">Saved payment method</Typography>
                <Typography variant="body1" sx={{ fontWeight: 700, wordBreak: 'break-word' }}>
                  {defaultMethod ? cardLabel(defaultMethod) : 'No card saved yet'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Used to pay top-ups and to receive withdrawals (refunded to the funding card).
                  Adding a card never charges it — charges only happen when you fund the budget.
                </Typography>
              </Box>
              <Button
                variant="outlined"
                startIcon={<AddCardIcon />}
                disabled={submitting}
                onClick={addCard}
                sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
              >
                {defaultMethod ? 'Add another card' : 'Add card'}
              </Button>
            </Stack>

            {methods.length > 1 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  {methods.map((m) => (
                    <Box
                      key={m.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        py: 1,
                        flexWrap: { xs: 'wrap', sm: 'nowrap' },
                        minWidth: 0,
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flex: 1 }}>
                        {m.isDefault ? (
                          <CheckCircleIcon sx={{ fontSize: 18, color: 'success.main', flexShrink: 0 }} />
                        ) : (
                          <CreditCardIcon sx={{ fontSize: 18, color: 'text.disabled', flexShrink: 0 }} />
                        )}
                        <Box sx={{ minWidth: 0 }}>
                          <Typography
                            variant="body2"
                            noWrap
                            title={cardLabel(m)}
                            sx={{ fontWeight: 600 }}
                          >
                            {cardLabel(m)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {m.isDefault ? 'Used for payments and refunds' : 'Not in use'}
                          </Typography>
                        </Box>
                      </Box>
                      {!m.isDefault && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                          <Button size="small" onClick={() => makeDefault(m)}>
                            Make default
                          </Button>
                          <IconButton
                            size="small"
                            color="error"
                            aria-label={`Remove ${cardLabel(m)}`}
                            onClick={() => setRemoveTarget(m)}
                          >
                            <DeleteOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
            >
              <Box sx={{ minWidth: 0 }}>
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
                disabled={submitting || !wState || wState.eligible === false || data.budget.spendableBudgetCents <= 0}
                onClick={() => setWithdrawOpen(true)}
                sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
              >
                Withdraw funds
              </Button>
            </Stack>
            {wState?.eligible === false && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                The weekly window opens on Mondays; you can make one withdrawal per week.
              </Typography>
            )}
          </Paper>

          <Button
            size="large"
            variant="outlined"
            startIcon={<AddCardIcon />}
            onClick={() => {
              if (!amount) setAmount((minFundingCents / 100).toFixed(0));
              setOpen(true);
            }}
            sx={{ mb: 3 }}
          >
            Add funds
          </Button>

          <Typography variant="h6" sx={{ mb: 1 }}>Funding history</Typography>
          <Paper sx={{ borderRadius: '16px', mb: 2 }}>
            <TableContainer sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Payment intent</TableCell>
                    <TableCell>Failure</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.payments.map((p) => (
                    <TableRow key={p.id} hover>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(p.created_at).toLocaleString()}</TableCell>
                      <TableCell align="right" sx={tableNumSx}>{fmtUSD(p.amount_cents)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={p.status} color={STATUS_COLOR[p.status] ?? 'default'} />
                      </TableCell>
                      <TableCell sx={{ display: { xs: 'none', md: 'table-cell' }, maxWidth: 220 }}>
                        <Typography variant="caption" noWrap title={p.stripe_payment_intent_id ?? ''} sx={{ fontFamily: 'monospace', display: 'block' }}>
                          {p.stripe_payment_intent_id ?? '—'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 260 }}>
                        <Typography variant="caption" color="error" sx={{ wordBreak: 'break-word' }}>{p.failure_reason ?? ''}</Typography>
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

          <Typography variant="h6" sx={{ mb: 1, mt: 4 }}>Withdrawal history</Typography>
          <Paper sx={{ borderRadius: '16px' }}>
            <TableContainer sx={{ maxHeight: 420 }}>
              <Table size="small" stickyHeader>
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
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(w.requested_at)}</TableCell>
                      <TableCell align="right" sx={tableNumSx}>{fmtUSD(w.amount_cents)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={w.status} color={STATUS_COLOR[w.status] ?? 'default'} />
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(w.completed_at)}</TableCell>
                      <TableCell sx={{ maxWidth: 260 }}>
                        <Typography variant="caption" color="error" sx={{ wordBreak: 'break-word' }}>{w.failure_reason ?? ''}</Typography>
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

      <Dialog open={open} onClose={() => !submitting && setOpen(false)} maxWidth="xs" fullWidth fullScreen={isPhone}>
        <DialogTitle>Add funds</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The card payment happens in this dashboard — no external redirect. Your budget is credited only after the payment is confirmed.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(sanitizeAmount(e.target.value))}
            inputMode="decimal"
            error={amount !== '' && !amountValid}
            helperText={
              amount !== '' && !amountValid
                ? `Minimum ${fmtUSD(minFundingCents)} is required to go Live.`
                : `Minimum ${fmtUSD(minFundingCents)} per top-up.`
            }
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start">$</InputAdornment>,
              },
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
          <Button variant="contained" disabled={submitting || !amountValid} onClick={startFunding}>
            {submitting ? 'Starting…' : 'Continue'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* In-dashboard card payment (Payment Element) */}
      {fundingIntent && fundingStripe && (
        <Dialog
          open={fundingOpen}
          onClose={() => !paymentBusy && !submitting && setFundingOpen(false)}
          maxWidth="xs"
          fullWidth
          fullScreen={isPhone}
        >
          <DialogTitle>Pay {fmtUSD(fundingCents)}</DialogTitle>
          <DialogContent>
            <Elements
              stripe={fundingStripe}
              options={{ clientSecret: fundingIntent.clientSecret, appearance: STRIPE_APPEARANCE }}
            >
              <FundPaymentForm
                paymentRowId={fundingIntent.paymentRowId}
                onBusy={setPaymentBusy}
                onDone={async () => {
                  setFundingOpen(false);
                  setSnack({ open: true, message: 'Budget funded — payment confirmed.', severity: 'success' });
                  await load({ silent: true });
                }}
                onError={(msg: string) => setSnack({ open: true, message: msg, severity: 'error' })}
              />
            </Elements>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setFundingOpen(false)} disabled={paymentBusy}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}

      {/* In-dashboard card entry (Payment Element + SetupIntent) */}
      {cardSetup && cardStripe && (
        <Dialog
          open={addCardOpen}
          onClose={() => !paymentBusy && !submitting && setAddCardOpen(false)}
          maxWidth="xs"
          fullWidth
          fullScreen={isPhone}
        >
          <DialogTitle>Add payment card</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Card details are entered securely with Stripe inside this dashboard. Adding a card never charges it.
            </Typography>
            <Elements
              stripe={cardStripe}
              options={{ clientSecret: cardSetup.setupIntentClientSecret, appearance: STRIPE_APPEARANCE }}
            >
              <CardSetupForm
                onBusy={setPaymentBusy}
                onDone={async () => {
                  setAddCardOpen(false);
                  setSnack({ open: true, message: 'Payment card saved.', severity: 'success' });
                  await load({ silent: true });
                }}
                onError={(msg: string) => setSnack({ open: true, message: msg, severity: 'error' })}
              />
            </Elements>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAddCardOpen(false)} disabled={paymentBusy}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}

      <Dialog open={withdrawOpen} onClose={() => !submitting && setWithdrawOpen(false)} maxWidth="xs" fullWidth fullScreen={isPhone}>
        <DialogTitle>Withdraw funds</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The amount is refunded to your funding card. Maximum{' '}
            {fmtUSD(maxWithdrawCents)} (your available budget). One withdrawal per week — the next window always opens Monday.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="Amount"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(sanitizeAmount(e.target.value))}
            inputMode="decimal"
            error={withdrawOverMax || (withdrawAmount !== '' && withdrawAmountCents <= 0)}
            helperText={
              withdrawOverMax
                ? `Amount exceeds your available budget of ${fmtUSD(maxWithdrawCents)}.`
                : `Max ${maxWithdraw.toFixed(2)}`
            }
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start">$</InputAdornment>,
                endAdornment: maxWithdrawCents > 0 ? (
                  <InputAdornment position="end">
                    <Button size="small" onClick={() => setWithdrawAmount(maxWithdraw.toFixed(2))}>
                      Max
                    </Button>
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWithdrawOpen(false)} disabled={submitting}>Cancel</Button>
          <Button variant="contained" disabled={submitting || !withdrawValid} onClick={startWithdrawal}>
            {submitting ? 'Processing…' : 'Withdraw'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Confirm card removal (replaces window.confirm) */}
      <Dialog open={Boolean(removeTarget)} onClose={() => !submitting && setRemoveTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove payment method?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {removeTarget ? `${cardLabel(removeTarget)} will be removed and can no longer be used for payments or refunds.` : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveTarget(null)} disabled={submitting}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            disabled={submitting}
            onClick={() => removeTarget && removeCard(removeTarget)}
          >
            {submitting ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack.open}
        autoHideDuration={6000}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack((s) => ({ ...s, open: false }))}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

const CardSetupForm: React.FC<{
  onDone: () => Promise<void> | void;
  onError: (msg: string) => void;
  onBusy: (busy: boolean) => void;
}> = ({ onDone, onError, onBusy }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);

  const setBusyBoth = (value: boolean) => {
    setBusy(value);
    onBusy(value);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!stripe || !elements) return;
    setBusyBoth(true);
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
      setBusyBoth(false);
    }
  };

  return (
    <Box component="form" onSubmit={submit}>
      <PaymentElement />
      <Button
        type="submit"
        fullWidth
        variant="contained"
        disabled={busy || !stripe}
        sx={{ mt: 2 }}
      >
        {busy ? 'Saving…' : 'Save card'}
      </Button>
    </Box>
  );
};

const FundPaymentForm: React.FC<{
  paymentRowId: string;
  onDone: () => Promise<void> | void;
  onError: (msg: string) => void;
  onBusy: (busy: boolean) => void;
}> = ({ paymentRowId, onDone, onError, onBusy }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = React.useState(false);

  const setBusyBoth = (value: boolean) => {
    setBusy(value);
    onBusy(value);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!stripe || !elements) return;
    setBusyBoth(true);
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
      setBusyBoth(false);
    }
  };

  return (
    <Box component="form" onSubmit={submit}>
      <PaymentElement />
      <Button
        type="submit"
        fullWidth
        variant="contained"
        disabled={busy || !stripe}
        sx={{ mt: 2 }}
      >
        {busy ? 'Processing…' : 'Pay now'}
      </Button>
    </Box>
  );
};

export default Funding;
