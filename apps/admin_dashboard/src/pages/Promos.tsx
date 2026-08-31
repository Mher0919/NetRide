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
  FormControlLabel,
  Switch,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import PowerIcon from '@mui/icons-material/PowerSettingsNew';
import CloseIcon from '@mui/icons-material/Close';
import {
  listPromos,
  getPromo,
  createPromo,
  updatePromo,
  deletePromo,
  setPromoActive,
  clonePromo,
  listPartners,
} from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const emptyForm = {
  code: '',
  partner_id: '',
  discount_type: 'PERCENTAGE',
  discount_value: '10',
  max_uses: '0',
  expires_at: '',
  active: true,
  min_ride_fare_cents: '0',
  max_discount_cents: '0',
  single_use_per_rider: true,
};

const Promos: React.FC = () => {
  const [promos, setPromos] = React.useState<any[]>([]);
  const [partners, setPartners] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);

  const [selected, setSelected] = React.useState<any>(null);
  const [usage, setUsage] = React.useState<any[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [deleteTarget, setDeleteTarget] = React.useState<any>(null);
  const [actionLoading, setActionLoading] = React.useState(false);

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPromos({ search });
      setPromos(data?.promos ?? []);
    } catch (err) {
      console.error('Failed to fetch promos', err);
      setPromos([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

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
    (async () => {
      try {
        const data = await listPartners({ status: 'ACTIVE' });
        setPartners(data?.partners ?? []);
      } catch {
        setPartners([]);
      }
    })();
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const data = await getPromo(selected.id);
        if (cancelled) return;
        setSelected(data.promo);
        setUsage(data.usage ?? []);
      } catch (err) {
        console.error('Failed to load promo detail', err);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditTarget(null);
    setCreateOpen(true);
  };

  const openEdit = (p: any) => {
    setEditTarget(p);
    setForm({
      code: p.code,
      partner_id: p.partner_id ?? '',
      discount_type: p.discount_type,
      discount_value: String(p.discount_value ?? 0),
      max_uses: String(p.max_uses ?? 0),
      expires_at: p.expires_at ? String(p.expires_at).slice(0, 16) : '',
      active: !!p.active,
      min_ride_fare_cents: String(p.min_ride_fare_cents ?? 0),
      max_discount_cents: String(p.max_discount_cents ?? 0),
      single_use_per_rider: !!p.single_use_per_rider,
    });
    setCreateOpen(true);
  };

  const handleSave = async () => {
    if (!form.code.trim()) return;
    setSaving(true);
    const payload = {
      partner_id: form.partner_id || null,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value) || 0,
      max_uses: Number(form.max_uses) || 0,
      expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      active: form.active,
      min_ride_fare_cents: Number(form.min_ride_fare_cents) || 0,
      max_discount_cents: Number(form.max_discount_cents) || 0,
      single_use_per_rider: form.single_use_per_rider,
    };
    try {
      if (editTarget) {
        await updatePromo(editTarget.id, payload);
        setSnack({ open: true, message: 'Promo updated', severity: 'success' });
      } else {
        await createPromo({ ...payload, code: form.code.trim().toUpperCase() });
        setSnack({ open: true, message: 'Promo created', severity: 'success' });
      }
      setCreateOpen(false);
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to save promo', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (p: any) => {
    try {
      await setPromoActive(p.id, !p.active);
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to update promo', severity: 'error' });
    }
  };

  const handleClone = async (p: any) => {
    try {
      await clonePromo(p.id);
      setSnack({ open: true, message: 'Promo cloned', severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to clone promo', severity: 'error' });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setActionLoading(true);
    try {
      await deletePromo(deleteTarget.id);
      setDeleteTarget(null);
      setSnack({ open: true, message: 'Promo deleted', severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to delete promo', severity: 'error' });
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Promo Codes
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Rider-facing discount codes, optionally backed by a partner.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700 }}
        >
          New Promo
        </Button>
      </Stack>

      <TextField
        size="small"
        placeholder="Search promo code…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        sx={{ mt: 3, width: 300 }}
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
      />

      <Paper sx={{ mt: 2, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                <TableCell>Code</TableCell>
                <TableCell>Partner</TableCell>
                <TableCell>Discount</TableCell>
                <TableCell>Usage</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell>Status</TableCell>
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
              {!loading && promos.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No promos found
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                promos.map((p) => {
                  const expired = p.expires_at && new Date(p.expires_at).getTime() < now;
                  const maxed = p.max_uses > 0 && p.times_used >= p.max_uses;
                  const active = !!p.active && !expired && !maxed;
                  return (
                    <TableRow key={p.id} hover onClick={() => setSelected(p)} sx={{ cursor: 'pointer' }}>
                      <TableCell sx={{ fontWeight: 700 }}>{p.code}</TableCell>
                      <TableCell>{p.partner_name ?? '—'}</TableCell>
                      <TableCell>
                        {p.discount_type === 'PERCENTAGE' ? `${p.discount_value}%` : fmtUSD(Number(p.discount_value) || 0)}
                        {Number(p.max_discount_cents) > 0 && p.discount_type === 'PERCENTAGE' && ` (max ${fmtUSD(Number(p.max_discount_cents))})`}
                      </TableCell>
                      <TableCell>
                        {p.times_used ?? 0}{p.max_uses > 0 ? ` / ${p.max_uses}` : ''}
                      </TableCell>
                      <TableCell>
                        {p.expires_at ? new Date(p.expires_at).toLocaleDateString() : 'Never'}
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={active ? 'Active' : maxed ? 'Exhausted' : expired ? 'Expired' : 'Disabled'}
                          sx={{
                            bgcolor: active ? '#E5F0EB' : '#FCE9E9',
                            color: active ? '#5B7760' : '#C65A5A',
                            fontWeight: 700,
                          }}
                        />
                      </TableCell>
                      <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <IconButton size="small" title={p.active ? 'Deactivate' : 'Activate'} onClick={() => handleToggleActive(p)}>
                            <PowerIcon fontSize="small" sx={{ color: p.active ? '#5B7760' : '#999999' }} />
                          </IconButton>
                          <IconButton size="small" title="Edit" onClick={() => openEdit(p)}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" title="Clone" onClick={() => handleClone(p)}>
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" title="Delete" onClick={() => setDeleteTarget(p)}>
                            <DeleteIcon fontSize="small" color="error" />
                          </IconButton>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Create/edit dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editTarget ? `Edit ${editTarget.code}` : 'New Promo'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Code"
              value={form.code}
              disabled={!!editTarget}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              InputProps={{ startAdornment: <InputAdornment position="start">NetRide_</InputAdornment> }}
            />
            <TextField
              select
              label="Partner"
              value={form.partner_id}
              onChange={(e) => setForm({ ...form, partner_id: e.target.value })}
              slotProps={{ select: { native: true } }}
            >
              <option value="">— No partner (NetRide promo) —</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </TextField>
            <Stack direction="row" spacing={2}>
              <TextField
                select
                label="Discount type"
                value={form.discount_type}
                onChange={(e) => setForm({ ...form, discount_type: e.target.value })}
                sx={{ width: 160 }}
                slotProps={{ select: { native: true } }}
              >
                <option value="PERCENTAGE">Percentage</option>
                <option value="FIXED">Fixed $</option>
              </TextField>
              <TextField
                label={form.discount_type === 'PERCENTAGE' ? 'Percent off' : 'Dollar off'}
                type="number"
                value={form.discount_value}
                onChange={(e) => setForm({ ...form, discount_value: e.target.value })}
                fullWidth
              />
            </Stack>
            {form.discount_type === 'PERCENTAGE' && (
              <TextField
                label="Max discount ($)"
                type="number"
                value={form.max_discount_cents}
                onChange={(e) => setForm({ ...form, max_discount_cents: e.target.value })}
              />
            )}
            <Stack direction="row" spacing={2}>
              <TextField
                label="Max uses (0 = unlimited)"
                type="number"
                value={form.max_uses}
                onChange={(e) => setForm({ ...form, max_uses: e.target.value })}
                fullWidth
              />
              <TextField
                label="Min ride fare ($)"
                type="number"
                value={form.min_ride_fare_cents}
                onChange={(e) => setForm({ ...form, min_ride_fare_cents: e.target.value })}
                fullWidth
              />
            </Stack>
            <TextField
              label="Expires"
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
              InputLabelProps={{ shrink: true }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                  sx={{ '& .MuiSwitch-switchBase.Mui-checked': { color: '#5B7760' } }}
                />
              }
              label="Active immediately"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.single_use_per_rider}
                  onChange={(e) => setForm({ ...form, single_use_per_rider: e.target.checked })}
                  sx={{ '& .MuiSwitch-switchBase.Mui-checked': { color: '#5B7760' } }}
                />
              }
              label="Single use per rider"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !form.code.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detail drawer */}
      <Drawer anchor="right" open={!!selected && !createOpen} onClose={() => setSelected(null)} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
        {selected && (
          <Box sx={{ p: 3 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{selected.code}</Typography>
              <IconButton onClick={() => setSelected(null)}><CloseIcon /></IconButton>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {selected.partner_name ?? 'NetRide promo'} · {selected.discount_type === 'PERCENTAGE' ? `${selected.discount_value}%` : fmtUSD(Number(selected.discount_value))} off · used {selected.times_used ?? 0}{selected.max_uses > 0 ? `/${selected.max_uses}` : ''} times
            </Typography>
            {detailLoading && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                <CircularProgress size={28} />
              </Box>
            )}
            {!detailLoading && (
              <>
                <Typography variant="subtitle2" sx={{ fontWeight: 800, mt: 3, mb: 1 }}>Usage</Typography>
                {usage.length === 0 && <Typography variant="body2" color="text.secondary">No rides have used this code.</Typography>}
                {usage.map((u) => (
                  <Paper key={u.id} sx={{ p: 1.5, mb: 1, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)' }}>
                    <Stack direction="row" justifyContent="space-between">
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{u.rider_name ?? u.rider_id?.slice(0, 8)}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {u.status} · {u.created_at ? new Date(u.created_at).toLocaleString() : ''}
                        </Typography>
                      </Box>
                      <Typography variant="body2" sx={{ fontWeight: 700, color: '#5B7760' }}>
                        −{fmtUSD(Number(u.discount_cents) || 0)}
                      </Typography>
                    </Stack>
                  </Paper>
                ))}
              </>
            )}
          </Box>
        )}
      </Drawer>

      {/* Delete dialog */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete promo</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Delete <b>{deleteTarget?.code}</b>? This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={actionLoading} sx={{ textTransform: 'none' }}>
            {actionLoading ? <CircularProgress size={20} color="inherit" /> : 'Delete'}
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

export default Promos;
