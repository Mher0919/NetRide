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
} from '@mui/material';
import DialpadIcon from '@mui/icons-material/Dialpad';
import { getPortalDashboard, portalValidate } from '../api/sponsor';
import type { PortalSponsor } from '../api/sponsor';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface DashboardStats {
  pendingValidations: number;
  redeemedCount: number;
  redeemedDiscountCents: number;
  rewardAmountCents: number;
}

const Dashboard: React.FC = () => {
  const [data, setData] = React.useState<{ sponsor: PortalSponsor; stats: DashboardStats } | null>(null);
  const [loading, setLoading] = React.useState(true);

  const [codeOpen, setCodeOpen] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [entered, setEntered] = React.useState('');
  const [confirmStep, setConfirmStep] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });

  const load = React.useCallback(async () => {
    try {
      const d = await getPortalDashboard();
      setData(d);
    } catch (err) {
      console.error('Failed to load dashboard', err);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

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
      load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Validation failed';
      setSnack({ open: true, message: msg, severity: 'error' });
      setConfirmStep(false);
      setCode('');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  const { sponsor, stats } = data!;

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
          {sponsor.businessName}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {String(sponsor.businessType ?? 'BUSINESS').toLowerCase()} partner · {sponsor.discountLabel} off rider fares · status: {sponsor.status}
        </Typography>
      </Box>

      <Button variant="contained" size="large" startIcon={<DialpadIcon />} onClick={openCode} sx={{ mb: 3 }}>
        Validate a rider code
      </Button>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(4, 1fr)' }, gap: 2 }}>
        {[
          { label: 'Awaiting your code', value: String(stats.pendingValidations), hint: 'rides completed, code not yet validated' },
          { label: 'Redemptions', value: String(stats.redeemedCount), hint: 'rewarded visits' },
          { label: 'Discounts funded', value: fmtUSD(stats.redeemedDiscountCents), hint: 'rider discounts you funded' },
          { label: 'Rewards paid to riders', value: fmtUSD(stats.rewardAmountCents), hint: 'cash back / credits' },
        ].map((m) => (
          <Paper key={m.label} sx={{ p: 2.5, borderRadius: 3 }}>
            <Typography variant="caption" color="text.secondary">{m.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }}>{m.value}</Typography>
            <Typography variant="caption" color="text.secondary">{m.hint}</Typography>
          </Paper>
        ))}
      </Box>

      <Dialog open={codeOpen} onClose={() => !submitting && setCodeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Validate a rider code</DialogTitle>
        <DialogContent>
          <TextField
            label="6-digit code (on the rider's app)"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            fullWidth
            autoFocus
            inputMode="numeric"
            placeholder="000000"
          />
          {confirmStep && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Confirm that the rider visited {sponsor.businessName} today. This unlocks their reward — it cannot be undone.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCodeOpen(false)} disabled={submitting}>Cancel</Button>
          {!confirmStep && code.length === 6 && (
            <Button variant="contained" disabled={submitting} onClick={() => { setEntered(code); setConfirmStep(true); }}>
              Continue
            </Button>
          )}
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

export default Dashboard;