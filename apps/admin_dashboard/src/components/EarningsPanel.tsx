import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Chip,
  Button,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
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
import { getDriverEarnings } from '../api/admin';
import { format } from '../utils/date';

const fmtUSD = (cents: any) => '$' + (Number(cents ?? 0) / 100).toFixed(2);

interface EarningsPanelProps {
  userId: string;
}

const PERIODS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
] as const;

const EarningsPanel: React.FC<EarningsPanelProps> = ({ userId }) => {
  const [data, setData] = useState<any>(null);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('week');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getDriverEarnings(userId, {
        range: '90d',
        period,
        page: page + 1,
        limit: pageSize,
      });
      setData(result);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to load earnings';
      setError(msg);
      console.error('Failed to load earnings:', err);
    } finally {
      setLoading(false);
    }
  }, [userId, period, page, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const chartData = (data?.series ?? []).map((s: any) => ({
    label:
      period === 'day'
        ? format(new Date(s.bucket), 'MMM d')
        : period === 'month'
          ? format(new Date(s.bucket), 'MMM yy')
          : format(new Date(s.bucket), "'Wk of' MMM d"),
    earnings: Number(s.earningsCents ?? 0) / 100,
    tip: Number(s.tipCents ?? 0) / 100,
  }));

  return (
    <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 800 }}>
            Earnings <Typography component="span" variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>— settled rides only, from the financial ledger</Typography>
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          {PERIODS.map((p) => (
            <Button
              key={p.value}
              size="small"
              variant={period === p.value ? 'contained' : 'outlined'}
              onClick={() => { setPeriod(p.value); setPage(0); }}
              sx={{ borderRadius: '8px', fontWeight: 700, fontSize: '0.7rem' }}
            >
              {p.label}
            </Button>
          ))}
        </Box>
      </Box>

      {loading && !data ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={36} />
        </Box>
      ) : error ? (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <Typography variant="h6" color="error" gutterBottom>Unable to load earnings</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{error}</Typography>
          <Button variant="outlined" size="small" onClick={fetchData}>Retry</Button>
        </Box>
      ) : data ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            <Box sx={{ flex: 1, minWidth: 140, bgcolor: '#f8f9fa', borderRadius: 2, px: 2.5, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.62rem' }}>Lifetime</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD((data.lifetime?.earningsCents ?? 0) + (data.lifetime?.afterTripTipCents ?? 0))}</Typography>
              <Typography variant="caption" color="text.secondary">{data.lifetime?.rides ?? 0} rides settled</Typography>
            </Box>
            <Box sx={{ flex: 1, minWidth: 140, bgcolor: '#f8f9fa', borderRadius: 2, px: 2.5, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.62rem' }}>Tips</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD(data.lifetime?.tipCents ?? 0)}</Typography>
              <Typography variant="caption" color="text.secondary">+ {fmtUSD(data.lifetime?.afterTripTipCents ?? 0)} after-trip</Typography>
            </Box>
            <Box sx={{ flex: 1, minWidth: 140, bgcolor: '#f8f9fa', borderRadius: 2, px: 2.5, py: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.62rem' }}>Last 90 days</Typography>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>{fmtUSD((data.series ?? []).reduce((acc: number, s: any) => acc + Number(s.earningsCents ?? 0) + Number(s.tipCents ?? 0), 0))}</Typography>
              <Typography variant="caption" color="text.secondary">{data.rides?.total ?? 0} rides this range</Typography>
            </Box>
          </Box>

          {chartData.length > 0 ? (
            <Box sx={{ height: 220, width: '100%', minWidth: 0 }}>
              {/* Explicit numeric height: avoids Recharts' first-paint
                  “width(-1) and height(-1)” measurement warning. */}
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: any, name: any) => ['$' + Number(v).toFixed(2), name === 'earnings' ? 'Earnings' : 'Tips']} />
                  <Bar dataKey="earnings" fill="#2e7d32" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="tip" fill="#c79a4a" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          ) : (
            <Typography variant="body2" color="text.disabled" sx={{ textAlign: 'center', py: 3 }}>
              No settled earnings in the last 90 days.
            </Typography>
          )}

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1.5 }}>
              Completed rides <Typography component="span" variant="caption" color="text.secondary">({data.rides?.total ?? 0})</Typography>
            </Typography>
            <TableContainer component={Box} sx={{ border: '1px solid rgba(0,0,0,0.06)', borderRadius: 2 }}>
              <Table size="small">
                <TableHead sx={{ bgcolor: '#f8f9fa' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Ride</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Completed</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Fare</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Driver share</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Tip</TableCell>
                    <TableCell sx={{ fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', color: 'text.secondary' }}>Settlement</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(data.rides?.rows ?? []).map((r: any) => (
                    <TableRow key={r.id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                      <TableCell sx={{ fontSize: '0.75rem', fontWeight: 700 }}>#{String(r.id).slice(0, 8)}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{format(new Date(r.completed_at), 'MMM d, HH:mm')}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{fmtUSD(r.fare_cents)}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem', fontWeight: 700 }}>{fmtUSD(r.driver_share_cents)}</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{fmtUSD(r.tip_cents)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={r.status} sx={{ height: 20, fontSize: '0.6rem', fontWeight: 700, bgcolor: 'rgba(46,125,50,0.12)', color: 'success.main' }} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {(data.rides?.rows ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.disabled' }}>
                        No settled rides yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            {data.rides?.total > 0 && (
              <TablePagination
                rowsPerPageOptions={[10, 25, 50]}
                component="div"
                count={data.rides?.total ?? 0}
                rowsPerPage={pageSize}
                page={page}
                onPageChange={(_e, p) => setPage(p)}
                onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
              />
            )}
          </Box>
        </Box>
      ) : null}
    </Paper>
  );
};

export default EarningsPanel;