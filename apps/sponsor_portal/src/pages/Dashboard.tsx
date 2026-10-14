import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Alert,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Stack,
} from '@mui/material';
import DialpadIcon from '@mui/icons-material/Dialpad';
import { portalValidate } from '../api/sponsor';
import {
  portalDashboard,
  portalCommission,
  portalFleetDrivers,
  portalFleetRides,
} from '../api/portal';
import type { PortalDashboard, PortalType } from '../api/portal';
import { useAuth } from '../context/AuthContext';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const typeLabel: Record<string, string> = {
  SPONSOR: 'Sponsor',
  PARTNER: 'Partner',
  FLEET: 'Fleet',
};

// ---------------------------------------------------------------------------
// Sponsor dashboard (existing flow)
// ---------------------------------------------------------------------------

const SponsorDashboard: React.FC<{ data: PortalDashboard; onChanged: () => void }> = ({ data, onChanged }) => {
  const sponsor = data.sponsor!;
  const stats = data.stats!;
  const [codeOpen, setCodeOpen] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [entered, setEntered] = React.useState('');
  const [confirmStep, setConfirmStep] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });

  const openCode = () => {
    setCode('');
    setEntered('');
    setConfirmStep(false);
    setCodeOpen(true);
  };

  const submitCode = async () => {
    setSubmitting(true);
    try {
      const res = await portalValidate(entered, true);
      setSnack({ open: true, message: res?.message ?? 'Visit validated', severity: 'success' });
      setCodeOpen(false);
      onChanged();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Validation failed';
      setSnack({ open: true, message: msg, severity: 'error' });
      setConfirmStep(false);
      setCode('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
          {sponsor.businessName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {String(sponsor.businessType ?? 'BUSINESS').toLowerCase()} partner · status: {sponsor.status} · budget remaining: {fmtUSD(sponsor.remainingBudgetCents)}
        </Typography>
      </Box>

      <Button variant="contained" size="large" startIcon={<DialpadIcon />} onClick={openCode} sx={{ mb: 3 }}>
        Validate a rider code
      </Button>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(4, minmax(0, 1fr))',
          },
          gap: 2,
        }}
      >
        {[
          { label: 'Awaiting your code', value: String(stats.pendingValidations), hint: 'rides completed, code not yet validated' },
          { label: 'Redemptions', value: String(stats.redeemedCount), hint: 'rewarded visits' },
          { label: 'Discounts funded', value: fmtUSD(stats.redeemedDiscountCents), hint: 'rider discounts you funded' },
          { label: 'Rider discounts applied', value: fmtUSD(stats.rewardAmountCents), hint: 'discount value settled on validated visits' },
        ].map((m) => (
          <Paper key={m.label} sx={{ p: 2.5, borderRadius: '16px', minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>{m.value}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{m.hint}</Typography>
          </Paper>
        ))}
      </Box>

      <Dialog open={codeOpen} onClose={() => !submitting && setCodeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Validate a rider code</DialogTitle>
        <DialogContent>
          <TextField
            label="6-digit code (on the rider's app)"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            fullWidth
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            sx={{ mt: 1 }}
            slotProps={{
              htmlInput: {
                maxLength: 6,
                style: { textAlign: 'center', letterSpacing: '0.3em', fontSize: '1.25rem', fontWeight: 800 },
              },
            }}
          />
          {confirmStep && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Confirm that the rider visited {sponsor.businessName} today. This unlocks their reward — it cannot be undone.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCodeOpen(false)} disabled={submitting}>Cancel</Button>
          <Button variant="contained" disabled={submitting || code.length !== 6} onClick={() => { setEntered(code); setConfirmStep(true); }}>
            Continue
          </Button>
          {confirmStep && (
            <Button variant="contained" color="success" disabled={submitting} onClick={submitCode}>
              {submitting ? 'Validating…' : `Confirm ${entered}`}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Partner dashboard (earnings focus)
// ---------------------------------------------------------------------------

const PartnerDashboard: React.FC<{ data: PortalDashboard; portalType?: PortalType }> = ({ data, portalType }) => {
  const partner = data.partner!;
  const earnings = data.earnings!;
  const [commission, setCommission] = React.useState<Awaited<ReturnType<typeof portalCommission>> | null>(null);

  React.useEffect(() => {
    portalCommission(portalType).then(setCommission).catch(() => undefined);
  }, [portalType]);

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
          {partner.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Business partner · {((Number(partner.commissionRate) || 0) * 100).toFixed(1)}% commission on rider payments · status: {partner.status}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(4, minmax(0, 1fr))',
          },
          gap: 2,
        }}
      >
        {[
          { label: 'Lifetime earnings', value: fmtUSD(earnings.lifetimeEarningsCents), hint: 'earned from your promo codes' },
          { label: 'Pending payout', value: fmtUSD(earnings.pendingEarningsCents), hint: 'awaiting payment' },
          { label: 'Paid out', value: fmtUSD(earnings.paidEarningsCents), hint: 'already paid' },
          { label: 'Promo redemptions', value: String(data.usage?.total_uses ?? 0), hint: 'rides that used your codes' },
        ].map((m) => (
          <Paper key={m.label} sx={{ p: 2.5, borderRadius: '16px', minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>{m.value}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{m.hint}</Typography>
          </Paper>
        ))}
      </Box>

      {commission && (
        <Paper sx={{ mt: 3, p: 2, borderRadius: '16px', bgcolor: '#F7F4EF' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
            Commission rate: {((Number(commission.commission_rate) || 0) * 100).toFixed(1)}% ({commission.commission_type})
          </Typography>
        </Paper>
      )}

      <Typography variant="h6" sx={{ fontWeight: 800, mt: 4, mb: 2 }}>Recent commissions</Typography>
      {!data.recentCommissions || data.recentCommissions.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No commissions yet — they accrue when riders use your promo codes.</Typography>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: '16px', border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', maxHeight: 480 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Rider</TableCell>
                <TableCell>Promo</TableCell>
                <TableCell align="right">Ride value</TableCell>
                <TableCell align="right">Commission</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.recentCommissions.map((c) => (
                <TableRow key={c.id} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(c.created_at).toLocaleDateString()}</TableCell>
                  <TableCell>{c.rider_name ?? '—'}</TableCell>
                  <TableCell>{c.promo_code ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(c.ride_price_cents)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(c.commission_cents)}</TableCell>
                  <TableCell>
                    <Chip size="small" label={c.status} sx={{ bgcolor: c.status === 'PAID' ? '#E5F0EB' : '#FCE9E9', color: c.status === 'PAID' ? '#5B7760' : '#C65A5A', fontWeight: 700 }} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Fleet dashboard (earnings focus)
// ---------------------------------------------------------------------------

const FleetDashboard: React.FC<{ data: PortalDashboard; portalType?: PortalType }> = ({ data, portalType }) => {
  const fleet = data.fleet!;
  const stats = data.stats!;
  const [drivers, setDrivers] = React.useState<Awaited<ReturnType<typeof portalFleetDrivers>>['drivers']>([]);
  const [rides, setRides] = React.useState<Awaited<ReturnType<typeof portalFleetRides>>['rides']>([]);

  React.useEffect(() => {
    portalFleetDrivers(portalType).then((d) => setDrivers(d.drivers ?? [])).catch(() => undefined);
    portalFleetRides(10, portalType).then((d) => setRides(d.rides ?? [])).catch(() => undefined);
  }, [portalType]);

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
          {fleet.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Fleet partner · {Number(fleet.platformSharePercent ?? 0).toFixed(0)}% of the platform pool · status: {fleet.is_active ? 'Active' : 'Disabled'}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(4, minmax(0, 1fr))',
          },
          gap: 2,
        }}
      >
        {[
          { label: 'Lifetime fleet earnings', value: fmtUSD(stats.lifetimeEarningsCents), hint: 'your share of the platform pool' },
          { label: 'Last 30 days', value: fmtUSD(stats.last30dEarningsCents), hint: 'recent earnings' },
          { label: 'Completed rides', value: String(stats.completedRides ?? 0), hint: 'rides with fleet allocation' },
          { label: 'Drivers in fleet', value: String(stats.driverCount ?? 0), hint: 'assigned drivers' },
        ].map((m) => (
          <Paper key={m.label} sx={{ p: 2.5, borderRadius: '16px', minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>{m.value}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{m.hint}</Typography>
          </Paper>
        ))}
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 800, mt: 4, mb: 2 }}>Recent fleet rides</Typography>
      {rides.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No rides yet — earnings appear once your drivers complete trips.</Typography>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: '16px', border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', maxHeight: 480 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell>Driver</TableCell>
                <TableCell>Route</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Fleet earnings</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rides.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.completed_at ? new Date(r.completed_at).toLocaleString() : '—'}</TableCell>
                  <TableCell>{r.driver_name ?? '—'}</TableCell>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Typography
                      variant="caption"
                      noWrap
                      title={[r.pickup_address, r.destination_address].filter(Boolean).join(' → ') || '—'}
                      sx={{ display: 'block' }}
                    >
                      {[r.pickup_address, r.destination_address].filter(Boolean).join(' → ') || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={r.status} sx={{ bgcolor: r.status === 'COMPLETED' ? '#E5F0EB' : '#FCE9E9', color: r.status === 'COMPLETED' ? '#5B7760' : '#C65A5A', fontWeight: 700 }} />
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(r.fleet_earnings_cents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="h6" sx={{ mt: 4, mb: 2 }}>Fleet drivers ({drivers.length})</Typography>
      {drivers.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No drivers assigned yet.</Typography>
      ) : (
        <Stack direction="row" useFlexGap sx={{ gap: 1, flexWrap: 'wrap', rowGap: 1 }}>
          {drivers.map((d) => (
            <Paper key={d.id} sx={{ p: 1.5, borderRadius: '16px', minWidth: 200, maxWidth: 280, border: '1px solid rgba(0,0,0,0.06)', flex: '1 1 200px' }}>
              <Typography variant="body2" noWrap title={d.full_name} sx={{ fontWeight: 700 }}>{d.full_name}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-word', display: 'block' }}>{d.email}</Typography>
              <Box sx={{ mt: 0.5 }}>
                <Chip size="small" label={d.is_active ? 'Active' : 'Offline'} sx={{ bgcolor: d.is_active ? '#E5F0EB' : '#EEEEEE', color: d.is_active ? '#5B7760' : '#666666', fontWeight: 700, mr: 0.5 }} />
                <Chip size="small" label={`${d.total_rides ?? 0} rides`} sx={{ bgcolor: '#EEEEEE', color: '#666666', fontWeight: 700 }} />
              </Box>
            </Paper>
          ))}
        </Stack>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Combined dashboard — the same login owns BOTH partner and sponsor (and/or
// fleet) accounts, so every side is shown on one page.
// ---------------------------------------------------------------------------

const CombinedDashboard: React.FC = () => {
  const { session } = useAuth();
  const portals = React.useMemo(() => session?.portals ?? [], [session?.portals]);
  const hasType = (t: PortalType) => portals.some((p) => p.type === t);

  const [dashboards, setDashboards] = React.useState<Partial<Record<PortalType, PortalDashboard>>>({});
  const [errors, setErrors] = React.useState<Partial<Record<PortalType, string>>>({});
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    const types: PortalType[] = [];
    if (portals.some((p) => p.type === 'SPONSOR')) types.push('SPONSOR');
    if (portals.some((p) => p.type === 'PARTNER')) types.push('PARTNER');
    if (portals.some((p) => p.type === 'FLEET')) types.push('FLEET');

    const next: Partial<Record<PortalType, PortalDashboard>> = {};
    const nextErrors: Partial<Record<PortalType, string>> = {};
    await Promise.all(
      types.map(async (t) => {
        try {
          next[t] = await portalDashboard(t);
        } catch (err) {
          nextErrors[t] =
            (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            'Failed to load this dashboard';
        }
      }),
    );
    setDashboards(next);
    setErrors(nextErrors);
    setLoading(false);
  }, [portals]);

  React.useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const sponsor = dashboards.SPONSOR;
  const partner = dashboards.PARTNER;
  const fleet = dashboards.FLEET;

  if (loading && Object.keys(dashboards).length === 0) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  const totalEarningsCents =
    (partner?.earnings?.lifetimeEarningsCents ?? 0) + (fleet?.stats?.lifetimeEarningsCents ?? 0);

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
          All dashboards
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {portals.map((p) => `${p.name} · ${typeLabel[p.type]}`).join('  |  ')}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, minmax(0, 1fr))',
            lg: 'repeat(4, minmax(0, 1fr))',
          },
          gap: 2,
          mb: 4,
        }}
      >
        {[
          { label: 'Sponsor budget remaining', value: sponsor ? fmtUSD(sponsor.sponsor?.remainingBudgetCents) : '—', hint: sponsor ? `${sponsor.stats?.pendingValidations ?? 0} validations awaiting your code` : 'no sponsor account' },
          { label: 'Partner lifetime earnings', value: partner ? fmtUSD(partner.earnings?.lifetimeEarningsCents) : '—', hint: partner ? `${partner.usage?.total_uses ?? 0} promo redemptions` : 'no partner account' },
          { label: 'Fleet lifetime earnings', value: fleet ? fmtUSD(fleet.stats?.lifetimeEarningsCents) : '—', hint: fleet ? `${fleet.stats?.completedRides ?? 0} completed rides` : 'no fleet account' },
          { label: 'Combined earnings', value: fmtUSD(totalEarningsCents), hint: 'partner + fleet lifetime' },
        ].map((m) => (
          <Paper key={m.label} sx={{ p: 2.5, borderRadius: '16px', minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>{m.value}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{m.hint}</Typography>
          </Paper>
        ))}
      </Box>

      {hasType('SPONSOR') && (
        <Box sx={{ mb: 5 }}>
          <Typography variant="overline" sx={{ fontWeight: 800, color: 'text.secondary', letterSpacing: 1 }}>
            Sponsor side
          </Typography>
          {errors.SPONSOR ? (
            <Alert severity="error" sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={() => load()}>Retry</Button>}>{errors.SPONSOR}</Alert>
          ) : sponsor ? (
            <SponsorDashboard data={sponsor} onChanged={load} />
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={28} /></Box>
          )}
        </Box>
      )}

      {hasType('PARTNER') && (
        <Box sx={{ mb: 5 }}>
          <Typography variant="overline" sx={{ fontWeight: 800, color: 'text.secondary', letterSpacing: 1 }}>
            Partner side
          </Typography>
          {errors.PARTNER ? (
            <Alert severity="error" sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={() => load()}>Retry</Button>}>{errors.PARTNER}</Alert>
          ) : partner ? (
            <PartnerDashboard data={partner} portalType="PARTNER" />
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={28} /></Box>
          )}
        </Box>
      )}

      {hasType('FLEET') && (
        <Box sx={{ mb: 5 }}>
          <Typography variant="overline" sx={{ fontWeight: 800, color: 'text.secondary', letterSpacing: 1 }}>
            Fleet side
          </Typography>
          {errors.FLEET ? (
            <Alert severity="error" sx={{ mt: 1 }} action={<Button color="inherit" size="small" onClick={() => load()}>Retry</Button>}>{errors.FLEET}</Alert>
          ) : fleet ? (
            <FleetDashboard data={fleet} portalType="FLEET" />
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress size={28} /></Box>
          )}
        </Box>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Single-dashboard view (one active portal type)
// ---------------------------------------------------------------------------

const SingleDashboard: React.FC = () => {
  const { session } = useAuth();
  const [data, setData] = React.useState<PortalDashboard | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await portalDashboard();
      setData(d);
    } catch (err) {
      console.error('Failed to load dashboard', err);
      setLoadError('We could not load your dashboard. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  if (loading && !data) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  if (!data) {
    return (
      <Box>
        <Box sx={{ mb: 3 }}>
          <Typography variant="h4">Dashboard</Typography>
        </Box>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => load()}>
              Retry
            </Button>
          }
        >
          {loadError ?? 'Dashboard is unavailable right now.'}
        </Alert>
      </Box>
    );
  }

  const type = session?.portal.type ?? data.type;
  if (type === 'PARTNER') return <PartnerDashboard data={data} />;
  if (type === 'FLEET') return <FleetDashboard data={data} />;
  return <SponsorDashboard data={data} onChanged={load} />;
};

// ---------------------------------------------------------------------------
// Type-aware dispatcher
// ---------------------------------------------------------------------------

const Dashboard: React.FC = () => {
  const { session } = useAuth();
  if (session?.portal.type === 'ALL') return <CombinedDashboard />;
  return <SingleDashboard />;
};

export default Dashboard;