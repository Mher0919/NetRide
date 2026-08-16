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

const Customers: React.FC = () => {
  const [rows, setRows] = React.useState<CustomerRow[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    (async () => {
      try {
        const d = await listPortalCustomers(100);
        setRows((d?.customers ?? []) as CustomerRow[]);
      } catch (err) {
        console.error('Failed to load customers', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>Customers</Typography>
        <Typography variant="body2" color="text.secondary">Riders who have completed SPECIALS visits at your business.</Typography>
      </Box>

      <TableContainer component={Paper} sx={{ borderRadius: 3 }}>
        <Table>
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, fontSize: 11, textTransform: 'uppercase', color: 'text.secondary' } }}>
              <TableCell>Rider</TableCell>
              <TableCell align="center">Visits</TableCell>
              <TableCell align="center">Rewarded</TableCell>
              <TableCell align="right">Discounts funded</TableCell>
              <TableCell align="right">Rewards paid</TableCell>
              <TableCell>Last visit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6 }}><CircularProgress size={28} /></TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary' }}>No customers yet. Once riders redeem your SPECIALS, they appear here.</TableCell></TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.riderId} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{c.riderName}</Typography>
                    <Typography variant="caption" color="text.secondary">{c.riderId?.slice(0, 8)}</Typography>
                  </TableCell>
                  <TableCell align="center">{c.visits}</TableCell>
                  <TableCell align="center">{c.rewardedVisits}</TableCell>
                  <TableCell align="right">{fmtUSD(c.totalDiscountCents)}</TableCell>
                  <TableCell align="right">{fmtUSD(c.totalRewardCents)}</TableCell>
                  <TableCell sx={{ fontSize: 13 }}>{fmtDateTime(c.lastVisitAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};

export default Customers;