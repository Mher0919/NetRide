import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  InputAdornment,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Tabs,
  Tab,
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
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import { listCreditAccounts, grantCredits, listCreditTransactions, exportCreditTransactions, downloadBlob } from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const typeMeta: Record<string, { label: string; color: string }> = {
  REFERRAL_REWARD: { label: 'Referral reward', color: '#5B7760' },
  ADMIN_GRANT: { label: 'Admin grant', color: '#2F3A32' },
  RIDE_APPLIED: { label: 'Applied to ride', color: '#C79A4A' },
  RIDE_REFUND: { label: 'Ride refund', color: '#6E8B74' },
  ADJUSTMENT: { label: 'Adjustment', color: '#888888' },
};

const Credits: React.FC = () => {
  const [tab, setTab] = React.useState(0);
  const [accounts, setAccounts] = React.useState<any[]>([]);
  const [transactions, setTransactions] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const [grantOpen, setGrantOpen] = React.useState(false);
  const [grantTarget, setGrantTarget] = React.useState<any>(null);
  const [grantAmount, setGrantAmount] = React.useState('');
  const [grantReason, setGrantReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 0) {
        const data = await listCreditAccounts({ search });
        setAccounts(data?.accounts ?? []);
      } else {
        const data = await listCreditTransactions({ userId: tab === 1 ? search : undefined });
        setTransactions(data?.transactions ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch credits', err);
      setSnack({ open: true, message: 'Failed to load credit data', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  React.useEffect(() => {
    const id = window.setTimeout(fetchData, 250);
    return () => window.clearTimeout(id);
  }, [fetchData]);

  const openGrant = (account: any) => {
    setGrantTarget(account);
    setGrantAmount('');
    setGrantReason('');
    setGrantOpen(true);
  };

  const handleGrant = async () => {
    const cents = Math.round((Number(grantAmount) || 0) * 100);
    if (!grantTarget || cents <= 0 || !grantReason.trim()) return;
    setSaving(true);
    try {
      await grantCredits(grantTarget.user_id, cents, grantReason.trim());
      setGrantOpen(false);
      setSnack({ open: true, message: `${fmtUSD(cents)} granted to ${grantTarget.full_name ?? 'rider'}`, severity: 'success' });
      fetchData();
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to grant credits', severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    try {
      const blob = await exportCreditTransactions();
      downloadBlob(blob, 'credit-ledger.csv');
    } catch {
      setSnack({ open: true, message: 'Export failed', severity: 'error' });
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
            Ride Credits
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Rider credit balances, grants and the full transaction ledger.
          </Typography>
        </Box>
        <Button startIcon={<FileDownloadIcon />} onClick={handleExport} sx={{ textTransform: 'none' }}>
          Export ledger CSV
        </Button>
      </Stack>

      <Paper sx={{ mt: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <Box sx={{ px: 2, pt: 1 }}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ '& .MuiTab-root': { textTransform: 'none', fontWeight: 700 } }}>
            <Tab label="Accounts" />
            <Tab label="Transactions" />
          </Tabs>
        </Box>

        <Stack direction="row" gap={1} px={2} py={2} flexWrap="wrap">
          <TextField
            size="small"
            placeholder={tab === 0 ? 'Search name, email, phone…' : 'Filter by user ID…'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ width: 300 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
        </Stack>

        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                {tab === 0 ? (
                  <>
                    <TableCell>Rider</TableCell>
                    <TableCell align="right">Balance</TableCell>
                    <TableCell align="right">Lifetime earned</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>User</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell>Created</TableCell>
                  </>
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 5 }}>
                    <CircularProgress size={28} />
                  </TableCell>
                </TableRow>
              )}
              {!loading && tab === 0 && accounts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No riders found
                  </TableCell>
                </TableRow>
              )}
              {!loading && tab === 1 && transactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No transactions found
                  </TableCell>
                </TableRow>
              )}
              {!loading && tab === 0 && accounts.map((a) => (
                <TableRow key={a.user_id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{a.full_name ?? '—'}</Typography>
                    <Typography variant="caption" color="text.secondary">{a.email}</Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, fontSize: 15 }}>
                    {fmtUSD(a.balance_cents)}
                  </TableCell>
                  <TableCell align="right">{fmtUSD(a.lifetime_earned_cents)}</TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      onClick={() => openGrant(a)}
                      sx={{ color: '#5B7760', textTransform: 'none', fontWeight: 700 }}
                    >
                      Grant
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && tab === 1 && transactions.map((t) => {
                const meta = typeMeta[t.type] ?? { label: t.type, color: '#888888' };
                const positive = Number(t.amount_cents) >= 0;
                return (
                  <TableRow key={t.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.user_name ?? '—'}</Typography>
                      <Typography variant="caption" color="text.secondary">{t.user_email}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={meta.label} sx={{ bgcolor: `${meta.color}1A`, color: meta.color, fontWeight: 700 }} />
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: positive ? '#5B7760' : '#C65A5A' }}>
                      {positive ? '+' : ''}{fmtUSD(t.amount_cents)}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{t.description ?? '—'}</Typography>
                      <Typography variant="caption" color="text.secondary">balance after: {fmtUSD(t.balance_after_cents)}</Typography>
                    </TableCell>
                    <TableCell>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Grant dialog */}
      <Dialog open={grantOpen} onClose={() => setGrantOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Grant ride credits</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="body2" color="text.secondary">
              {grantTarget?.full_name ?? 'Rider'} — current balance {fmtUSD(grantTarget?.balance_cents)}
            </Typography>
            <TextField
              autoFocus
              label="Amount ($)"
              type="number"
              value={grantAmount}
              onChange={(e) => setGrantAmount(e.target.value)}
              InputProps={{ inputProps: { min: 0.01, step: 0.01 } }}
            />
            <TextField
              label="Reason"
              placeholder="e.g. Complaint resolution, promo override…"
              value={grantReason}
              onChange={(e) => setGrantReason(e.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGrantOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleGrant}
            disabled={saving || Number(grantAmount) <= 0 || !grantReason.trim()}
            sx={{ backgroundColor: '#5B7760', '&:hover': { backgroundColor: '#4A6352' }, textTransform: 'none' }}
          >
            {saving ? <CircularProgress size={20} color="inherit" /> : 'Grant credits'}
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

export default Credits;
