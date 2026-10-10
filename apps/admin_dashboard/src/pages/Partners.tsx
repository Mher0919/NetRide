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
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import {
  listPartners,
  createPartner,
  updatePartner,
  deletePartner,
  getPartner,
  setPartnerStatus,
  getPartnerCommissions,
  markCommissionPaid,
  exportPartners,
  exportPartnerRides,
  downloadBlob,
  type PortalUserOption,
} from '../api/admin';
import UserPicker from '../components/UserPicker';

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
  const [createUserMode, setCreateUserMode] = React.useState<'NEW' | 'EXISTING'>('NEW');
  const [createUser, setCreateUser] = React.useState<PortalUserOption | null>(null);
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

  const [editOpen, setEditOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<any>(null);
  const [editForm, setEditForm] = React.useState({
    name: '',
    business_type: '',
    address: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    email: '',
    password: '',
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

  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name?: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = React.useState(false);

  const [showCreatePassword, setShowCreatePassword] = React.useState(false);
  const [showEditPassword, setShowEditPassword] = React.useState(false);

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
    if (!form.name.trim() || !form.business_type.trim()) return;
    if (createUserMode === 'EXISTING' && !createUser) {
      setSnack({ open: true, message: 'Select the existing user to link', severity: 'error' });
      return;
    }
    if (createUserMode === 'NEW' && (!form.email.trim() || !form.password.trim())) {
      setSnack({ open: true, message: 'Login email and password are required for a new user', severity: 'error' });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        business_type: form.business_type.trim(),
        address: form.address.trim() || null,
        contact_name: form.contact_name.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        contact_email: form.contact_email.trim() || null,
        user_mode: createUserMode,
        commission_rate: (Number(form.commission_rate) || 0) / 100,
        notes: form.notes.trim() || null,
      };
      if (createUserMode === 'EXISTING') {
        payload.user_id = createUser!.id;
      } else {
        payload.email = form.email.trim();
        payload.password = form.password.trim();
      }
      await createPartner(payload);
      setCreateOpen(false);
      setCreateUser(null);
      setCreateUserMode('NEW');
      setForm({ name: '', business_type: '', address: '', contact_name: '', contact_phone: '', contact_email: '', email: '', password: '', commission_rate: '10', notes: '' });
      setSnack({
        open: true,
        message: createUserMode === 'EXISTING' ? 'Partner created and linked to the existing user' : 'Partner created',
        severity: 'success',
      });
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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deletePartner(deleteTarget.id);
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      setSnack({ open: true, message: 'Partner permanently deleted', severity: 'success' });
      fetchData();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSnack({ open: true, message: msg || 'Failed to delete partner', severity: 'error' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const openEdit = (p: any) => {
    setEditTarget(p);
    setEditForm({
      name: p.name ?? '',
      business_type: p.business_type ?? '',
      address: p.address ?? '',
      contact_name: p.contact_name ?? '',
      contact_phone: p.contact_phone ?? '',
      contact_email: p.contact_email ?? '',
      email: p.email ?? '',
      password: '',
      commission_rate: ((Number(p.commission_rate) || 0) * 100).toFixed(1),
      notes: p.notes ?? '',
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editTarget || !editForm.name.trim() || !editForm.business_type.trim()) return;
    setSaving(true);
    try {
      await updatePartner(editTarget.id, {
        name: editForm.name.trim(),
        business_type: editForm.business_type.trim(),
        address: editForm.address.trim() || null,
        contact_name: editForm.contact_name.trim() || null,
        contact_phone: editForm.contact_phone.trim() || null,
        contact_email: editForm.contact_email.trim() || null,
        email: editForm.email.trim(),
        ...(editForm.password.trim() ? { password: editForm.password.trim() } : {}),
        commission_rate: (Number(editForm.commission_rate) || 0) / 100,
        notes: editForm.notes.trim() || null,
      });
      setEditOpen(false);
      setSnack({ open: true, message: 'Partner updated', severity: 'success' });
      fetchData();
      if (selected && selected.id === editTarget.id) {
        setSelected({ ...selected, name: editForm.name.trim(), business_type: editForm.business_type.trim(), commission_rate: (Number(editForm.commission_rate) || 0) / 100 });
      }
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to update partner', severity: 'error' });
    } finally {
      setSaving(false);
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
    <Box sx={{ p: { xs: 0, sm: 3 } }}>
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
            onClick={() => {
              setCreateUserMode('NEW');
              setCreateUser(null);
              setCreateOpen(true);
            }}
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
                          <Button size="small" sx={{ color: '#5B7760' }} onClick={() => openEdit(p)}>
                            Edit
                          </Button>
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
                          <IconButton size="small" title="Delete permanently" onClick={() => setDeleteTarget(p)}>
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
            <Stack direction="row" spacing={2}>
              <TextField label="Contact email" fullWidth value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} />
            </Stack>

            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>Partner login</Typography>
              <ToggleButtonGroup
                value={createUserMode}
                exclusive
                onChange={(_, v) => v && setCreateUserMode(v)}
                fullWidth
                size="small"
                sx={{ mb: 1.5 }}
              >
                <ToggleButton value="NEW" sx={{ textTransform: 'none', fontWeight: createUserMode === 'NEW' ? 700 : 400 }}>
                  Create new user
                </ToggleButton>
                <ToggleButton value="EXISTING" sx={{ textTransform: 'none', fontWeight: createUserMode === 'EXISTING' ? 700 : 400 }}>
                  Use existing user
                </ToggleButton>
              </ToggleButtonGroup>

              {createUserMode === 'EXISTING' ? (
                <>
                  <UserPicker value={createUser} onChange={setCreateUser} disabled={saving} label="Partner login — existing user" />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    The partner logs in with that user's existing credentials — their password is never changed, so a
                    sponsor/partner identity stays the same across both dashboards.
                  </Typography>
                </>
              ) : (
                <>
                  <TextField
                    label="Partner login email"
                    fullWidth
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    sx={{ mb: 1.5 }}
                  />
                  <TextField
                    label="Partner login password"
                    fullWidth
                    type={showCreatePassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton
                              aria-label={showCreatePassword ? 'Hide password' : 'Show password'}
                              onClick={() => setShowCreatePassword((v) => !v)}
                              edge="end"
                              size="small"
                            >
                              {showCreatePassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                            </IconButton>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                </>
              )}
            </Box>
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

      {/* Edit dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Edit Partner</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label="Business name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            <TextField label="Business type" placeholder="Restaurant, Gym, Retail…" value={editForm.business_type} onChange={(e) => setEditForm({ ...editForm, business_type: e.target.value })} />
            <TextField label="Address" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
            <Stack direction="row" spacing={2}>
              <TextField label="Contact name" fullWidth value={editForm.contact_name} onChange={(e) => setEditForm({ ...editForm, contact_name: e.target.value })} />
              <TextField label="Contact phone" fullWidth value={editForm.contact_phone} onChange={(e) => setEditForm({ ...editForm, contact_phone: e.target.value })} />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label="Contact email" fullWidth value={editForm.contact_email} onChange={(e) => setEditForm({ ...editForm, contact_email: e.target.value })} />
              <TextField label="Partner login email" fullWidth value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </Stack>
            <TextField
              label="New password (leave blank to keep current)"
              fullWidth
              type={showEditPassword ? 'text' : 'password'}
              value={editForm.password}
              onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label={showEditPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowEditPassword((v) => !v)}
                        edge="end"
                        size="small"
                      >
                        {showEditPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <TextField
              label="Commission rate (%)"
              type="number"
              value={editForm.commission_rate}
              onChange={(e) => setEditForm({ ...editForm, commission_rate: e.target.value })}
              InputProps={{ inputProps: { min: 0, max: 100, step: 0.5 } }}
            />
            <TextField label="Notes" multiline minRows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleEdit}
            disabled={saving || !editForm.name.trim() || !editForm.business_type.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Save Changes'}
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
                  <Button size="small" variant="outlined" onClick={() => openEdit(selected)} sx={{ textTransform: 'none' }}>
                    Edit partner
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

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onClose={() => !deleteLoading && setDeleteTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Delete partner permanently?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Are you sure you want to delete <b>{deleteTarget?.name}</b>? This cannot be undone.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Its commission history and portal account will be permanently deleted. Its promo
            codes will remain but will no longer be linked to a partner.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteLoading} sx={{ textTransform: 'none' }}>
            No
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDelete}
            disabled={deleteLoading}
            sx={{ textTransform: 'none' }}
          >
            {deleteLoading ? <CircularProgress size={20} color="inherit" /> : 'Yes, delete'}
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
