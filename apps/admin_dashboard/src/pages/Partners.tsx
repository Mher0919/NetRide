import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  InputAdornment,
  Button,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Drawer,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Snackbar,
  Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import {
  listPartners,
  createPartner,
  getPartner,
  setPartnerStatus,
  getPartnerCommissions,
  markCommissionPaid,
  exportPartners,
  exportPartnerRides,
  downloadBlob,
} from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: '#E5F0EB', fg: '#5B7760' },
  INACTIVE: { bg: '#FCE9E9', fg: '#C65A5A' },
  ARCHIVED: { bg: '#EEEEEE', fg: '#666666' },
};

const Partners: React.FC = () => {
  const [partners, setPartners] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: '',
    business_type: '',
    address: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    email: '', // partner login email
    password: '', // partner login password
    commission_rate: '10',
    notes: '',
  });

  const [selected, setSelected] = React.useState<any>(null);
  const [stats, setStats] = React.useState<any>(null);
  const [commissions, setCommissions] = React.useState<any[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [markOpen, setMarkOpen] = React.useState(false);
  const [markTarget, setMarkTarget] = React.useState<any>(null);
  const [markRef, setMarkRef] = React.useState('');
  const [actionLoading, setActionLoading] = React.useState(false);

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPartners({ search, status: statusFilter });
      setPartners(data?.partners ?? []);
    } catch (err) {
      console.error('Failed to fetch partners', err);
      setPartners([]);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  React.useEffect(() => {
    const id = window.setTimeout(fetchData, 250);
    return () => window.clearTimeout(id);
  }, [fetchData]);

  React.useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const [s, c] = await Promise.all([
          getPartner(selected.id),
          getPartnerCommissions(selected.id),
        ]);
        if (cancelled) return;
        setStats(s);
        setCommissions(c?.commissions ?? []);
      } catch (err) {
        console.error('Failed to load partner detail', err);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const openPartner = (p: any) => {
    setStats(null);
    setCommissions([]);
    setSelected(p);
  };

  const handleCreate = async () => {
    if (!form.name.trim() || !form.business_type.trim() || !form.email.trim() || !form.password.trim()) return;
    setSaving(true);
    try {
      await createPartner({
        name: form.name.trim(),
        business_type: form.business_type.trim(),
        address: form.address.trim() || null,
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        contact_email: form.contact_email.trim() || null,
        email: form.email.trim(),
        password: form.password.trim(),
        commission_rate: (Number(form.commission_rate) || 0) / 100,
        notes: form.notes.trim() || null,
      });
      setCreateOpen(false);
      setForm({ name: '', business_type: '', address: '', contact_name: '', contact_phone: '', contact_email: '', email: '', password: '', commission_rate: '10', notes: '' });
      setSnack({ open: true, message: 'Partner created', severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to create partner', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (p: any, status: string) => {
    try {
      await setPartnerStatus(p.id, status);
      setSnack({ open: true, message: `Partner ${status.toLowerCase()}`, severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Status change failed', severity: 'error' });
    }
  };

  const handleMarkPaid = async () => {
    if (!markTarget || !markRef.trim()) return;
    setActionLoading(true);
    try {
      await markCommissionPaid(markTarget.id, markRef.trim());
      setMarkOpen(false);
      setMarkRef('');
      setSnack({ open: true, message: 'Commission marked paid', severity: 'success' });
      fetchData();
      if (selected) {
        const [s, c] = await Promise.all([getPartner(selected.id), getPartnerCommissions(selected.id)]);
        setStats(s);
        setCommissions(c?.commissions ?? []);
      }
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to mark paid', severity: 'error' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleExportPartners = async () => {
    try {
      const blob = await exportPartners();
      downloadBlob(blob, 'partners.csv');
    } catch {
      setSnack({ open: true, message: 'Export failed', severity: 'error' });
    }
  };

  const handleExportRides = async () => {
    if (!selected) return;
    try {
      const blob = await exportPartnerRides(selected.id);
      downloadBlob(blob, `partner-rides-${selected.id.slice(0, 8)}.csv`);
    } catch {
      setSnack({ open: true, message: 'Export failed', severity: 'error' });
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Partners
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Business partners that sponsor promo codes and earn commissions.
          </Typography>
        </Box>
        <Stack direction="row" gap={1}>
          <Button startIcon={<FileDownloadIcon />} onClick={handleExportPartners} sx={{ textTransform: 'none' }}>
            Export CSV
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700 }}
          >
            New Partner
          </Button>
        </Stack>
      </Stack>

      <Stack direction="row" gap={1} mt={3} flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Search name, email, phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ width: 300 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          sx={{ width: 160 }}
          slotProps={{ select: { native: true } }}
        >
          <option value="">All</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
          <option value="ARCHIVED">Archived</option>
        </TextField>
      </Stack>

      <Paper sx={{ mt: 2, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                <TableCell>Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Commission</TableCell>
                <TableCell>Promos</TableCell>
                <TableCell>Lifetime Earnings</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 5 }}>
                    <CircularProgress size={28} />
                  </TableCell>
                </TableRow>
              )}
              {!loading && partners.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No partners found
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                partners.map((p) => {
                  const c = statusColors[p.status] ?? statusColors.INACTIVE;
                  return (
                    <TableRow key={p.id} hover onClick={() => openPartner(p)} sx={{ cursor: 'pointer' }}>
                      <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                      <TableCell>{p.business_type}</TableCell>
                      <TableCell>
                        <Chip size="small" label={p.status} sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 700 }} />
                      </TableCell>
                      <TableCell>{((Number(p.commission_rate) || 0) * 100).toFixed(1)}%</TableCell>
                      <TableCell>{p.active_promo_count ?? 0} / {p.promo_count ?? 0}</TableCell>
                      <TableCell>{fmtUSD(Number(p.lifetime_earnings_cents) || 0)}</TableCell>
                      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          {p.status === 'ACTIVE' && (
                            <Button size="small" color="warning" onClick={() => handleStatusChange(p, 'INACTIVE')}>
                              Deactivate
                            </Button>
                          )}
                          {p.status === 'INACTIVE' && (
                            <Button size="small" sx={{ color: '#5B7760' }} onClick={() => handleStatusChange(p, 'ACTIVE')}>
                              Activate
                            </Button>
                          )}
                          {p.status !== 'ARCHIVED' && (
                            <Button size="small" color="error" onClick={() => handleStatusChange(p, 'ARCHIVED')}>
                              Archive
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>New Partner</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Business name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Business type" placeholder="Restaurant, Gym, Retail…" value={form.business_type} onChange={(e) => setForm({ ...form, business_type: e.target.value })} />
            <TextField label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            <Stack direction="row" spacing={2}>
              <TextField label="Contact name" fullWidth value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} />
              <TextField label="Contact phone" fullWidth value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} />
            </Stack>
            <TextField label="Contact email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
            <Stack direction="row" spacing={2}>
              <TextField label="Partner login email" fullWidth value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <TextField label="Partner login password" fullWidth type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Stack>
            <TextField label="Contact email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
            <TextField
              label="Commission rate (%)"
              type="number"
              value={form.commission_rate}
              onChange={(e) => setForm({ ...form, commission_rate: e.target.value })}
              InputProps={{ inputProps: { min: 0, max: 100, step: 0.5 } }}
            />
            <TextField label="Notes" multiline minRows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={saving || !form.name.trim() || !form.business_type.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Create Partner'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detail drawer */}
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)} PaperProps={{ sx: { width: { xs: '100%', sm: 460 } } }}>
        {selected && (
          <Box sx={{ p: 3 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{selected.name}</Typography>
              <IconButton onClick={() => setSelected(null)}><CloseIcon /></IconButton>
            </Stack>
            <Chip size="small" label={selected.status} sx={{ mt: 1, bgcolor: statusColors[selected.status]?.bg, color: statusColors[selected.status]?.fg, fontWeight: 700 }} />
            <Typography variant="body2" color="text.secondary" mt={1}>
              {selected.business_type} · {((Number(selected.commission_rate) || 0) * 100).toFixed(1)}% commission
            </Typography>

            {detailLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                <CircularProgress size={28} />
              </Box>
            )}

            {!detailLoading && stats && (
              <>
                <Stack direction="row" gap={1.5} mt={3} flexWrap="wrap">
                  {[
                    ['Lifetime', fmtUSD(stats.lifetime_earnings_cents ?? 0)],
                    ['Pending', fmtUSD(stats.pending_earnings_cents ?? 0)],
                    ['Paid', fmtUSD(stats.paid_earnings_cents ?? 0)],
                    ['Promos', `${stats.active_promos ?? 0} active`],
                    ['Rides', `${stats.total_referred_rides ?? 0}`],
                  ].map(([label, value]) => (
                    <Paper key={label} sx={{ flex: '1 1 40%', p: 1.5, borderRadius: 3, bgcolor: '#F7F4EF', border: '1px solid rgba(0,0,0,0.06)' }}>
                      <Typography variant="caption" color="text.secondary">{label}</Typography>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>{value}</Typography>
                    </Paper>
                  ))}
                </Stack>

                <Stack direction="row" gap={1} mt={3}>
                  <Button size="small" variant="outlined" startIcon={<FileDownloadIcon />} onClick={handleExportRides} sx={{ textTransform: 'none' }}>
                    Export rides
                  </Button>
                </Stack>

                <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 3, mb: 1 }}>
                  Commissions
                </Typography>
                {commissions.length === 0 && (
                  <Typography variant="body2" color="text.secondary">No commissions yet.</Typography>
                )}
                {commissions.map((c) => (
                  <Paper key={c.id} sx={{ p: 1.5, mb: 1, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)' }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(Number(c.commission_cents) || 0)}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          Ride {String(c.ride_id ?? '').slice(0, 8)} · rate {((Number(c.commission_rate) || 0) * 100).toFixed(1)}%
                        </Typography>
                      </Box>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Chip
                          size="small"
                          label={c.status}
                          sx={{
                            bgcolor: c.status === 'PAID' ? '#E5F0EB' : '#FCE9E9',
                            color: c.status === 'PAID' ? '#5B7760' : '#C65A5A',
                            fontWeight: 700,
                          }}
                        />
                        {c.status === 'PENDING' && (
                          <Button
                            size="small"
                            sx={{ color: '#5B7760', textTransform: 'none' }}
                            onClick={() => { setMarkTarget(c); setMarkRef(''); setMarkOpen(true); }}
                          >
                            Mark paid
                          </Button>
                        )}
                      </Stack>
                    </Stack>
                  </Paper>
                ))}
              </>
            )}
          </Box>
        )}
      </Drawer>

      {/* Mark paid dialog */}
      <Dialog open={markOpen} onClose={() => setMarkOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Mark commission paid</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            label="Payment reference (e.g. bank transfer #)"
            value={markRef}
            onChange={(e) => setMarkRef(e.target.value)}
            fullWidth
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMarkOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleMarkPaid}
            disabled={actionLoading || !markRef.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Confirm'}
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

export default Partners;
