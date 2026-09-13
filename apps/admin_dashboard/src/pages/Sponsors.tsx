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
  Tabs,
  Tab,
  Grid,
  Divider,
  Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import StorefrontIcon from '@mui/icons-material/Storefront';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import {
  listSponsors,
  createSponsor,
  updateSponsor,
  getSponsor,
  setSponsorStatus,
  adjustSponsorBudget,
  createSponsorPortalAccount,
  resetSponsorPortalPassword,
  disableSponsorPortalAccount,
} from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString() : '—';

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: '#E5F0EB', fg: '#2E7D32' },
  INACTIVE: { bg: '#EEEEEE', fg: '#666666' },
  DEPLETED: { bg: '#FCE9E9', fg: '#C65A5A' },
  SUSPENDED: { bg: '#FCE9E9', fg: '#C65A5A' },
};

const redemptionStatusColors: Record<string, { bg: string; fg: string }> = {
  CREATED: { bg: '#E5F0EB', fg: '#2E7D32' },
  RIDE_PENDING: { bg: '#EEEEEE', fg: '#666666' },
  WAITING_FOR_SPONSOR: { bg: '#FFF4E5', fg: '#B26A00' },
  SPONSOR_VALIDATED: { bg: '#E5F0EB', fg: '#2E7D32' },
  REWARD_COMPLETED: { bg: '#E5F0EB', fg: '#2E7D32' },
  CANCELLED: { bg: '#FCE9E9', fg: '#C65A5A' },
  EXPIRED: { bg: '#EEEEEE', fg: '#999999' },
};

const emptyForm = {
  businessName: '',
  businessType: 'RESTAURANT',
  businessDescription: '',
  managerName: '',
  phone: '',
  email: '',
  address: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  discountType: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED_AMOUNT',
  discountPercent: '25',
  maxDiscountPercent: '25',
  discountFixedAmountCents: '500',
  initialBudgetCents: '100000',
  specialsEnabled: true,
};

interface SnackState {
  open: boolean;
  message: string;
  severity: 'success' | 'error';
}

const errMsg = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

const Sponsors: React.FC = () => {
  const [sponsors, setSponsors] = React.useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);

  const [selected, setSelected] = React.useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = React.useState<Record<string, unknown> | null>(null);
  const [detailTab, setDetailTab] = React.useState(0);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [adjustForm, setAdjustForm] = React.useState({ direction: 'CREDIT' as 'CREDIT' | 'DEBIT', amountCents: '', reason: '' });

  const [portalForm, setPortalForm] = React.useState({ email: '' });
  const [newPassword, setNewPassword] = React.useState<string | null>(null);

  const [editOpen, setEditOpen] = React.useState(false);
  const [editSaving, setEditSaving] = React.useState(false);
  const [editForm, setEditForm] = React.useState(emptyForm);

  const [snack, setSnack] = React.useState<SnackState>({
    open: false,
    message: '',
    severity: 'success',
  });

  const notify = (message: string, severity: 'success' | 'error' = 'success') =>
    setSnack({ open: true, message, severity });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSponsors({ search, status: statusFilter, limit: 200 });
      setSponsors(data?.sponsors ?? []);
      setTotal(data?.total ?? 0);
    } catch (err) {
      console.error('Failed to fetch sponsors', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  React.useEffect(() => {
    const id = window.setTimeout(fetchData, 250);
    return () => window.clearTimeout(id);
  }, [fetchData]);

  const loadDetail = React.useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await getSponsor(id);
      setDetail(d);
    } catch (err) {
      console.error('Failed to load sponsor detail', err);
      notify('Failed to load sponsor detail', 'error');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setDetailLoading(true);
    (async () => {
      try {
        const d = await getSponsor(selected.id as string);
        if (!cancelled) setDetail(d);
      } catch (err) {
        console.error('Failed to load sponsor detail', err);
        if (!cancelled) notify('Failed to load sponsor detail', 'error');
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const openCreate = () => {
    setForm(emptyForm);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!form.businessName.trim()) {
      notify('Business name is required', 'error');
      return;
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      notify('Invalid email format', 'error');
      return;
    }
    if (form.discountType === 'PERCENTAGE') {
      const pct = Number(form.discountPercent);
      if (!(pct > 0 && pct <= 100)) {
        notify('Discount percent must be > 0 and <= 100', 'error');
        return;
      }
    } else {
      const cents = Math.round(Number(form.discountFixedAmountCents));
      if (!(cents > 0)) {
        notify('Fixed discount must be > $0', 'error');
        return;
      }
    }
    if (!(Number(form.initialBudgetCents) >= 0)) {
      notify('Initial budget must be >= $0', 'error');
      return;
    }
    setSaving(true);
    try {
      await createSponsor({
        businessName: form.businessName,
        businessType: form.businessType,
        businessDescription: form.businessDescription || undefined,
        managerName: form.managerName || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        address: form.address || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        postalCode: form.postalCode || undefined,
        country: form.country || undefined,
        discountType: form.discountType,
        discountPercent: form.discountType === 'PERCENTAGE' ? Number(form.discountPercent) : undefined,
        maxDiscountPercent: form.discountType === 'PERCENTAGE' ? Number(form.maxDiscountPercent) : undefined,
        discountFixedAmountCents: form.discountType === 'FIXED_AMOUNT' ? Math.round(Number(form.discountFixedAmountCents)) : undefined,
        initialBudgetCents: Math.round(Number(form.initialBudgetCents)),
        specialsEnabled: true,
      });
      notify('Sponsor created');
      setCreateOpen(false);
      fetchData();
    } catch (err: unknown) {
      notify(errMsg(err, 'Failed to create sponsor'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (sponsor: { id: string }, status: string) => {
    try {
      await setSponsorStatus(sponsor.id, status);
      notify(`Sponsor ${status === 'SUSPENDED' ? 'suspended' : 'activated'}`);
      fetchData();
      if (selected?.id === sponsor.id) loadDetail(sponsor.id);
    } catch (err: unknown) {
      notify(errMsg(err, 'Status change failed'), 'error');
    }
  };

  const handleAdjust = async () => {
    const cents = Math.round(Number(adjustForm.amountCents));
    if (!(cents > 0)) {
      notify('Amount must be > $0', 'error');
      return;
    }
    if (!adjustForm.reason.trim()) {
      notify('Reason is required', 'error');
      return;
    }
    try {
      await adjustSponsorBudget(selected.id, cents, adjustForm.reason.trim(), adjustForm.direction);
      notify(adjustForm.direction === 'CREDIT' ? 'Budget credited' : 'Budget debited');
      setAdjustOpen(false);
      setAdjustForm({ direction: 'CREDIT', amountCents: '', reason: '' });
      fetchData();
      loadDetail(selected.id);
    } catch (err: unknown) {
      notify(errMsg(err, 'Budget adjustment failed'), 'error');
    }
  };

  const handlePortalCreate = async () => {
    if (!portalForm.email.includes('@')) {
      notify('A valid email is required', 'error');
      return;
    }
    try {
      const res = await createSponsorPortalAccount(selected.id, portalForm.email.trim());
      setNewPassword(res?.temporaryPassword ?? res?.password ?? null);
      notify('Portal account created — share the password with the sponsor');
      setPortalForm({ email: '' });
      loadDetail(selected.id);
    } catch (err: unknown) {
      notify(errMsg(err, 'Portal account creation failed'), 'error');
    }
  };

  const handlePortalReset = async () => {
    try {
      const res = await resetSponsorPortalPassword(selected.id);
      setNewPassword(res?.temporaryPassword ?? res?.password ?? null);
      notify('Password reset — share the new password with the sponsor');
      loadDetail(selected.id);
    } catch (err: unknown) {
      notify(errMsg(err, 'Password reset failed'), 'error');
    }
  };

  const handlePortalDisable = async () => {
    try {
      await disableSponsorPortalAccount(selected.id);
      notify('Portal account disabled');
      loadDetail(selected.id);
    } catch (err: unknown) {
      notify(errMsg(err, 'Disable failed'), 'error');
    }
  };

  const openEdit = () => {
    if (!sponsor) return;
    setEditForm({
      businessName: sponsor.business_name ?? '',
      businessType: sponsor.business_type ?? 'RESTAURANT',
      businessDescription: sponsor.business_description ?? '',
      managerName: sponsor.manager_name ?? '',
      phone: sponsor.phone ?? '',
      email: sponsor.email ?? '',
      address: sponsor.address ?? '',
      city: sponsor.city ?? '',
      state: sponsor.state ?? '',
      postalCode: sponsor.postal_code ?? '',
      country: sponsor.country ?? '',
      discountType: sponsor.discount_type ?? 'PERCENTAGE',
      discountPercent: String(sponsor.discount_percent ?? 25),
      maxDiscountPercent: String(sponsor.max_discount_percent ?? 25),
      discountFixedAmountCents: String(sponsor.discount_fixed_amount_cents ?? 500),
      initialBudgetCents: String(sponsor.initial_budget_cents ?? 0),
      specialsEnabled: sponsor.specials_enabled ?? true,
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!selected) return;
    if (!editForm.businessName.trim()) {
      notify('Business name is required', 'error');
      return;
    }
    if (editForm.discountType === 'PERCENTAGE') {
      const pct = Number(editForm.discountPercent);
      if (!(pct > 0 && pct <= 100)) {
        notify('Discount percent must be > 0 and <= 100', 'error');
        return;
      }
      const maxPct = Number(editForm.maxDiscountPercent);
      if (!(maxPct > 0 && maxPct <= 100)) {
        notify('Max discount percent must be > 0 and <= 100', 'error');
        return;
      }
    } else {
      const cents = Math.round(Number(editForm.discountFixedAmountCents));
      if (!(cents > 0)) {
        notify('Fixed discount must be > $0', 'error');
        return;
      }
    }
    setEditSaving(true);
    try {
      await updateSponsor(selected.id as string, {
        businessName: editForm.businessName,
        businessType: editForm.businessType,
        businessDescription: editForm.businessDescription || undefined,
        managerName: editForm.managerName || undefined,
        phone: editForm.phone || undefined,
        email: editForm.email || undefined,
        address: editForm.address || undefined,
        city: editForm.city || undefined,
        state: editForm.state || undefined,
        postalCode: editForm.postalCode || undefined,
        country: editForm.country || undefined,
        discountType: editForm.discountType,
        discountPercent: editForm.discountType === 'PERCENTAGE' ? Number(editForm.discountPercent) : undefined,
        maxDiscountPercent: editForm.discountType === 'PERCENTAGE' ? Number(editForm.maxDiscountPercent) : undefined,
        discountFixedAmountCents: editForm.discountType === 'FIXED_AMOUNT' ? Math.round(Number(editForm.discountFixedAmountCents)) : undefined,
      });
      notify('Sponsor updated');
      setEditOpen(false);
      fetchData();
      loadDetail(selected.id as string);
    } catch (err: unknown) {
      notify(errMsg(err, 'Failed to update sponsor'), 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const runAction = async (action: () => Promise<void>) => {
    try {
      await action();
      fetchData();
    } catch (err: unknown) {
      notify(errMsg(err, 'Action failed'), 'error');
    }
  };

  const sponsor = detail?.sponsor;
  const analytics = detail?.analytics;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
            Sponsors
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {total} business that fund rider SPECIALS. Budgets reserve → settle → deplete.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
          New Sponsor
        </Button>
      </Box>

      <Paper sx={{ p: 2, mb: 3, borderRadius: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField
            size="small"
            placeholder="Search sponsors…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: { xs: '100%', sm: 280 } }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
              ),
            }}
          />
          <TextField
            size="small"
            select
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            sx={{ width: { xs: '100%', sm: 180 } }}
            slotProps={{ select: { native: true } }}
          >
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="DEPLETED">Depleted</option>
            <option value="SUSPENDED">Suspended</option>
          </TextField>
        </Stack>
      </Paper>

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4 } }}>
              <TableCell>Business</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Discount</TableCell>
              <TableCell>Remaining</TableCell>
              <TableCell>Reserved</TableCell>
              <TableCell>Used</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 6 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : sponsors.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                  No sponsors yet. Click “New Sponsor” to fund your first SPECIALS.
                </TableCell>
              </TableRow>
            ) : (
              sponsors.map((s) => {
                const sc = statusColors[s.status] ?? { bg: '#EEEEEE', fg: '#666' };
                return (
                  <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelected(s)}>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Box sx={{ width: 36, height: 36, borderRadius: 2, bgcolor: 'primary.light', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                          <StorefrontIcon sx={{ fontSize: 20 }} />
                        </Box>
                        <Box>
                          <Typography variant="body2" sx={{ fontWeight: 700 }}>{s.business_name}</Typography>
                          <Typography variant="caption" color="text.secondary">{s.city ?? '—'}</Typography>
                        </Box>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>{String(s.business_type ?? 'OTHER').toLowerCase()}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={s.discountLabel ?? '—'} sx={{ bgcolor: '#EDEDFF', color: '#4F46E5', fontWeight: 700 }} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{fmtUSD(s.remaining_budget_cents)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">{fmtUSD(s.reserved_budget_cents)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">{fmtUSD(s.used_budget_cents)}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={s.status} sx={{ bgcolor: sc.bg, color: sc.fg, fontWeight: 700, fontSize: 11 }} />
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {s.status === 'ACTIVE' ? (
                          <Tooltip title="Suspend sponsor (SPECIALS hidden, redemptions blocked)">
                            <Button size="small" color="error" onClick={() => handleStatusChange(s, 'SUSPENDED')}>Suspend</Button>
                          </Tooltip>
                        ) : s.status === 'SUSPENDED' ? (
                          <Button size="small" color="success" onClick={() => handleStatusChange(s, 'ACTIVE')}>Activate</Button>
                        ) : (
                          <Button size="small" onClick={() => handleStatusChange(s, 'ACTIVE')}>Activate</Button>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {/* Create dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>New Sponsor</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Business name *" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} fullWidth />
            <TextField
              label="Business type"
              select
              value={form.businessType}
              onChange={(e) => setForm({ ...form, businessType: e.target.value })}
              fullWidth
              slotProps={{ select: { native: true } }}
            >
              {['RESTAURANT', 'CAFE', 'RETAIL', 'BAR', 'SERVICES', 'MEDICAL', 'AUTO', 'OTHER'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </TextField>
            <TextField label="Description" value={form.businessDescription} onChange={(e) => setForm({ ...form, businessDescription: e.target.value })} fullWidth multiline minRows={2} />
            <Grid container spacing={2}>
              <Grid item xs={6}><TextField label="Manager name" value={form.managerName} onChange={(e) => setForm({ ...form, managerName: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} fullWidth /></Grid>
              <Grid item xs={12}><TextField label="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} fullWidth /></Grid>
            </Grid>
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Discount</Typography>
            <TextField
              label="Discount type"
              select
              value={form.discountType}
              onChange={(e) => setForm({ ...form, discountType: e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT' })}
              fullWidth
              slotProps={{ select: { native: true } }}
            >
              <option value="PERCENTAGE">Percentage off</option>
              <option value="FIXED_AMOUNT">Fixed amount off</option>
            </TextField>
            {form.discountType === 'PERCENTAGE' ? (
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <TextField
                    label="Discount % (of fare)"
                    type="number"
                    value={form.discountPercent}
                    onChange={(e) => setForm({ ...form, discountPercent: e.target.value })}
                    fullWidth
                    InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                  />
                </Grid>
                <Grid item xs={6}>
                  <TextField
                    label="Max % of fare"
                    type="number"
                    value={form.maxDiscountPercent}
                    onChange={(e) => setForm({ ...form, maxDiscountPercent: e.target.value })}
                    fullWidth
                    InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                  />
                </Grid>
              </Grid>
            ) : (
              <TextField
                label="Fixed discount (cents)"
                type="number"
                value={form.discountFixedAmountCents}
                onChange={(e) => setForm({ ...form, discountFixedAmountCents: e.target.value })}
                fullWidth
              />
            )}
            <TextField
              label="Initial funding budget (cents)"
              type="number"
              value={form.initialBudgetCents}
              onChange={(e) => setForm({ ...form, initialBudgetCents: e.target.value })}
              fullWidth
              helperText="BIGINT cents — e.g. 100000 = $1,000. Credits the sponsor ledger + remaining budget."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={saving} onClick={handleCreate}>
            {saving ? 'Creating…' : 'Create Sponsor'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detail drawer */}
      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)} sx={{ '& .MuiDrawer-paper': { width: { xs: '100%', sm: 720 } } }}>
        {selected && (
          <Box sx={{ p: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'primary.main', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white' }}>
                  <StorefrontIcon />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 800 }}>{selected.business_name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {detail?.sponsor?.spendableCents !== undefined ? `${fmtUSD(detail.sponsor.spendableCents)} spendable` : ''}
                  </Typography>
                </Box>
              </Box>
              <IconButton onClick={() => setSelected(null)}><CloseIcon /></IconButton>
            </Box>

            {detailLoading || !sponsor ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>
            ) : (
              <>
                <Tabs value={detailTab} onChange={(_, v) => setDetailTab(v)} sx={{ mb: 2 }}>
                  <Tab label="Overview" />
                  <Tab label="Ledger" />
                  <Tab label="Settlements" />
                  <Tab label="Analytics" />
                  <Tab label="Portal Account" />
                </Tabs>

                {detailTab === 0 && (
                  <Stack spacing={2}>
                    <Grid container spacing={2}>
                      <Grid item xs={6} sm={3}>
                        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                          <Typography variant="caption" color="text.secondary">Remaining</Typography>
                          <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD(sponsor.remaining_budget_cents)}</Typography>
                        </Paper>
                      </Grid>
                      <Grid item xs={6} sm={3}>
                        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                          <Typography variant="caption" color="text.secondary">Reserved</Typography>
                          <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD(sponsor.reserved_budget_cents)}</Typography>
                        </Paper>
                      </Grid>
                      <Grid item xs={6} sm={3}>
                        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                          <Typography variant="caption" color="text.secondary">Used</Typography>
                          <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD(sponsor.used_budget_cents)}</Typography>
                        </Paper>
                      </Grid>
                      <Grid item xs={6} sm={3}>
                        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                          <Typography variant="caption" color="text.secondary">Status</Typography>
                          <Chip size="small" label={sponsor.status} sx={{ mt: 1, bgcolor: (statusColors[sponsor.status] ?? { bg: '#EEE' }).bg, color: (statusColors[sponsor.status] ?? { fg: '#666' }).fg, fontWeight: 700 }} />
                        </Paper>
                      </Grid>
                    </Grid>

                    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>Discount</Typography>
                      <Typography variant="body2">
                        {sponsor.discount_type === 'PERCENTAGE'
                          ? `${sponsor.discount_percent}% of fare (capped at ${sponsor.max_discount_percent}%)`
                          : `${fmtUSD(sponsor.discount_fixed_amount_cents)} off the fare`}
                        {' — '}{sponsor.discountLabel}
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                        <Button size="small" variant="contained" onClick={openEdit}>
                          Edit Sponsor
                        </Button>
                        <Button size="small" variant="contained" startIcon={<AccountBalanceWalletIcon />} onClick={() => { setAdjustForm({ direction: 'CREDIT', amountCents: '', reason: '' }); setAdjustOpen(true); }}>
                          Adjust Budget
                        </Button>
                      </Stack>
                    </Paper>

                    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1 }}>Contact</Typography>
                      <Typography variant="body2">{sponsor.manager_name ?? '—'} · {sponsor.phone ?? '—'} · {sponsor.email ?? '—'}</Typography>
                      <Typography variant="body2" color="text.secondary">{sponsor.address ?? ''}{sponsor.city ? `, ${sponsor.city}` : ''}{sponsor.state ? `, ${sponsor.state}` : ''}</Typography>
                    </Paper>
                  </Stack>
                )}

                {detailTab === 1 && (
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 11, textTransform: 'uppercase' } }}>
                          <TableCell>When</TableCell>
                          <TableCell>Type</TableCell>
                          <TableCell>Direction</TableCell>
                          <TableCell align="right">Amount</TableCell>
                          <TableCell align="right">Balance</TableCell>
                          <TableCell>Reason</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(detail?.ledger ?? []).map((e: { id: string; created_at: string; type: string; direction: string; amount_cents: number | null; balance_after_cents: number | null; reason: string }) => (
                          <TableRow key={e.id}>
                            <TableCell sx={{ fontSize: 12 }}>{fmtDateTime(e.created_at)}</TableCell>
                            <TableCell><Chip size="small" label={e.type} sx={{ fontSize: 10, fontWeight: 700 }} /></TableCell>
                            <TableCell>
                              <Chip size="small" label={e.direction} sx={{ bgcolor: e.direction === 'CREDIT' ? '#E5F0EB' : '#FCE9E9', color: e.direction === 'CREDIT' ? '#2E7D32' : '#C65A5A', fontSize: 10, fontWeight: 700 }} />
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 12, fontWeight: 700 }}>
                              {e.direction === 'CREDIT' ? '+' : '−'}{fmtUSD(e.amount_cents)}
                            </TableCell>
                            <TableCell align="right" sx={{ fontSize: 12 }}>{fmtUSD(e.balance_after_cents)}</TableCell>
                            <TableCell sx={{ fontSize: 12 }}>{e.reason}</TableCell>
                          </TableRow>
                        ))}
                        {(detail?.ledger ?? []).length === 0 && (
                          <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>No ledger entries yet</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}

                {detailTab === 2 && (
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3 }}>
                    <Table size="small">
                      <TableHead>
                        <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 11, textTransform: 'uppercase' } }}>
                          <TableCell>When</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Reward</TableCell>
                          <TableCell align="right">Funded</TableCell>
                          <TableCell align="right">Driver 60%</TableCell>
                          <TableCell align="right">NetRide 40%</TableCell>
                          <TableCell align="right">Bonus (credits)</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(detail?.financialHistory ?? []).map((r: { id: string; created_at: string; status: string; reward_choice: string | null; sponsor_funded_cents: number | null; driver_allocation_cents: number | null; netride_allocation_cents: number | null; netride_bonus_cents: number | null }) => (
                          <TableRow key={r.id}>
                            <TableCell sx={{ fontSize: 12 }}>{fmtDateTime(r.created_at)}</TableCell>
                            <TableCell>
                              <Chip size="small" label={r.status} sx={{ fontSize: 10, fontWeight: 700, bgcolor: (redemptionStatusColors[r.status] ?? { bg: '#EEE' }).bg, color: (redemptionStatusColors[r.status] ?? { fg: '#666' }).fg }} />
                            </TableCell>
                            <TableCell sx={{ fontSize: 12 }}>{r.reward_choice ?? '—'}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 12, fontWeight: 700 }}>{fmtUSD(r.sponsor_funded_cents)}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 12 }}>{fmtUSD(r.driver_allocation_cents)}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 12 }}>{fmtUSD(r.netride_allocation_cents)}</TableCell>
                            <TableCell align="right" sx={{ fontSize: 12 }}>{fmtUSD(r.netride_bonus_cents)}</TableCell>
                          </TableRow>
                        ))}
                        {(detail?.financialHistory ?? []).length === 0 && (
                          <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No settled redemptions yet</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </TableContainer>
                )}

                {detailTab === 3 && analytics && (
                  <Grid container spacing={2}>
                    {[
                      { label: 'Total redemptions', value: String(analytics.totalRedemptions ?? 0) },
                      { label: 'Rewarded', value: String(analytics.rewardedRedemptions ?? 0) },
                      { label: 'Cancelled / expired', value: String(analytics.cancelledRedemptions ?? 0) },
                      { label: 'Unique riders', value: String(analytics.uniqueRiderCount ?? 0) },
                      { label: 'Sponsor funded', value: fmtUSD(analytics.totalSponsorFundedCents) },
                      { label: 'Driver allocation (60%)', value: fmtUSD(analytics.totalDriverAllocationCents) },
                      { label: 'NetRide allocation (40%)', value: fmtUSD(analytics.totalNetrideAllocationCents) },
                      { label: 'Rider rewards paid', value: fmtUSD(analytics.totalRewardAmountCents) },
                    ].map((m) => (
                      <Grid item xs={6} sm={3} key={m.label}>
                        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                          <Typography variant="caption" color="text.secondary">{m.label}</Typography>
                          <Typography variant="h6" sx={{ fontWeight: 800 }}>{m.value}</Typography>
                        </Paper>
                      </Grid>
                    ))}
                  </Grid>
                )}

                {detailTab === 4 && (
                  <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                    {detail?.portalAccount ? (
                      <Stack spacing={1.5}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Portal login</Typography>
                        <Typography variant="body2">Email: <b>{detail.portalAccount.email}</b></Typography>
                        <Typography variant="body2">
                          Status:{' '}
                          <Chip size="small" label={detail.portalAccount.isActive ? 'ACTIVE' : 'DISABLED'} sx={{ fontSize: 10, fontWeight: 700, bgcolor: detail.portalAccount.isActive ? '#E5F0EB' : '#FCE9E9', color: detail.portalAccount.isActive ? '#2E7D32' : '#C65A5A' }} />
                          {detail.portalAccount.mustChangePassword && <Chip size="small" label="MUST CHANGE PASSWORD" sx={{ fontSize: 10, fontWeight: 700, ml: 1, bgcolor: '#FFF4E5', color: '#B26A00' }} />}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">Last login: {fmtDateTime(detail.portalAccount.lastLoginAt)}</Typography>
                        <Stack direction="row" spacing={1}>
                          <Button size="small" variant="contained" onClick={() => runAction(handlePortalReset)}>Reset password</Button>
                          {detail.portalAccount.isActive && (
                            <Button size="small" color="error" onClick={() => runAction(handlePortalDisable)}>Disable login</Button>
                          )}
                        </Stack>
                      </Stack>
                    ) : (
                      <Stack spacing={2}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>No portal account yet</Typography>
                        <Typography variant="body2" color="text.secondary">
                          Create a login so the sponsor can validate rider codes and manage their SPECIALS from the NetRide Sponsor portal.
                        </Typography>
                        <Stack direction="row" spacing={1}>
                          <TextField
                            size="small"
                            placeholder="sponsor@business.com"
                            value={portalForm.email}
                            onChange={(e) => setPortalForm({ email: e.target.value })}
                            sx={{ width: 300 }}
                          />
                          <Button size="small" variant="contained" onClick={handlePortalCreate}>Create account</Button>
                        </Stack>
                      </Stack>
                    )}
                  </Paper>
                )}
              </>
            )}
          </Box>
        )}
      </Drawer>

      {/* Budget adjust dialog */}
      <Dialog open={adjustOpen} onClose={() => setAdjustOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Adjust budget — {selected?.business_name ?? ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Direction"
              select
              value={adjustForm.direction}
              onChange={(e) => setAdjustForm({ ...adjustForm, direction: e.target.value as 'CREDIT' | 'DEBIT' })}
              fullWidth
              slotProps={{ select: { native: true } }}
            >
              <option value="CREDIT">Credit (add funds)</option>
              <option value="DEBIT">Debit (remove funds)</option>
            </TextField>
            <TextField
              label="Amount (cents)"
              type="number"
              value={adjustForm.amountCents}
              onChange={(e) => setAdjustForm({ ...adjustForm, amountCents: e.target.value })}
              fullWidth
              helperText="e.g. 50000 = $500"
            />
            <TextField
              label="Reason *"
              value={adjustForm.reason}
              onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
              fullWidth
              multiline
              minRows={2}
              helperText="A reason is required — written to the audit ledger."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdjustOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleAdjust}>Apply</Button>
        </DialogActions>
      </Dialog>

      {/* One-time password reveal */}
      <Dialog open={!!newPassword} onClose={() => setNewPassword(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Share this password now</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This password is shown once. The sponsor must change it at first login. Never stored in plaintext.
          </Typography>
          <Paper variant="outlined" sx={{ p: 3, bgcolor: 'primary.light', borderRadius: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 800, textAlign: 'center', letterSpacing: 1, color: 'white' }}>
              {newPassword}
            </Typography>
          </Paper>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewPassword(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Edit sponsor dialog */}
      <Dialog open={editOpen} onClose={() => !editSaving && setEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Edit Sponsor</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField label="Business name *" value={editForm.businessName} onChange={(e) => setEditForm({ ...editForm, businessName: e.target.value })} fullWidth />
            <TextField
              label="Business type"
              select
              value={editForm.businessType}
              onChange={(e) => setEditForm({ ...editForm, businessType: e.target.value })}
              fullWidth
              slotProps={{ select: { native: true } }}
            >
              {['RESTAURANT', 'CAFE', 'RETAIL', 'BAR', 'SERVICES', 'MEDICAL', 'AUTO', 'OTHER'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </TextField>
            <TextField label="Description" value={editForm.businessDescription} onChange={(e) => setEditForm({ ...editForm, businessDescription: e.target.value })} fullWidth multiline minRows={2} />
            <Grid container spacing={2}>
              <Grid item xs={6}><TextField label="Manager name" value={editForm.managerName} onChange={(e) => setEditForm({ ...editForm, managerName: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="Phone" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="Email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="City" value={editForm.city} onChange={(e) => setEditForm({ ...editForm, city: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="State" value={editForm.state} onChange={(e) => setEditForm({ ...editForm, state: e.target.value })} fullWidth /></Grid>
              <Grid item xs={6}><TextField label="Postal code" value={editForm.postalCode} onChange={(e) => setEditForm({ ...editForm, postalCode: e.target.value })} fullWidth /></Grid>
              <Grid item xs={12}><TextField label="Address" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} fullWidth /></Grid>
              <Grid item xs={12}><TextField label="Country" value={editForm.country} onChange={(e) => setEditForm({ ...editForm, country: e.target.value })} fullWidth /></Grid>
            </Grid>
            <Divider sx={{ my: 1 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Discount</Typography>
            <TextField
              label="Discount type"
              select
              value={editForm.discountType}
              onChange={(e) => setEditForm({ ...editForm, discountType: e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT' })}
              fullWidth
              slotProps={{ select: { native: true } }}
            >
              <option value="PERCENTAGE">Percentage off</option>
              <option value="FIXED_AMOUNT">Fixed amount off</option>
            </TextField>
            {editForm.discountType === 'PERCENTAGE' ? (
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <TextField
                    label="Discount % (of fare)"
                    type="number"
                    value={editForm.discountPercent}
                    onChange={(e) => setEditForm({ ...editForm, discountPercent: e.target.value })}
                    fullWidth
                    InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                  />
                </Grid>
                <Grid item xs={6}>
                  <TextField
                    label="Max % of fare"
                    type="number"
                    value={editForm.maxDiscountPercent}
                    onChange={(e) => setEditForm({ ...editForm, maxDiscountPercent: e.target.value })}
                    fullWidth
                    InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                  />
                </Grid>
              </Grid>
            ) : (
              <TextField
                label="Fixed discount (cents)"
                type="number"
                value={editForm.discountFixedAmountCents}
                onChange={(e) => setEditForm({ ...editForm, discountFixedAmountCents: e.target.value })}
                fullWidth
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={editSaving}>Cancel</Button>
          <Button variant="contained" disabled={editSaving} onClick={handleEdit}>
            {editSaving ? 'Saving…' : 'Save Changes'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack({ ...snack, open: false })}>{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Sponsors;