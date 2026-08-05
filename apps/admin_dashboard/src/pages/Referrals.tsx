import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  InputAdornment,
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
  Stack,
  Snackbar,
  Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import WarningIcon from '@mui/icons-material/WarningAmber';
import { getReferralStats, listReferrals, listReferralAbuse, getRewardLedger } from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const statusMeta: Record<string, { label: string; color: string }> = {
  QR_SCANNED: { label: 'QR scanned', color: '#C79A4A' },
  LINKED: { label: 'Linked', color: '#5B7760' },
  FIRST_RIDE_PENDING: { label: 'First ride pending', color: '#5B7760' },
  FIRST_RIDE_COMPLETED: { label: 'First ride completed', color: '#2F3A32' },
  REWARD_GRANTED: { label: 'Rewarded', color: '#6E8B74' },
};

const Referrals: React.FC = () => {
  const [tab, setTab] = React.useState(0);
  const [stats, setStats] = React.useState<any>(null);
  const [relationships, setRelationships] = React.useState<any[]>([]);
  const [flags, setFlags] = React.useState<any[]>([]);
  const [ledger, setLedger] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [search, setSearch] = React.useState('');

  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const s = await getReferralStats();
      setStats(s);
      if (tab === 0) {
        const r = await listReferrals({ status: statusFilter, search });
        setRelationships(r?.relationships ?? []);
      } else if (tab === 1) {
        const f = await listReferralAbuse();
        setFlags(f?.flags ?? []);
      } else {
        const l = await getRewardLedger();
        setLedger(l?.transactions ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch referrals', err);
      setSnack({ open: true, message: 'Failed to load referral data', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, [tab, statusFilter, search]);

  React.useEffect(() => {
    const id = window.setTimeout(fetchData, 250);
    return () => window.clearTimeout(id);
  }, [fetchData]);

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
        Referrals
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Referral relationships, rewards ledger and fraud flags.
      </Typography>

      <Stack direction="row" gap={1.5} mt={3} flexWrap="wrap">
        {[
          ['Relationships', stats?.relationships_total ?? '—'],
          ['Pending first ride', stats?.pending_first_ride ?? '—'],
          ['First ride completed', stats?.first_ride_completed ?? '—'],
          ['Rewards granted', stats?.rewarded ?? '—'],
          ['Total rewards', fmtUSD(stats?.total_reward_cents)],
          ['Active referrers', stats?.active_referrers ?? '—'],
          ['Avg / referrer', stats?.avg_per_referrer ?? '—'],
        ].map(([label, value]) => (
          <Paper
            key={label}
            sx={{ flex: '1 1 130px', p: 1.5, borderRadius: 3, bgcolor: '#F7F4EF', border: '1px solid rgba(0,0,0,0.06)' }}
          >
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            <Typography variant="subtitle2" sx={{ fontWeight: 800, fontSize: 17 }}>{value}</Typography>
          </Paper>
        ))}
      </Stack>

      <Paper sx={{ mt: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
        <Box sx={{ px: 2, pt: 1 }}>
          <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ '& .MuiTab-root': { textTransform: 'none', fontWeight: 700 } }}>
            <Tab label="Relationships" />
            <Tab label="Abuse flags" icon={<WarningIcon />} iconPosition="start" />
            <Tab label="Reward ledger" />
          </Tabs>
        </Box>

        {(tab === 0 || tab === 1) && (
          <Stack direction="row" gap={1} px={2} py={2} flexWrap="wrap">
            <TextField
              size="small"
              placeholder={tab === 0 ? 'Search names / emails…' : 'Search flagged…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ width: 300 }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            />
            {tab === 0 && (
              <TextField
                select
                size="small"
                label="Status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                sx={{ width: 200 }}
                slotProps={{ select: { native: true } }}
              >
                <option value="">All</option>
                {Object.entries(statusMeta).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </TextField>
            )}
          </Stack>
        )}

        <TableContainer>
          <Table>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                {tab === 0 && (
                  <>
                    <TableCell>Referrer</TableCell>
                    <TableCell>Referred</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Scanned</TableCell>
                    <TableCell>First ride</TableCell>
                    <TableCell align="right">Reward</TableCell>
                  </>
                )}
                {tab === 1 && (
                  <>
                    <TableCell>Referred</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Rides (cancelled / total)</TableCell>
                    <TableCell>Flags</TableCell>
                  </>
                )}
                {tab === 2 && (
                  <>
                    <TableCell>User</TableCell>
                    <TableCell>Side</TableCell>
                    <TableCell>Relation</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Created</TableCell>
                  </>
                )}
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
              {!loading && tab === 0 && relationships.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No relationships found
                  </TableCell>
                </TableRow>
              )}
              {!loading && tab === 1 && flags.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No abuse flags — all clean
                  </TableCell>
                </TableRow>
              )}
              {!loading && tab === 2 && ledger.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                    No rewards granted yet
                  </TableCell>
                </TableRow>
              )}

              {!loading && tab === 0 && relationships.map((r) => {
                const meta = statusMeta[r.status] ?? { label: r.status, color: '#888888' };
                return (
                  <TableRow key={r.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.referrer_name ?? '—'}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.referrer_email}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.referred_name ?? '—'}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.referred_email}</Typography>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={meta.label} sx={{ bgcolor: `${meta.color}1A`, color: meta.color, fontWeight: 700 }} />
                    </TableCell>
                    <TableCell>{r.scanned_at ? new Date(r.scanned_at).toLocaleDateString() : '—'}</TableCell>
                    <TableCell>{r.first_ride_completed_at ? new Date(r.first_ride_completed_at).toLocaleDateString() : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: '#5B7760' }}>
                      {r.amount_cents ? fmtUSD(r.amount_cents) : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}

              {!loading && tab === 1 && flags.map((f) => (
                <TableRow key={f.relationship_id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{f.referred_name ?? '—'}</Typography>
                    <Typography variant="caption" color="text.secondary">{f.referred_email}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={statusMeta[f.status]?.label ?? f.status}
                      sx={{ bgcolor: '#FCE9E9', color: '#C65A5A', fontWeight: 700 }}
                    />
                  </TableCell>
                  <TableCell>
                    {f.ride_completed} completed · {f.ride_cancelled} cancelled of {f.ride_total} total
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {(f.flags ?? []).map((flag: string) => (
                        <Chip
                          key={flag}
                          size="small"
                          label={flag.replace(/_/g, ' ')}
                          sx={{ bgcolor: '#FCE9E9', color: '#C65A5A', fontWeight: 600 }}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}

              {!loading && tab === 2 && ledger.map((t) => (
                <TableRow key={t.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.user_name ?? '—'}</Typography>
                    <Typography variant="caption" color="text.secondary">{t.user_email}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={t.referrer_id ? 'Referrer' : 'Referred'}
                      sx={{ bgcolor: t.referrer_id ? '#E5F0EB' : '#F7F4EF', color: '#5B7760', fontWeight: 700 }}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {t.referrer_name ?? t.referred_name}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700, color: '#5B7760' }}>
                    {t.amount_cents ? `+${fmtUSD(t.amount_cents)}` : '—'}
                  </TableCell>
                  <TableCell>{t.created_at ? new Date(t.created_at).toLocaleString() : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })}>
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack({ ...snack, open: false })}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Referrals;
