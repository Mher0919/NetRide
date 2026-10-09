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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Stack,
  Alert,
  Switch,
  FormControlLabel,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import PaidIcon from '@mui/icons-material/Paid';
import { format } from '../utils/date';
import {
  getPaymentsOverview,
  listPaymentSettlements,
  listPayments,
  listPaymentEvents,
  reconcilePayment,
  refundPayment,
  retryAdditionalCharge,
} from '../api/admin';

const fmtUSD = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const STATUS_COLOR: Record<string, 'success' | 'error' | 'warning' | 'info' | 'default'> = {
  SUCCEEDED: 'success',
  SETTLED: 'success',
  COLLECTED: 'success',
  TRANSFERRED: 'success',
  PAID: 'success',
  FAILED: 'error',
  EXCEPTION: 'error',
  REFUNDED: 'warning',
  REQUIRED: 'warning',
  REQUIRES_ACTION: 'warning',
  PENDING: 'info',
  PROCESSING: 'info',
  RESERVED: 'info',
  RELEASED: 'info',
  PARTIALLY_SETTLED: 'info',
};

const chip = (value: string | null | undefined) =>
  value ? <Chip size="small" label={value} color={STATUS_COLOR[value] ?? 'default'} /> : <Chip size="small" label="—" />;

const Payments: React.FC = () => {
  const [tab, setTab] = useState(0);
  const [overview, setOverview] = useState<any>(null);
  const [settlements, setSettlements] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [refundTarget, setRefundTarget] = useState<any>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [ov, st, pm, ev] = await Promise.all([
        getPaymentsOverview(),
        listPaymentSettlements({ issues: onlyIssues }),
        listPayments({ status: paymentStatus || undefined }),
        listPaymentEvents(),
      ]);
      setOverview(ov);
      setSettlements(st?.settlements ?? []);
      setPayments(pm?.payments ?? []);
      setEvents(ev?.events ?? []);
    } catch (err) {
      console.error('Payments load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, 120_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyIssues, paymentStatus]);

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      setNotice(okMsg);
      await load();
    } catch (err: any) {
      setNotice(`Action failed: ${err?.response?.data?.error ?? err?.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const doRefund = async () => {
    if (!refundTarget) return;
    const amountCents = refundAmount ? Math.round(Number(refundAmount) * 100) : undefined;
    await act(
      () => refundPayment(refundTarget.id, amountCents, 'Admin refund'),
      'Refund initiated',
    );
    setRefundTarget(null);
    setRefundAmount('');
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Payments &amp; Reconciliation
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Stripe collections, ride settlement components, sponsor funding and unresolved exceptions.
          </Typography>
        </Box>
        {overview && (
          <Chip
            label={`Stripe: ${overview.stripe?.mode ?? 'unconfigured'}`}
            color={overview.stripe?.mode === 'test' ? 'warning' : overview.stripe?.mode === 'live' ? 'success' : 'default'}
            icon={<PaidIcon />}
          />
        )}
      </Stack>

      {notice && <Alert severity={notice.startsWith('Action failed') ? 'error' : 'success'} sx={{ mb: 2 }}>{notice}</Alert>}

      <Paper sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', mb: 2, overflow: 'hidden' }}>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          <Tab label="Overview" />
          <Tab label="Settlements" />
          <Tab label="Stripe payments" />
          <Tab label="Webhook events" />
        </Tabs>
      </Paper>

      {loading && <CircularProgress sx={{ ml: 3 }} />}

      {!loading && tab === 0 && overview && (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <Paper sx={{ p: 3, borderRadius: 4, boxShadow: 'none', border: '1px solid rgba(0,0,0,0.06)', minWidth: 220 }}>
            <Typography variant="h6">Open exceptions</Typography>
            <Typography variant="h3" sx={{ fontWeight: 800 }}>{overview.exceptionCount}</Typography>
            <Typography variant="body2" color="text.secondary">settlement exceptions, failed or required additional charges</Typography>
          </Paper>
          <Paper sx={{ p: 3, borderRadius: 4, boxShadow: 'none', border: '1px solid rgba(0,0,0,0.06)', minWidth: 220 }}>
            <Typography variant="h6">Failed webhooks</Typography>
            <Typography variant="h3" sx={{ fontWeight: 800 }}>{overview.failedWebhookCount}</Typography>
            <Typography variant="body2" color="text.secondary">Stripe events that could not be applied</Typography>
          </Paper>
          {(overview.payments ?? []).map((p: any) => (
            <Paper key={`${p.purpose}-${p.status}`} sx={{ p: 3, borderRadius: 4, boxShadow: 'none', border: '1px solid rgba(0,0,0,0.06)', minWidth: 200 }}>
              <Typography variant="h6">{p.purpose}</Typography>
              <Typography variant="h4" sx={{ fontWeight: 800 }}>{fmtUSD(p.amountCents)}</Typography>
              <Typography variant="body2" color="text.secondary">{p.count}× {p.status}</Typography>
            </Paper>
          ))}
        </Stack>
      )}

      {!loading && tab === 1 && (
        <>
          <FormControlLabel
            control={<Switch checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />}
            label="Only unresolved items"
          />
          <Paper sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', mt: 1, overflow: 'auto' }}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Ride</TableCell>
                    <TableCell align="right">Original fare</TableCell>
                    <TableCell align="right">Rider share</TableCell>
                    <TableCell align="right">Sponsor</TableCell>
                    <TableCell align="right">Rider paid</TableCell>
                    <TableCell align="right">Sponsor paid</TableCell>
                    <TableCell align="right">Additional</TableCell>
                    <TableCell align="right">Driver earned</TableCell>
                    <TableCell>Settlement</TableCell>
                    <TableCell>Components</TableCell>
                    <TableCell>Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {settlements.map((s: any) => (
                    <TableRow key={s.rideId} hover>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{s.rideId.slice(0, 8)}</Typography>
                        <Typography variant="caption" display="block" color="text.secondary">{s.rideStatus}</Typography>
                      </TableCell>
                      <TableCell align="right">{fmtUSD(s.originalFareCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.riderShareCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.sponsorSubsidyCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.riderCollectedCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.sponsorCollectedCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.additionalRiderChargeCents)}</TableCell>
                      <TableCell align="right">{fmtUSD(s.driverEarningsCents)}</TableCell>
                      <TableCell>{chip(s.settlementStatus)}</TableCell>
                      <TableCell>
                        {chip(s.additionalChargeStatus)}
                        {chip(s.sponsorContributionStatus)}
                      </TableCell>
                      <TableCell>
                        {(['REQUIRED', 'FAILED'].includes(s.additionalChargeStatus ?? '') && (
                          <Button
                            size="small"
                            color="warning"
                            disabled={busy}
                            onClick={() => act(() => retryAdditionalCharge(s.rideId), 'Retry initiated')}
                          >
                            Retry charge
                          </Button>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                  {settlements.length === 0 && (
                    <TableRow><TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>No settlement records match</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      {!loading && tab === 2 && (
        <>
          <FormControl size="small" sx={{ minWidth: 180, mb: 1 }}>
            <InputLabel>Status</InputLabel>
            <Select
              value={paymentStatus}
              onChange={(e) => setPaymentStatus(e.target.value)}
              label="Status"
            >
              <MenuItem value="">Any</MenuItem>
              <MenuItem value="PENDING">PENDING</MenuItem>
              <MenuItem value="SUCCEEDED">SUCCEEDED</MenuItem>
              <MenuItem value="FAILED">FAILED</MenuItem>
              <MenuItem value="REFUNDED">REFUNDED</MenuItem>
              <MenuItem value="REQUIRES_ACTION">REQUIRES_ACTION</MenuItem>
              <MenuItem value="CANCELED">CANCELED</MenuItem>
            </Select>
          </FormControl>
          <Paper sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', mt: 1, overflow: 'auto' }}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Purpose</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Intent</TableCell>
                    <TableCell>Fee</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payments.map((p: any) => (
                    <TableRow key={p.id} hover>
                      <TableCell>
                        {p.purpose}
                        <Typography variant="caption" display="block" color="text.secondary">
                          {p.user_email ?? p.sponsor_name ?? ''}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{fmtUSD(Number(p.amount_cents) ?? 0)}</TableCell>
                      <TableCell>{chip(p.status)}</TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                          {p.stripe_payment_intent_id ?? '—'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{p.stripe_fee_cents ? fmtUSD(Number(p.stripe_fee_cents)) : '—'}</TableCell>
                      <TableCell>{format(p.created_at)}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1}>
                          <Button size="small" disabled={busy} onClick={() => act(() => reconcilePayment(p.id), `Reconciled ${p.id.slice(0, 8)}`)}>
                            Reconcile
                          </Button>
                          {p.status === 'SUCCEEDED' && p.purpose !== 'RIDE_CHARGE' && (
                            <Button size="small" color="warning" onClick={() => setRefundTarget(p)}>
                              Refund
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {payments.length === 0 && (
                    <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No Stripe payments match</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      {!loading && tab === 3 && (
        <Paper sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'auto' }}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Event</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Received</TableCell>
                  <TableCell>Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {events.map((e: any) => (
                  <TableRow key={e.stripe_event_id} hover>
                    <TableCell>
                      <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{e.stripe_event_id}</Typography>
                    </TableCell>
                    <TableCell>{e.type}</TableCell>
                    <TableCell>{chip(e.status)}</TableCell>
                    <TableCell>{format(e.received_at)}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="error" sx={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', whiteSpace: 'nowrap' }}>
                        {e.error ?? ''}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
                {events.length === 0 && (
                  <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    No webhook events yet — with the Stripe CLI: <code>stripe listen --forward-to localhost:3000/api/payments/webhook</code>
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <Dialog open={!!refundTarget} onClose={() => setRefundTarget(null)}>
        <DialogTitle>Refund Stripe payment</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Amount (USD, optional — blank refunds fully)"
            value={refundAmount}
            onChange={(e) => setRefundAmount(e.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRefundTarget(null)}>Cancel</Button>
          <Button color="warning" disabled={busy} onClick={doRefund}>Refund</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Payments;