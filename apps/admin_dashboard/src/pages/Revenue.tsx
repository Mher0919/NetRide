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
  Stack,
  Snackbar,
  Alert,
  LinearProgress,
  Card,
} from '@mui/material';
import { getRevenueOverview } from '../api/admin';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const Revenue: React.FC = () => {
  const [overview, setOverview] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const fetchData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRevenueOverview();
      setOverview(data);
    } catch (err: any) {
      console.error('Failed to fetch revenue overview', err);
      setSnack({ open: true, message: err?.response?.data?.error || 'Failed to load revenue overview', severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const config = overview?.revenue_config;
  const global = overview?.global;
  const perFleet = overview?.per_fleet ?? [];

  const statCard = (title: string, value: string, color: string, sub?: string) => (
    <Card sx={{ p: 2.5, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em', mt: 0.5, color }}>
        {value}
      </Typography>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Card>
  );

  return (
    <Box sx={{ p: 3 }}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
          Revenue Overview
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Every completed ride records a cent-exact split: final fare = driver share + fleet shares + NetRide share.
        </Typography>
      </Box>

      {loading && !overview && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      )}

      {overview && (
        <>
          {/* Global split */}
          <Paper sx={{ mt: 3, p: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
              <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
                Global revenue split
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Configured via the revenue_configs table (single row, must sum to 100)
              </Typography>
            </Stack>
            <Stack direction="row" spacing={3} sx={{ mt: 2 }} alignItems="center" flexWrap="wrap">
              <Box sx={{ flex: 1, minWidth: 220 }}>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="body2" sx={{ fontWeight: 700, color: '#5B7760' }}>
                    Drivers {Number(config?.driverSharePercent ?? 0).toFixed(0)}%
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 700, color: '#2F3A32' }}>
                    Platform {Number(config?.platformSharePercent ?? 0).toFixed(0)}%
                  </Typography>
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={Number(config?.driverSharePercent ?? 60)}
                  sx={{ mt: 1, height: 10, borderRadius: 5, '& .MuiLinearProgress-bar': { backgroundColor: '#5B7760' } }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  The platform pool is split between fleet partners (assigned share) and NetRide.
                </Typography>
              </Box>
            </Stack>
          </Paper>

          {/* Global totals */}
          <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            {statCard('Total fare', fmtUSD(global?.total_fare_cents), '#2F3A32')}
            {statCard('Driver earnings (60%)', fmtUSD(global?.total_driver_share_cents), '#5B7760')}
            {statCard('Platform pool', fmtUSD(global?.total_platform_share_cents), '#C79A4A')}
            {statCard('NetRide share', fmtUSD(global?.total_netride_share_cents), '#2F3A32')}
            {statCard('Rides with allocation', String(global?.rides_with_allocation ?? 0), '#5B7760')}
          </Stack>

          {/* Per-fleet breakdown */}
          <Paper sx={{ mt: 3, borderRadius: 4, border: '1px solid rgba(0,0,0,0.06)', boxShadow: 'none', overflow: 'hidden' }}>
            <Box sx={{ px: 3, py: 2, borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>Fleet partner earnings</Typography>
            </Box>
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: '#FAFAFA' } }}>
                    <TableCell>Fleet</TableCell>
                    <TableCell>Rides</TableCell>
                    <TableCell align="right">Fleet earnings</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {perFleet.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                        No fleet-allocated rides yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {perFleet.map((f: any) => (
                    <TableRow key={f.fleet_id} hover>
                      <TableCell sx={{ fontWeight: 700 }}>{f.fleet_name ?? 'Unknown'}</TableCell>
                      <TableCell>{f.rides ?? 0}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700, color: '#5B7760' }}>
                        {fmtUSD(Number(f.fleet_earnings_cents) || 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </>
      )}

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })}>
        <Alert severity={snack.severity} variant="filled" onClose={() => setSnack({ ...snack, open: false })}>
          {snack.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Revenue;
