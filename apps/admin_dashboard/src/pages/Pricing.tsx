import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Snackbar,
  Alert,
  TextField,
  Tooltip,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import { listPricingProfiles, updatePricingProfile } from '../api/admin';

const NUMBER_KEYS: { key: string; label: string; step?: number }[] = [
  { key: 'base_fare', label: 'Base fare ($)' },
  { key: 'per_mile_rate', label: 'Per mile ($)', step: 0.05 },
  { key: 'per_minute_rate', label: 'Per minute ($)', step: 0.01 },
  { key: 'minimum_fare', label: 'Minimum fare ($)', step: 0.05 },
  { key: 'booking_fee', label: 'Booking fee ($)', step: 0.05 },
  { key: 'service_fee_rate', label: 'Service fee rate (fraction)' },
  { key: 'tax_rate', label: 'Tax rate (fraction)' },
  { key: 'max_demand_multiplier', label: 'Max demand multiplier', step: 0.05 },
  { key: 'peak_time_multiplier', label: 'Peak time multiplier', step: 0.05 },
  { key: 'off_peak_multiplier', label: 'Off-peak multiplier', step: 0.05 },
  { key: 'weather_multiplier', label: 'Weather multiplier', step: 0.05 },
  { key: 'location_multiplier', label: 'Location multiplier', step: 0.05 },
  { key: 'fleet_multiplier', label: 'Fleet multiplier', step: 0.05 },
];

const fmtMoney = (v: number | null | undefined) =>
  (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const Pricing: React.FC = () => {
  const [profiles, setProfiles] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [editTarget, setEditTarget] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string>>({});

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPricingProfiles();
      setProfiles(data?.profiles ?? []);
    } catch (err) {
      console.error('Failed to fetch pricing profiles', err);
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openEdit = (p: any) => {
    setEditTarget(p);
    const initial: Record<string, string> = { label: p.label ?? '' };
    for (const { key } of NUMBER_KEYS) {
      initial[key] = String(p[key] ?? 0);
    }
    setForm(initial);
  };

  const handleSave = async () => {
    if (!editTarget) return;
    setSaving(true);
    const payload: Record<string, unknown> = { label: form.label };
    for (const { key } of NUMBER_KEYS) {
      payload[key] = Number(form[key]);
    }
    try {
      await updatePricingProfile(editTarget.code, payload);
      setSnack({ open: true, message: `${editTarget.label} updated — live immediately`, severity: 'success' });
      setEditTarget(null);
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to update profile', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Pricing Profiles
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Flat-fare engine: base + per mile + per minute, floored at the minimum fare. Changes apply to the next estimate.
          </Typography>
        </Box>
      </Stack>

      <Paper sx={{ mt: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                <TableCell>Profile</TableCell>
                <TableCell>Base</TableCell>
                <TableCell>Per mile</TableCell>
                <TableCell>Per min</TableCell>
                <TableCell>Minimum</TableCell>
                <TableCell>Fees / tax</TableCell>
                <TableCell>Multipliers</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 5 }}>
                    <CircularProgress size={28} />
                  </TableCell>
                </TableRow>
              )}
              {!loading && profiles.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No active pricing profiles.
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                profiles.map((p) => (
                  <TableRow key={p.code} hover>
                    <TableCell>
                      <Typography sx={{ fontWeight: 700 }}>{p.label}</Typography>
                      <Typography variant="caption" color="text.secondary">{p.code}</Typography>
                    </TableCell>
                    <TableCell>{fmtMoney(p.base_fare)}</TableCell>
                    <TableCell>{fmtMoney(p.per_mile_rate)}</TableCell>
                    <TableCell>{fmtMoney(p.per_minute_rate)}</TableCell>
                    <TableCell>
                      <Typography sx={{ fontWeight: 700, color: '#5B7760' }}>{fmtMoney(p.minimum_fare)}</Typography>
                    </TableCell>
                    <TableCell>
                      {Number(p.booking_fee) > 0 || Number(p.service_fee_rate) > 0 || Number(p.tax_rate) > 0
                        ? `$${Number(p.booking_fee) || 0} / ${((Number(p.service_fee_rate) || 0) * 100).toFixed(1)}% / ${((Number(p.tax_rate) || 0) * 100).toFixed(1)}%`
                        : 'None'}
                    </TableCell>
                    <TableCell>
                      {[p.peak_time_multiplier, p.weather_multiplier, p.location_multiplier, p.fleet_multiplier].every(
                        (m) => Number(m) === 1
                      ) && Number(p.max_demand_multiplier) === 1
                        ? 'Flat (1.00)'
                        : `demand ≤${Number(p.max_demand_multiplier) || 1} · peak ${Number(p.peak_time_multiplier) || 1} · off ${Number(p.off_peak_multiplier) || 1}`}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit rates">
                        <Button size="small" startIcon={<EditIcon fontSize="small" />} onClick={() => openEdit(p)} sx={{ textTransform: 'none', color: '#5B7760', fontWeight: 700 }}>
                          Edit
                        </Button>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onClose={() => setEditTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle>Edit {editTarget?.label}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Display label"
              value={form.label ?? ''}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
            <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 1 }}>Fare components</Typography>
            {NUMBER_KEYS.filter((k) => !k.key.includes('multiplier')).map(({ key, label, step }) => (
              <TextField
                key={key}
                label={label}
                type="number"
                inputProps={{ step: step ?? 'any' }}
                value={form[key] ?? '0'}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            ))}
            <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 1 }}>Multipliers</Typography>
            {NUMBER_KEYS.filter((k) => k.key.includes('multiplier')).map(({ key, label, step }) => (
              <TextField
                key={key}
                label={label}
                type="number"
                inputProps={{ step: step ?? 'any' }}
                value={form[key] ?? '1'}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditTarget(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })}>
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack({ ...snack, open: false })}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Pricing;
