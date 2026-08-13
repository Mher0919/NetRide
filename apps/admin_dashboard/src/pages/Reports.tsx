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
  CircularProgress,
  Chip,
  IconButton,
  TextField,
  MenuItem,
  InputAdornment,
  Snackbar,
  Alert,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  FormControl,
  InputLabel,
  Select,
  Tooltip,
} from '@mui/material';
import { Search as SearchIcon, Flag as FlagIcon, CheckCircle as CheckCircleIcon } from '@mui/icons-material';
import { listReports, resolveReport } from '../api/admin';

const STATUS_COLORS: Record<string, 'warning' | 'info' | 'success' | 'default'> = {
  OPEN: 'warning',
  IN_REVIEW: 'info',
  RESOLVED: 'success',
  DISMISSED: 'default',
};

const ACTION_LABELS: Record<string, string> = {
  NO_ACTION: 'No action',
  WARNING_ISSUED: 'Warning issued',
  ACCOUNT_SUSPENDED: 'Account suspended',
};

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

const Reports: React.FC = () => {
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  const [statusFilter, setStatusFilter] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState('');
  const [q, setQ] = React.useState('');

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  // Resolve dialog state
  const [resolving, setResolving] = React.useState<any>(null);
  const [resolveStatus, setResolveStatus] = React.useState('RESOLVED');
  const [resolveAction, setResolveAction] = React.useState('NO_ACTION');
  const [resolveNotes, setResolveNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const fetchData = React.useCallback(async (status = statusFilter, role = roleFilter, query = q) => {
    setLoading(true);
    try {
      const data = await listReports({
        status: status || undefined,
        reported_role: role || undefined,
        q: query || undefined,
        limit: 100,
        offset: 0,
      });
      setRows(data.rows);
      setTotal(data.total);
    } catch (err: any) {
      console.error('Failed to fetch reports', err);
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to load ride reports', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, roleFilter, q]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openResolve = (report: any) => {
    setResolving(report);
    setResolveStatus(report.status === 'OPEN' ? 'IN_REVIEW' : report.status);
    setResolveAction(report.resolution_action || 'NO_ACTION');
    setResolveNotes(report.admin_notes || '');
  };

  const submitResolve = async () => {
    if (!resolving) return;
    setSubmitting(true);
    try {
      await resolveReport(resolving.id, {
        status: resolveStatus,
        action: resolveAction,
        admin_notes: resolveNotes,
      });
      setSnack({ open: true, message: 'Report updated', severity: 'success' });
      setResolving(null);
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to resolve report', severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
          Ride Reports
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Both ride parties can report each other after a cancelled or completed ride — each independently, once per ride.
        </Typography>
      </Box>

      <Stack direction="row" spacing={1.5} sx={{ mt: 3, mb: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          sx={{ minWidth: 260 }}
          placeholder="Search reporter / reported / reason…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fetchData();
          }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Status</InputLabel>
          <Select label="Status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); fetchData(e.target.value, roleFilter, q); }}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="OPEN">OPEN</MenuItem>
            <MenuItem value="IN_REVIEW">IN_REVIEW</MenuItem>
            <MenuItem value="RESOLVED">RESOLVED</MenuItem>
            <MenuItem value="DISMISSED">DISMISSED</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel>Reported role</InputLabel>
          <Select label="Reported role" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); fetchData(statusFilter, e.target.value, q); }}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="DRIVER">Driver (rider reports)</MenuItem>
            <MenuItem value="RIDER">Rider (driver reports)</MenuItem>
          </Select>
        </FormControl>
        <Button variant="outlined" size="small" onClick={() => fetchData()}>
          Refresh
        </Button>
      </Stack>

      {loading && !rows.length ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : rows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center', borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
          <FlagIcon sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography color="text.secondary">No reports match these filters.</Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, textTransform: 'uppercase', fontSize: 11, letterSpacing: 0.5 } }}>
                <TableCell>Filed</TableCell>
                <TableCell>Reporter</TableCell>
                <TableCell>Reported</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Ride</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row: any) => (
                <TableRow key={row.id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(row.created_at)}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{row.reporter_name || '?'}</Typography>
                    <Typography variant="caption" color="text.secondary">{row.reporter_email}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {row.reported_name || '?'}
                      <Chip label={row.reported_role} size="small" sx={{ ml: 1, fontSize: 10 }} />
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.reported_email}
                      {row.reported_is_active === false && (
                        <Chip label="SUSPENDED" size="small" color="error" sx={{ ml: 1, fontSize: 9 }} />
                      )}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{row.reason_label || row.reason_code}</Typography>
                    <Tooltip title={row.description || ''}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', maxWidth: 240 }} noWrap>
                        {row.description}
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" noWrap sx={{ display: 'block', maxWidth: 200 }}>
                      {row.pickup_address} → {row.destination_address}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      ride {row.ride_status}
                      {row.cancelled_at ? ` · cancelled ${fmtDate(row.cancelled_at)}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip label={row.status} size="small" color={STATUS_COLORS[row.status] ?? 'default'} />
                    {row.resolution_action && row.resolution_action !== 'NO_ACTION' && (
                      <Chip
                        label={ACTION_LABELS[row.resolution_action]}
                        size="small"
                        color={row.resolution_action === 'ACCOUNT_SUSPENDED' ? 'error' : 'default'}
                        variant="outlined"
                        sx={{ mt: 0.5, display: 'flex', width: 'fit-content', fontSize: 9 }}
                      />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Review / resolve">
                      <IconButton size="small" color="primary" onClick={() => openResolve(row)}>
                        <CheckCircleIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
        {total} report(s) match the current filters.
      </Typography>

      <Dialog open={!!resolving} onClose={() => !submitting && setResolving(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>
          Resolve report {resolving ? `#${resolving.id.slice(0, 8)}` : ''}
        </DialogTitle>
        <DialogContent dividers>
          {resolving && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2">
                <b>{resolving.reporter_name}</b> ({resolving.reporter_role}) reported{' '}
                <b>{resolving.reported_name}</b> ({resolving.reported_role}) for{' '}
                <b>{resolving.reason_label || resolving.reason_code}</b>.
              </Typography>
              <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
                <Typography variant="body2">{resolving.description}</Typography>
                {resolving.reason_text && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    Details: {resolving.reason_text}
                  </Typography>
                )}
              </Paper>
              <FormControl size="small" fullWidth>
                <InputLabel>Resolution status</InputLabel>
                <Select label="Resolution status" value={resolveStatus} onChange={(e) => setResolveStatus(e.target.value)}>
                  <MenuItem value="IN_REVIEW">IN_REVIEW — keep reviewing</MenuItem>
                  <MenuItem value="RESOLVED">RESOLVED — action taken</MenuItem>
                  <MenuItem value="DISMISSED">DISMISSED — no validity</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel>Action</InputLabel>
                <Select
                  label="Action"
                  value={resolveAction}
                  disabled={resolveStatus === 'DISMISSED'}
                  onChange={(e) => setResolveAction(e.target.value)}
                >
                  <MenuItem value="NO_ACTION">No action</MenuItem>
                  <MenuItem value="WARNING_ISSUED">Warning issued (audit log)</MenuItem>
                  <MenuItem value="ACCOUNT_SUSPENDED">Suspend account (deactivate user)</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label="Admin notes"
                multiline
                minRows={2}
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                placeholder={resolveAction === 'ACCOUNT_SUSPENDED' ? 'Reason shown to the suspended user' : 'Internal notes'}
              />
              {resolveAction === 'ACCOUNT_SUSPENDED' && (
                <Alert severity="warning">
                  This deactivates <b>{resolving.reported_name}</b> immediately (blocked_reason set). Re-activation happens via the Users page.
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolving(null)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="contained" color="primary" onClick={submitResolve} disabled={submitting}>
            {submitting ? 'Saving…' : 'Save resolution'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack.open}
        autoHideDuration={4000}
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

export default Reports;