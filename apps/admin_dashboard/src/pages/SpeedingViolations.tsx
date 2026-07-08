// apps/admin_dashboard/src/pages/SpeedingViolations.tsx
//
// Fleet-wide view of speeding violations. Lists drivers with their
// recent violations, filterable by "dangerous only". Reuses the
// audit-log styling palette (sage / cream / dark-forest). Critical
// for the safety review loop — admins use this to find drivers who
// are about to cross the dangerous threshold (3 violation-trips in
// 90 days) so they can intervene before the system flips them.

import React, { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { getSpeedingViolations, getDangerousDrivers } from '../api/admin';
import { SpeedingBadge } from '../components/SpeedingBadge';

interface Violation {
  id: string;
  driver_id: string;
  trip_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  max_over_mph: number;
  avg_speed_mph: number;
  road_name: string | null;
  is_freeway: boolean;
  driver_name?: string;
  driver_email?: string;
  pickup_address?: string;
  destination_address?: string;
  created_at: string;
}

export default function SpeedingViolations() {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [dangerousDrivers, setDangerousDrivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dangerousOnly, setDangerousOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [v, d] = await Promise.all([
          getSpeedingViolations({ dangerousOnly, limit: 200 }),
          getDangerousDrivers(),
        ]);
        if (cancelled) return;
        setViolations(v.violations ?? []);
        setDangerousDrivers(d.drivers ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dangerousOnly]);

  return (
    <Box sx={{ p: { xs: 2, md: 4 } }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', md: 'center' }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h4">Speeding Violations</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
            Newest first. Continuous over-limit streaks of ≥45s count as a
            single violation. Drivers with 3+ violation-trips in 90 days are
            auto-flagged <em>dangerous</em>.
          </Typography>
        </Box>
        <FormControlLabel
          control={
            <Switch
              checked={dangerousOnly}
              onChange={(e) => setDangerousOnly(e.target.checked)}
            />
          }
          label="Dangerous only"
        />
      </Stack>

      {/* Summary cards */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <SummaryCard
          label="Recent violations"
          value={violations.length.toString()}
          accent="#2F3A32"
        />
        <SummaryCard
          label="Drivers flagged dangerous"
          value={dangerousDrivers.length.toString()}
          accent="#C65A5A"
        />
      </Stack>

      <Card>
        <CardContent sx={{ p: 0, '&:last-child': { pb: 0 } }}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
              <CircularProgress />
            </Box>
          ) : violations.length === 0 ? (
            <Box sx={{ p: 6, textAlign: 'center' }}>
              <Typography variant="h6" sx={{ color: 'text.secondary' }}>
                No violations recorded
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
                Drivers are driving safely. This view updates in real time as
                violations are recorded at the end of each trip.
              </Typography>
            </Box>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Driver</TableCell>
                    <TableCell>When</TableCell>
                    <TableCell>Road</TableCell>
                    <TableCell align="right">Avg mph</TableCell>
                    <TableCell align="right">Max over</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {violations.map((v) => {
                    const isDangerousDriver = dangerousDrivers.some(
                      (d) => d.user_id === v.driver_id,
                    );
                    return (
                      <TableRow key={v.id} hover>
                        <TableCell>
                          <Stack>
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>
                              {v.driver_name ?? v.driver_id.slice(0, 8)}
                            </Typography>
                            {v.driver_email && (
                              <Typography
                                variant="caption"
                                sx={{ color: 'text.secondary' }}
                              >
                                {v.driver_email}
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">
                            {new Date(v.created_at).toLocaleString()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">
                            {v.road_name ?? '—'}
                          </Typography>
                          {v.is_freeway && (
                            <Chip
                              label="Freeway"
                              size="small"
                              sx={{
                                mt: 0.5,
                                height: 18,
                                fontSize: 10,
                                backgroundColor: '#D8D2CA',
                                color: '#2F3A32',
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {v.avg_speed_mph}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 700,
                              color:
                                v.max_over_mph >= 25 ? '#C65A5A' : '#2F3A32',
                            }}
                          >
                            +{v.max_over_mph}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2">
                            {Math.max(
                              Math.round(v.duration_seconds),
                              45,
                            )}s
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <SpeedingBadge
                            isDangerous={isDangerousDriver}
                            isFlagged={false}
                            driverId={v.driver_id}
                            size="sm"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

const SummaryCard: React.FC<{ label: string; value: string; accent: string }> = ({
  label,
  value,
  accent,
}) => (
  <Card sx={{ flex: 1, borderLeft: `4px solid ${accent}` }}>
    <CardContent>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
        {label}
      </Typography>
      <Typography variant="h4" sx={{ mt: 1, color: accent }}>
        {value}
      </Typography>
    </CardContent>
  </Card>
);