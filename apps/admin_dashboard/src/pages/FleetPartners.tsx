import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Snackbar,
  Alert,
  InputAdornment,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import PowerIcon from '@mui/icons-material/PowerSettingsNew';
import GroupsIcon from '@mui/icons-material/Groups';
import SearchIcon from '@mui/icons-material/Search';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import {
  listFleets,
  createFleet,
  updateFleet,
  assignDriverFleet,
  getUsers,
  createFleetPortalAccount,
  resetFleetPortalPassword,
  disableFleetPortalAccount,
} from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const emptyForm = {
  name: '',
  platform_share_percent: '20',
  contact_name: '',
  contact_email: '',
  notes: '',
};

const FleetPartners: React.FC = () => {
  const [fleets, setFleets] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<any>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState(emptyForm);

  const [assignTarget, setAssignTarget] = React.useState<any>(null);
  const [driverSearch, setDriverSearch] = React.useState('');
  const [drivers, setDrivers] = React.useState<any[]>([]);
  const [driverLoading, setDriverLoading] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);

  const [portalTarget, setPortalTarget] = React.useState<any>(null);
  const [portalEmail, setPortalEmail] = React.useState('');
  const [portalResult, setPortalResult] = React.useState<{ email: string; temporaryPassword: string } | null>(null);
  const [portalLoading, setPortalLoading] = React.useState(false);

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await listFleets();
      setFleets(data?.fleets ?? []);
    } catch (err) {
      console.error('Failed to fetch fleets', err);
      setFleets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const openCreate = () => {
    setForm(emptyForm);
    setEditTarget(null);
    setCreateOpen(true);
  };

  const openEdit = (f: any) => {
    setEditTarget(f);
    setForm({
      name: f.name,
      platform_share_percent: String(f.platform_share_percent ?? 20),
      contact_name: f.contact_name ?? '',
      contact_email: f.contact_email ?? '',
      notes: f.notes ?? '',
    });
    setCreateOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      platform_share_percent: Number(form.platform_share_percent) || 0,
      contact_name: form.contact_name.trim() || null,
      contact_email: form.contact_email.trim() || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (editTarget) {
        await updateFleet(editTarget.id, payload);
        setSnack({ open: true, message: 'Fleet updated', severity: 'success' });
      } else {
        await createFleet(payload);
        setSnack({ open: true, message: 'Fleet created', severity: 'success' });
      }
      setCreateOpen(false);
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to save fleet', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (f: any) => {
    try {
      await updateFleet(f.id, { is_active: !f.is_active });
      setSnack({ open: true, message: f.is_active ? 'Fleet deactivated' : 'Fleet activated', severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to update fleet', severity: 'error' });
    }
  };

  const openAssign = (f: any) => {
    setAssignTarget(f);
    setDriverSearch('');
    setDrivers([]);
  };

  const searchDrivers = React.useCallback(async () => {
    setDriverLoading(true);
    try {
      const data = await getUsers({ role: 'DRIVER', search: driverSearch, page: 1, limit: 20 });
      setDrivers(data?.users ?? []);
    } catch (err) {
      console.error('Failed to search drivers', err);
      setDrivers([]);
    } finally {
      setDriverLoading(false);
    }
  }, [driverSearch]);

  React.useEffect(() => {
    if (!assignTarget) return;
    const id = window.setTimeout(searchDrivers, 300);
    return () => window.clearTimeout(id);
  }, [assignTarget, searchDrivers]);

  const handleAssign = async (driver: any) => {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      await assignDriverFleet(driver.id, assignTarget.id);
      setSnack({ open: true, message: `${driver.full_name} assigned to ${assignTarget.name}`, severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to assign driver', severity: 'error' });
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async (driver: any) => {
    if (!assignTarget) return;
    setAssigning(true);
    try {
      await assignDriverFleet(driver.id, null);
      setSnack({ open: true, message: `${driver.full_name} unassigned from fleet`, severity: 'success' });
      searchDrivers();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to unassign driver', severity: 'error' });
    } finally {
      setAssigning(false);
    }
  };

  const openPortal = (f: any) => {
    setPortalTarget(f);
    setPortalEmail(f.contact_email ?? '');
    setPortalResult(null);
  };

  const handleCreatePortal = async () => {
    if (!portalTarget || !portalEmail.trim()) return;
    setPortalLoading(true);
    try {
      const result = await createFleetPortalAccount(portalTarget.id, portalEmail.trim());
      setPortalResult(result);
      setSnack({ open: true, message: 'Fleet portal account created', severity: 'success' });
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to create portal account', severity: 'error' });
    } finally {
      setPortalLoading(false);
    }
  };

  const handleResetPortalPassword = async () => {
    if (!portalTarget) return;
    setPortalLoading(true);
    try {
      const result = await resetFleetPortalPassword(portalTarget.id);
      setPortalResult({ email: '', temporaryPassword: result.temporaryPassword });
      setSnack({ open: true, message: 'Fleet portal password reset', severity: 'success' });
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to reset password', severity: 'error' });
    } finally {
      setPortalLoading(false);
    }
  };

  const handleDisablePortal = async () => {
    if (!portalTarget) return;
    setPortalLoading(true);
    try {
      await disableFleetPortalAccount(portalTarget.id);
      setPortalResult(null);
      setSnack({ open: true, message: 'Fleet portal account disabled', severity: 'success' });
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to disable portal account', severity: 'error' });
    } finally {
      setPortalLoading(false);
    }
  };

  return (
    <Box sx={{ p: { xs: 0, sm: 3 } }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Fleet Partners
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Fleet operators earn a configured share of the 40% platform pool. Driver share stays 60%.
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={openCreate}
          sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none', fontWeight: 700 }}
        >
          New Fleet
        </Button>
      </Stack>

      <Paper sx={{ mt: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                <TableCell>Fleet</TableCell>
                <TableCell>Platform pool share</TableCell>
                <TableCell>Drivers</TableCell>
                <TableCell>Fleet earnings</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 5 }}>
                    <CircularProgress size={28} />
                  </TableCell>
                </TableRow>
              )}
              {!loading && fleets.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No fleet partners yet — create one to start paying fleet shares.
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                fleets.map((f) => (
                  <TableRow key={f.id} hover>
                    <TableCell>
                      <Typography sx={{ fontWeight: 700 }}>{f.name}</Typography>
                      {(f.contact_name || f.contact_email) && (
                        <Typography variant="caption" color="text.secondary">
                          {f.contact_name ?? ''}{f.contact_name && f.contact_email ? ' · ' : ''}{f.contact_email ?? ''}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={`${Number(f.platform_share_percent ?? 0).toFixed(0)}% of pool`}
                        sx={{ bgcolor: '#E5F0EB', color: '#5B7760', fontWeight: 700 }}
                      />
                    </TableCell>
                    <TableCell>{f.driver_count ?? 0}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{fmtUSD(Number(f.fleet_earnings_cents) || 0)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={f.is_active ? 'Active' : 'Disabled'}
                        sx={{
                          bgcolor: f.is_active ? '#E5F0EB' : '#FCE9E9',
                          color: f.is_active ? '#5B7760' : '#C65A5A',
                          fontWeight: 700,
                        }}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <IconButton size="small" title="Portal account" onClick={() => openPortal(f)}>
                          <VpnKeyIcon fontSize="small" sx={{ color: '#5B7760' }} />
                        </IconButton>
                        <IconButton size="small" title="Assign drivers" onClick={() => openAssign(f)}>
                          <PersonAddIcon fontSize="small" />
                        </IconButton>
                        <IconButton size="small" title={f.is_active ? 'Deactivate' : 'Activate'} onClick={() => handleToggleActive(f)}>
                          <PowerIcon fontSize="small" sx={{ color: f.is_active ? '#5B7760' : '#999999' }} />
                        </IconButton>
                        <IconButton size="small" title="Edit" onClick={() => openEdit(f)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Create/edit dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editTarget ? `Edit ${editTarget.name}` : 'New Fleet Partner'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label="Fleet name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <TextField
              label="Platform pool share (%)"
              type="number"
              value={form.platform_share_percent}
              onChange={(e) => setForm({ ...form, platform_share_percent: e.target.value })}
              InputProps={{ endAdornment: <InputAdornment position="end">% of NetRide's 40%</InputAdornment> }}
              helperText="Example: 20% → fleet gets 20% of the 40% platform pool (8% of the fare); NetRide keeps the rest."
            />
            <Stack direction="row" spacing={2}>
              <TextField
                label="Contact name"
                value={form.contact_name}
                onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                fullWidth
              />
              <TextField
                label="Contact email"
                value={form.contact_email}
                onChange={(e) => setForm({ ...form, contact_email: e.target.value })}
                fullWidth
              />
            </Stack>
            <TextField
              label="Notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || !form.name.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Assign drivers dialog */}
      <Dialog open={!!assignTarget} onClose={() => setAssignTarget(null)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <GroupsIcon fontSize="small" /> Assign drivers · {assignTarget?.name}
        </DialogTitle>
        <DialogContent>
          <TextField
            size="small"
            placeholder="Search drivers by name or email…"
            value={driverSearch}
            onChange={(e) => setDriverSearch(e.target.value)}
            fullWidth
            sx={{ mb: 2 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          {driverLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress size={26} />
            </Box>
          )}
          {!driverLoading && drivers.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
              No drivers found.
            </Typography>
          )}
          {!driverLoading &&
            drivers.map((d) => {
              const driverFleet = d.driver_profile?.fleet_id ?? null;
              return (
                <Paper key={d.id} sx={{ p: 1.5, mb: 1, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)' }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{d.full_name}</Typography>
                      <Typography variant="caption" color="text.secondary">{d.email}</Typography>
                    </Box>
                    <Button
                      size="small"
                      variant={driverFleet === assignTarget?.id ? 'outlined' : 'contained'}
                      disabled={assigning}
                      onClick={() =>
                        driverFleet === assignTarget?.id ? handleUnassign(d) : handleAssign(d)
                      }
                      sx={
                        driverFleet === assignTarget?.id
                          ? { textTransform: 'none', color: '#C65A5A', borderColor: '#C65A5A' }
                          : { textTransform: 'none', backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' } }
                      }
                    >
                      {driverFleet === assignTarget?.id
                        ? 'Unassign'
                        : driverFleet
                          ? 'Move to this fleet'
                          : 'Assign'}
                    </Button>
                  </Stack>
                </Paper>
              );
            })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAssignTarget(null)} sx={{ textTransform: 'none' }}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Portal account dialog */}
      <Dialog open={!!portalTarget} onClose={() => setPortalTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Fleet Portal Account · {portalTarget?.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="body2" color="text.secondary">
              The fleet logs into the NetRide Partner Portal to track its earnings. A temporary
              password is generated below — the fleet must change it on first login.
            </Typography>
            {!portalResult ? (
              <>
                <TextField
                  label="Portal login email"
                  value={portalEmail}
                  onChange={(e) => setPortalEmail(e.target.value)}
                  fullWidth
                  placeholder="fleet@example.com"
                />
                <Button
                  variant="contained"
                  onClick={handleCreatePortal}
                  disabled={portalLoading || !portalEmail.trim()}
                  sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
                >
                  {portalLoading ? <CircularProgress size={20} color="inherit" /> : 'Create account'}
                </Button>
              </>
            ) : (
              <Alert severity="info" variant="outlined">
                <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>Temporary password</Typography>
                <Typography
                  sx={{ fontFamily: 'monospace', fontSize: '1.15rem', fontWeight: 800, my: 1, userSelect: 'all' }}
                >
                  {portalResult.temporaryPassword}
                </Typography>
                <Typography variant="caption">
                  {portalResult.email ? `Login: ${portalResult.email}` : 'Password reset — share it with the fleet operator.'}
                  {' '}They will be required to change it on first login.
                </Typography>
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            color="error"
            disabled={portalLoading}
            onClick={handleDisablePortal}
            sx={{ textTransform: 'none', mr: 'auto' }}
          >
            Disable account
          </Button>
          {portalResult && (
            <Button
              size="small"
              disabled={portalLoading}
              onClick={handleResetPortalPassword}
              sx={{ textTransform: 'none' }}
            >
              Reset password
            </Button>
          )}
          <Button onClick={() => setPortalTarget(null)} sx={{ textTransform: 'none' }}>Close</Button>
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

export default FleetPartners;
