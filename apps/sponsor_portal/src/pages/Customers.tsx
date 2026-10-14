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
  Alert,
  Button,
} from '@mui/material';
import { listPortalCustomers } from '../api/sponsor';

const fmtUSD = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : '—');

export type CustomerRow = {
  riderId?: string;
  riderName?: string;
  visits?: number;
  rewardedVisits?: number;
  totalDiscountCents?: number;
  totalRewardCents?: number;
  lastVisitAt?: string;
};

const numCellSx = { fontVariantNumeric: 'tabular-nums' } as const;

const Customers: React.FC = () => {
  const [rows, setRows] = React.useState<CustomerRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await listPortalCustomers(100);
      setRows((d?.customers ?? []) as CustomerRow[]);
    } catch (err) {
      console.error('Failed to load customers', err);
      setLoadError('We could not load customers. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4">Customers</Typography>
        <Typography variant="body2" color="text.secondary">
          Riders who have completed SPECIALS visits at your business.
        </Typography>
      </Box>

      {loadError && !loading && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" size="small" onClick={() => load()}>
              Retry
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      <TableContainer component={Paper} sx={{ borderRadius: '16px', maxHeight: 600 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>Rider</TableCell>
              <TableCell align="right">Visits</TableCell>
              <TableCell align="right">Rewarded</TableCell>
              <TableCell align="right">Discounts funded</TableCell>
              <TableCell align="right">Rewards paid</TableCell>
              <TableCell>Last visit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6 }}><CircularProgress size={28} /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                {loadError ? 'Customers could not be loaded.' : 'No customers yet. Once riders redeem your SPECIALS, they appear here.'}
              </TableCell></TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.riderId} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{c.riderName}</Typography>
                    <Typography variant="caption" color="text.secondary">{c.riderId?.slice(0, 8)}</Typography>
                  </TableCell>
                  <TableCell align="right" sx={numCellSx}>{c.visits}</TableCell>
                  <TableCell align="right" sx={numCellSx}>{c.rewardedVisits}</TableCell>
                  <TableCell align="right" sx={numCellSx}>{fmtUSD(c.totalDiscountCents)}</TableCell>
                  <TableCell align="right" sx={numCellSx}>{fmtUSD(c.totalRewardCents)}</TableCell>
                  <TableCell sx={{ fontSize: 13, whiteSpace: 'nowrap' }}>{fmtDateTime(c.lastVisitAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {!loading && rows.length >= 100 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Showing the most recent 100 customers.
        </Typography>
      )}
    </Box>
  );
};

export default Customers;