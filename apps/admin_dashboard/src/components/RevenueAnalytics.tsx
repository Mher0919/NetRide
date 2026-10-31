import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Card,
  Button,
  Chip,
  CircularProgress,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  MenuItem,
  Snackbar,
  Alert,
  Stack,
} from '@mui/material';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { getRevenueAnalytics, getRegions, upsertRegion } from '../api/admin';
import { format } from '../utils/date';

const fmtUSD = (cents: any) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;

const BUCKETS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
] as const;

const RevenueAnalytics: React.FC<{ testMode?: boolean }> = ({ testMode = false }) => {
  const [range, setRange] = useState<'7d' | '30d' | '90d' | 'all'>('30d');
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('day');
  const [region, setRegion] = useState('');
  const [data, setData] = useState<any>(null);
  const [regions, setRegions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = React.useRef(0);
  const [regionOpen, setRegionOpen] = useState(false);
  const [regionForm, setRegionForm] = useState({
    code: '', name: '', country_code: 'US',
    center_lat: '', center_lng: '', radius_km: '25',
  });
  const [savingRegion, setSavingRegion] = useState(false);
  const [snack, setSnack] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false, message: '', severity: 'success',
  });

  const scope = testMode ? 'test' : 'production';

  const fetchData = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const [analytics, regionList] = await Promise.all([
        getRevenueAnalytics({ range, bucket, scope, ...(region ? { region } : {}) }),
        getRegions(),
      ]);
      // Ignore responses belonging to a previous scope/range selection (the
      // admin may toggled Test rides while a request was in flight).
      if (seq !== requestSeq.current) return;
      setData(analytics);
      setRegions(regionList.regions ?? []);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      const msg = err?.response?.data?.error || err?.message || 'Failed to load analytics';
      setError(msg);
      console.error('Failed to load analytics:', err);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [range, bucket, region, scope]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // The API echoes the scope it computed; only data for the currently
  // selected mode may render (a production series must never appear under
  // the TEST DATA indicator while the test response is in flight).
  const currentData = data && data.scope === scope ? data : null;

  const saveRegion = async () => {
    setSavingRegion(true);
    try {
      await upsertRegion({
        ...regionForm,
        code: regionForm.code.trim(),
        center_lat: Number(regionForm.center_lat),
        center_lng: Number(regionForm.center_lng),
        radius_km: Number(regionForm.radius_km),
      });
      setSnack({ open: true, message: 'Region saved.', severity: 'success' });
      setRegionOpen(false);
      setRegionForm({ code: '', name: '', country_code: 'US', center_lat: '', center_lng: '', radius_km: '25' });
      const regionList = await getRegions();
      setRegions(regionList.regions ?? []);
    } catch (err: any) {
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to save region', severity: 'error' });
    } finally {
      setSavingRegion(false);
    }
  };

  const chartData = (currentData?.series ?? []).map((s: any) => ({
    label:
      bucket === 'day'
        ? format(new Date(s.bucket), 'MMM d')
        : bucket === 'month'
          ? format(new Date(s.bucket), 'MMM yy')
          : format(new Date(s.bucket), "'Wk of' MMM d"),
    platform: Number(s.platformCents ?? 0) / 100,
    driver: Number(s.driverCents ?? 0) / 100,
  }));

  const totals = currentData?.totals;

  return (
    <Paper sx={{ mt: 3, p: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
            Revenue analytics <Typography component="span" variant="caption" color="text.secondary">— settled rides from the financial ledger</Typography>
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.25 }}>
            {currentData && (
              <Typography variant="caption" color="text.secondary">
                Buckets are UTC · {currentData.dataSource} · {currentData.scope === 'test' ? 'test rides only' : 'production rides only'}
              </Typography>
            )}
            {testMode && (
              <Chip
                size="small"
                label="TEST DATA"
                sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: '#FFF4E5', color: '#B26A00' }}
              />
            )}
          </Stack>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
          <TextField
            select
            size="small"
            label="Range"
            value={range}
            onChange={(e) => setRange(e.target.value as any)}
            sx={{ minWidth: 110, '& .MuiInputBase-root': { borderRadius: 2, fontSize: '0.8rem' } }}
          >
            {RANGES.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
          </TextField>
          <TextField
            select
            size="small"
            label="Bucket"
            value={bucket}
            onChange={(e) => setBucket(e.target.value as any)}
            sx={{ minWidth: 110, '& .MuiInputBase-root': { borderRadius: 2, fontSize: '0.8rem' } }}
          >
            {BUCKETS.map((b) => <MenuItem key={b.value} value={b.value}>{b.label}</MenuItem>)}
          </TextField>
          <TextField
            select
            size="small"
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            sx={{ minWidth: 140, '& .MuiInputBase-root': { borderRadius: 2, fontSize: '0.8rem' } }}
          >
            <MenuItem value="">All regions</MenuItem>
            {regions.map((r) => <MenuItem key={r.code} value={r.code}>{r.name} ({r.code})</MenuItem>)}
          </TextField>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setRegionOpen(true)}
            sx={{ borderRadius: '8px', fontWeight: 700, fontSize: '0.7rem' }}
          >
            Manage regions
          </Button>
        </Box>
      </Box>

      {loading && !currentData ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <Typography variant="h6" color="error" gutterBottom>Unable to load analytics</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{error}</Typography>
          <Button variant="outlined" size="small" onClick={fetchData}>Retry</Button>
        </Box>
      ) : currentData ? (
        <>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 3 }}>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>{range === 'all' ? 'All-time' : `${range}`} rides</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }}>{totals?.rides ?? 0}</Typography>
            </Card>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>Gross</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }}>{fmtUSD(totals?.grossCents)}</Typography>
            </Card>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>Platform</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, color: '#C79A4A' }}>{fmtUSD(totals?.platformCents)}</Typography>
            </Card>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>Driver + tips</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, color: '#5B7760' }}>{fmtUSD((totals?.driverCents ?? 0) + (totals?.tipCents ?? 0))}</Typography>
            </Card>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>Avg fare / ride</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5 }}>{fmtUSD(totals?.avgFarePerRideCents)}</Typography>
            </Card>
            <Card sx={{ flex: 1, minWidth: 150, p: 2.5, borderRadius: 3, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', fontSize: '0.62rem' }}>Avg platform / ride</Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, mt: 0.5, color: '#C79A4A' }}>{fmtUSD(totals?.avgPlatformPerRideCents)}</Typography>
            </Card>
          </Box>

          {chartData.length > 0 ? (
            <Box sx={{ height: 260, mt: 3 }}>
              {/* Explicit numeric height: avoids Recharts' first-paint
                  “width(-1) and height(-1)” measurement warning. */}
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: any, name: any) => ['$' + Number(v).toFixed(2), name === 'platform' ? 'Platform' : 'Driver + tips']} />
                  <Bar dataKey="platform" fill="#C79A4A" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="driver" fill="#5B7760" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          ) : (
            <Typography variant="body2" color="text.disabled" sx={{ mt: 3, textAlign: 'center', py: 3 }}>
              No settled {testMode ? 'test' : 'production'} rides in this range.
            </Typography>
          )}

          <Box sx={{ mt: 3 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1.5 }}>
              Regions <Typography component="span" variant="caption" color="text.secondary">— geofence-based ride attribution (pickup inside the circle)</Typography>
            </Typography>
            <TableContainer component={Box} sx={{ border: '1px solid rgba(0,0,0,0.06)', borderRadius: 2 }}>
              <Table size="small">
                <TableHead sx={{ bgcolor: '#f8f9fa' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Code</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Name</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Center</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Radius</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {regions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.disabled' }}>
                        No regions defined yet — add one to filter analytics by market.
                      </TableCell>
                    </TableRow>
                  )}
                  {regions.map((r: any) => (
                    <TableRow key={r.code} hover>
                      <TableCell sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{r.code}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{r.name}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{Number(r.center_lat).toFixed(4)}, {Number(r.center_lng).toFixed(4)}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{r.radius_km} km</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{r.is_active ? 'Active' : 'Inactive'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        </>
      ) : null}

      <Dialog open={regionOpen} onClose={() => setRegionOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontWeight: 800 }}>Add region</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField size="small" label="Code" value={regionForm.code} onChange={(e) => setRegionForm({ ...regionForm, code: e.target.value })} helperText="Uppercase letters, numbers, _ or -" />
            <TextField size="small" label="Name" value={regionForm.name} onChange={(e) => setRegionForm({ ...regionForm, name: e.target.value })} />
            <TextField size="small" label="Country code" value={regionForm.country_code} onChange={(e) => setRegionForm({ ...regionForm, country_code: e.target.value })} />
            <TextField size="small" label="Center latitude" value={regionForm.center_lat} onChange={(e) => setRegionForm({ ...regionForm, center_lat: e.target.value })} />
            <TextField size="small" label="Center longitude" value={regionForm.center_lng} onChange={(e) => setRegionForm({ ...regionForm, center_lng: e.target.value })} />
            <TextField size="small" label="Radius (km)" value={regionForm.radius_km} onChange={(e) => setRegionForm({ ...regionForm, radius_km: e.target.value })} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRegionOpen(false)} sx={{ borderRadius: 8 }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveRegion}
            disabled={savingRegion || !regionForm.code.trim() || !regionForm.name.trim() || !regionForm.center_lat || !regionForm.center_lng}
            sx={{ borderRadius: 8, fontWeight: 700 }}
          >
            {savingRegion ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })}>
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack({ ...snack, open: false })}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Paper>
  );
};

export default RevenueAnalytics;