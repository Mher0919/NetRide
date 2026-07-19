import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Stack,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import BackIcon from '@mui/icons-material/ArrowBack';
import { Button } from '@mui/material';
import { getFlaggedRatings } from '../api/admin';

const FlaggedRatings: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [ratings, setRatings] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getFlaggedRatings({ page, limit: 20 });
      setRatings(data.ratings ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error('Failed to load flagged ratings', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto' }}>
      <Box sx={{ mb: 4 }}>
        <Button
          startIcon={<BackIcon />}
          onClick={() => navigate(-1)}
          variant="outlined"
          sx={{ borderRadius: '10px', mb: 2 }}
        >
          Back
        </Button>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Flagged Ride Reviews
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Rides where a rider left fewer than 3 stars with a note. Total flagged: {total}.
        </Typography>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress thickness={5} size={50} />
        </Box>
      ) : ratings.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center', borderRadius: 4 }}>
          <Typography variant="body1" color="text.secondary" fontWeight={600}>
            No flagged reviews yet.
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper} sx={{ borderRadius: 4 }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>When</TableCell>
                <TableCell>Rider</TableCell>
                <TableCell>Driver</TableCell>
                <TableCell align="right">Stars</TableCell>
                <TableCell>Note</TableCell>
                <TableCell>Trip</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ratings.map((r: any) => (
                <TableRow key={r.id} hover>
                  <TableCell>
                    {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>{r.rider_name}</Typography>
                    <Typography variant="caption" color="text.secondary">{r.rider_email}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>{r.driver_name}</Typography>
                    <Typography variant="caption" color="text.secondary">{r.driver_email}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      label={`${r.rating} ★`}
                      size="small"
                      color={r.rating <= 1 ? 'error' : 'warning'}
                      sx={{ fontWeight: 800 }}
                    />
                  </TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>
                    <Typography variant="body2">{r.review_text || '—'}</Typography>
                  </TableCell>
                  <TableCell>
                    <Typography
                      component="span"
                      sx={{ fontFamily: 'monospace', fontSize: 12, color: 'primary.main', fontWeight: 600 }}
                    >
                      {String(r.ride_id).slice(0, 8)}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {total > 20 && (
        <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 3 }}>
          <Button
            variant="outlined"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outlined"
            disabled={page * 20 >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </Stack>
      )}
    </Box>
  );
};

export default FlaggedRatings;
