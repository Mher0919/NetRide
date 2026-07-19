import React, { useEffect, useState, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  CircularProgress,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
  Avatar,
  Tooltip,
  TextField,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import FaceRetouchingNaturalIcon from '@mui/icons-material/FaceRetouchingNatural';
import { format } from 'date-fns';
import {
  getFlaggedFaceChecks,
  reviewFaceCheck,
} from '../api/admin';

const REASON_LABELS: Record<string, string> = {
  face_mismatch: 'Face did not match',
  liveness_failed: 'Liveness check failed',
  quality_failed: 'Photo quality too low',
  no_face_in_selfie: 'No face detected',
  service_error: 'Service unavailable',
  enrolled: 'Enrollment',
  match: 'Match',
};

const FaceChecks: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [notes, setNotes] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFlaggedFaceChecks();
      setEvents(data?.events ?? []);
    } catch (err) {
      console.error('Failed to fetch face checks', err);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = window.setInterval(fetchData, 30_000);
    return () => window.clearInterval(id);
  }, [fetchData]);

  const openReview = (event: any) => {
    setSelected(event);
    setDecision(null);
    setNotes('');
  };

  const selfieSrc = (e: any) => e?.captured_clip_url || e?.selfie_url || null;
  const fmtScore = (s: any) =>
    s == null ? '—' : (typeof s === 'number' ? s : Number(s)).toFixed(3);

  const handleDecision = async (dec: 'APPROVED' | 'REJECTED') => {
    if (!selected) return;
    setActionLoading(true);
    try {
      await reviewFaceCheck(selected.id, dec, notes);
      setToast(dec === 'APPROVED' ? 'Flag cleared.' : 'Flag retained.');
      setSelected(null);
      fetchData();
    } catch (err) {
      console.error('Failed to review face check', err);
      setToast('Failed to record review.');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 3 }}>
        <FaceRetouchingNaturalIcon fontSize="large" />
        <Typography variant="h4">Face Checks</Typography>
        <Chip
          label={`${events.length} pending`}
          color={events.length > 0 ? 'warning' : 'success'}
          sx={{ ml: 1 }}
        />
      </Stack>

      {toast && (
        <Paper sx={{ p: 2, mb: 2, backgroundColor: 'success.light' }}>
          <Typography>{toast}</Typography>
        </Paper>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : events.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: 'center' }}>
          <Typography color="text.secondary">
            No flagged face checks awaiting review. 🎉
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Driver</TableCell>
                <TableCell>Selfie</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Score</TableCell>
                <TableCell>When</TableCell>
                <TableCell align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id} hover onClick={() => openReview(e)} sx={{ cursor: 'pointer' }}>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Avatar src={e.profile_image_url || undefined}>
                        {(e.full_name || '?').charAt(0)}
                      </Avatar>
                      <Box>
                        <Typography variant="subtitle2">{e.full_name || 'Unknown'}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {e.email || e.user_id}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    {selfieSrc(e) ? (
                      <Avatar
                        variant="rounded"
                        src={selfieSrc(e)}
                        alt="selfie"
                        sx={{ width: 56, height: 56 }}
                      />
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        n/a
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={REASON_LABELS[e.reason] || e.reason || 'Unknown'}
                      color={e.reason === 'face_mismatch' ? 'error' : 'warning'}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>{fmtScore(e.match_score)}</TableCell>
                  <TableCell>
                    {e.created_at ? format(new Date(e.created_at), 'MMM d, HH:mm') : '—'}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" variant="outlined" onClick={(ev) => { ev.stopPropagation(); openReview(e); }}>
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={!!selected} onClose={() => setSelected(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Review Face Check</DialogTitle>
        <DialogContent>
          {selected && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Stack direction="row" spacing={2} alignItems="center">
                <Avatar src={selected.profile_image_url || undefined} sx={{ width: 64, height: 64 }}>
                  {(selected.full_name || '?').charAt(0)}
                </Avatar>
                <Box>
                  <Typography variant="h6">{selected.full_name || 'Unknown'}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {selected.email || selected.user_id}
                  </Typography>
                </Box>
              </Stack>

              {selfieSrc(selected) && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Captured selfie (what the driver submitted)
                  </Typography>
                  <Avatar
                    variant="rounded"
                    src={selfieSrc(selected)}
                    alt="selfie"
                    sx={{ width: '100%', height: 240, mt: 0.5, cursor: 'pointer' }}
                    onClick={() => window.open(selfieSrc(selected), '_blank')}
                  />
                </Box>
              )}

              <Stack direction="row" spacing={2}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Reason</Typography>
                  <Typography>{REASON_LABELS[selected.reason] || selected.reason || 'Unknown'}</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">Score</Typography>
                  <Typography>
                    {fmtScore(selected.match_score)}
                  </Typography>
                </Box>
              </Stack>

              {selected.reference_image_url && (
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Enrolled profile reference
                  </Typography>
                  <Avatar
                    variant="rounded"
                    src={selected.reference_image_url}
                    alt="reference"
                    sx={{ width: '100%', height: 240, mt: 0.5, cursor: 'pointer' }}
                    onClick={() => window.open(selected.reference_image_url, '_blank')}
                  />
                </Box>
              )}

              {selected.quality && (
                <Box>
                  <Typography variant="caption" color="text.secondary">Quality</Typography>
                  <Typography variant="body2">
                    {Array.isArray(selected.quality.reasons) && selected.quality.reasons.length
                      ? selected.quality.reasons.join(', ')
                      : 'passed'}
                  </Typography>
                </Box>
              )}

              <TextField
                label="Reviewer notes (optional)"
                multiline
                minRows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                fullWidth
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setSelected(null)} disabled={actionLoading}>
            Cancel
          </Button>
          <Tooltip title="Keep the flag — driver must re-verify">
            <Button
              color="error"
              variant="outlined"
              startIcon={<BlockIcon />}
              disabled={actionLoading}
              onClick={() => handleDecision('REJECTED')}
            >
              Reject
            </Button>
          </Tooltip>
          <Button
            color="success"
            variant="contained"
            startIcon={<CheckIcon />}
            disabled={actionLoading}
            onClick={() => handleDecision('APPROVED')}
          >
            Approve
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default FaceChecks;
