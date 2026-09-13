import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Snackbar,
  Alert,
  Stack,
} from '@mui/material';
import { listPortalValidations, portalValidate, portalCancelValidation } from '../api/sponsor';

export type ValidationRow = Record<string, unknown> & {
  id?: string;
  rider_name?: string;
  rider_id?: string;
  discount_label?: string;
  calculated_discount_cents?: number;
  ride_completed_at?: string;
  validation_expires_at?: string;
  status?: string;
};

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

const statusColors: Record<string, { bg: string; fg: string }> = {
  CREATED: { bg: '#E8F0FE', fg: '#1A73E8' },
  RIDE_PENDING: { bg: '#E3F2FD', fg: '#1565C0' },
  WAITING_FOR_SPONSOR: { bg: '#FFF4E5', fg: '#B26A00' },
  SPONSOR_VALIDATED: { bg: '#E5F0EB', fg: '#2E7D32' },
  REWARD_COMPLETED: { bg: '#E5F0EB', fg: '#2E7D32' },
  CANCELLED: { bg: '#FCE9E9', fg: '#C65A5A' },
  EXPIRED: { bg: '#EEEEEE', fg: '#999999' },
};

const TABS = ['CREATED', 'RIDE_PENDING', 'WAITING_FOR_SPONSOR', 'SPONSOR_VALIDATED', 'REWARD_COMPLETED', 'CANCELLED', 'EXPIRED'];

const Validations: React.FC = () => {
  const [tab, setTab] = React.useState('WAITING_FOR_SPONSOR');
  const [rows, setRows] = React.useState<ValidationRow[]>([]);
  const [loading, setLoading] = React.useState(true);

  const [codeOpen, setCodeOpen] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [confirmStep, setConfirmStep] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const [cancelTarget, setCancelTarget] = React.useState<ValidationRow | null>(null);
  const [cancelReason, setCancelReason] = React.useState('VISIT_NOT_CONFIRMED');
  const [cancelConfirm, setCancelConfirm] = React.useState(false);

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const d = await listPortalValidations(tab);
      setRows((d?.validations ?? []) as ValidationRow[]);
    } catch (err) {
      console.error('Failed to load validations', err);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  // Defer past the current render so setState inside `load` never cascades
  // during the effect itself (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const errMsg = (err: unknown, fallback: string) => {
    if (err instanceof Error) return err.message ?? fallback;
    const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
    return data?.error ?? fallback;
  };

  const submitCode = async () => {
    setSubmitting(true);
    try {
      await portalValidate(code, true);
      setSnack({ open: true, message: 'Visit validated', severity: 'success' });
      setCodeOpen(false);
      setCode('');
      setConfirmStep(false);
      load();
    } catch (err: unknown) {
      setSnack({ open: true, message: errMsg(err, 'Validation failed'), severity: 'error' });
      setConfirmStep(false);
    } finally {
      setSubmitting(false);
    }
  };

  const submitCancel = async () => {
    setSubmitting(true);
    try {
      await portalCancelValidation(cancelTarget?.id ?? '', cancelReason, '', true);
      setSnack({ open: true, message: 'Validation cancelled', severity: 'success' });
      setCancelTarget(null);
      setCancelConfirm(false);
      setCancelReason('VISIT_NOT_CONFIRMED');
      load();
    } catch (err: unknown) {
      setSnack({ open: true, message: errMsg(err, 'Cancel failed'), severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>Validations</Typography>
          <Typography variant="body2" color="text.secondary">Enter the 6-digit code from the rider's app to confirm their visit.</Typography>
        </Box>
        <Button variant="contained" onClick={() => { setCode(''); setConfirmStep(false); setCodeOpen(true); }}>Validate code</Button>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mb: 1, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <Chip
            key={t}
            label={t.replace(/_/g, ' ')}
            clickable
            onClick={() => setTab(t)}
            sx={{
              fontWeight: 700,
              bgcolor: tab === t ? 'primary.main' : 'transparent',
              color: tab === t ? 'white' : 'text.secondary',
              '&:hover': { bgcolor: tab === t ? 'primary.main' : 'rgba(0,0,0,0.05)' },
            }}
          />
        ))}
      </Stack>
      {(tab === 'CREATED' || tab === 'RIDE_PENDING') && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Upcoming codes — the rider hasn't completed their ride yet, so no code has been issued. These move to “Waiting for sponsor” once the ride finishes.
        </Typography>
      )}

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 11, textTransform: 'uppercase', color: 'text.secondary' } }}>
              <TableCell>Rider</TableCell>
              <TableCell>Discount</TableCell>
              <TableCell>Ride completed</TableCell>
              <TableCell>Code expires</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6 }}><CircularProgress size={28} /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>Nothing here yet</TableCell></TableRow>
            ) : (
              rows.map((r) => {
                const sc = statusColors[r.status] ?? { bg: '#EEE', fg: '#666' };
                return (
                  <TableRow key={r.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{r.rider_name}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.rider_id?.slice(0, 8)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={`${r.discount_label} — ${fmtUSD(r.calculated_discount_cents)}`} sx={{ bgcolor: '#EDEDFF', color: '#4F46E5', fontWeight: 700 }} />
                    </TableCell>
                    <TableCell sx={{ fontSize: 13 }}>{fmtDateTime(r.ride_completed_at)}</TableCell>
                    <TableCell sx={{ fontSize: 13 }}>{fmtDateTime(r.validation_expires_at)}</TableCell>
                    <TableCell>
                      <Chip size="small" label={r.status} sx={{ bgcolor: sc.bg, color: sc.fg, fontWeight: 700, fontSize: 11 }} />
                    </TableCell>
                    <TableCell align="right">
                      {r.status === 'WAITING_FOR_SPONSOR' && (
                        <Button size="small" color="error" onClick={() => { setCancelTarget(r); setCancelReason('VISIT_NOT_CONFIRMED'); setCancelConfirm(false); }}>
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Validate dialog */}
      <Dialog open={codeOpen} onClose={() => !submitting && setCodeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Validate a rider code</DialogTitle>
        <DialogContent>
          <TextField
            label="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            fullWidth
            autoFocus
            inputMode="numeric"
            placeholder="000000"
            sx={{ mt: 1 }}
          />
          {confirmStep && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Confirm the rider visited your business today. This unlocks their reward — it cannot be undone.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCodeOpen(false)} disabled={submitting}>Cancel</Button>
          {!confirmStep && code.length === 6 && (
            <Button variant="contained" disabled={submitting} onClick={() => setConfirmStep(true)}>Continue</Button>
          )}
          {confirmStep && (
            <Button variant="contained" color="success" disabled={submitting} onClick={submitCode}>
              {submitting ? 'Validating…' : `Confirm ${code}`}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Cancel dialog (double confirm) */}
      <Dialog open={!!cancelTarget} onClose={() => !submitting && setCancelTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Cancel validation?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Rider <b>{cancelTarget?.rider_name}</b> will lose this special. Their reserved discount is released back to your budget.
          </Typography>
          {!cancelConfirm ? (
            <>
              <TextField
                label="Reason code"
                select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                fullWidth
                sx={{ mt: 2 }}
                SelectProps={{ native: true }}
              >
                <option value="VISIT_NOT_CONFIRMED">Visit not confirmed</option>
                <option value="DUPLICATE">Duplicate code</option>
                <option value="FRAUD">Fraud suspected</option>
                <option value="OTHER">Other</option>
              </TextField>
              <Button variant="contained" color="error" fullWidth size="large" sx={{ mt: 2 }} onClick={() => setCancelConfirm(true)}>
                Continue to cancel
              </Button>
            </>
          ) : (
            <>
              <Alert severity="error" sx={{ mt: 2 }}>
                This permanently cancels the special for this rider. Budget reserved for it is released. Are you sure?
              </Alert>
              <Button variant="contained" color="error" fullWidth size="large" sx={{ mt: 2 }} disabled={submitting} onClick={submitCancel}>
                {submitting ? 'Cancelling…' : 'Yes, cancel it'}
              </Button>
              <Button size="small" fullWidth sx={{ mt: 1 }} disabled={submitting} onClick={() => setCancelConfirm(false)}>Back</Button>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Validations;