import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Divider, 
  Chip, 
  CircularProgress,
  Button,
  List,
  ListItem,
  ListItemText,
  Card,
  CardContent,
  CardMedia,
  Breadcrumbs,
  Link
} from '@mui/material';
import Grid from '@mui/material/Grid';
import BackIcon from '@mui/icons-material/ArrowBack';
import TimelineIcon from '@mui/icons-material/Timeline';
import VerifiedIcon from '@mui/icons-material/VerifiedUser';
import WarningIcon from '@mui/icons-material/Warning';
import StarIcon from '@mui/icons-material/Star';
import { useNavigate, useParams, Link as RouterLink } from 'react-router-dom';
import api from '../api';
import { format } from 'date-fns';

const RideAudit: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [auditData, setAuditData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAudit = async () => {
      try {
        const response = await api.get(`/admin/rides/${id}/audit`);
        setAuditData(response.data);
      } catch (error) {
        console.error('Failed to fetch ride audit:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchAudit();
  }, [id]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress thickness={5} size={50} />
      </Box>
    );
  }

  if (!auditData) return <Typography sx={{ m: 4 }}>Ride audit data not found.</Typography>;

  const snapshot = auditData.compliance_snapshot || {};
  const isExpired = (date: string) => {
    if (!date) return false;
    return new Date(date) < new Date();
  };

  return (
    <Box sx={{ maxWidth: 1400, mx: 'auto' }}>
      <Box sx={{ mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Button 
            startIcon={<BackIcon />} 
            onClick={() => navigate(-1)} 
            variant="outlined"
            sx={{ borderRadius: '10px' }}
          >
            Back
          </Button>
          <Breadcrumbs aria-label="breadcrumb" sx={{ '& .MuiBreadcrumbs-separator': { mx: 1 } }}>
            <Link component={RouterLink} underline="hover" color="inherit" to="/" sx={{ display: 'flex', alignItems: 'center', fontWeight: 600, fontSize: '0.85rem' }}>
              Admin
            </Link>
            <Link component={RouterLink} underline="hover" color="inherit" to="/rides/completed" sx={{ display: 'flex', alignItems: 'center', fontWeight: 600, fontSize: '0.85rem' }}>
              Rides
            </Link>
            <Typography color="text.primary" sx={{ fontWeight: 600, fontSize: '0.85rem' }}>Investigation Report</Typography>
          </Breadcrumbs>
        </Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          Investigation Audit <Typography component="span" variant="h5" color="text.secondary" sx={{ fontWeight: 400 }}>#{id?.substring(0, 8)}</Typography>
        </Typography>
      </Box>

      <Grid container spacing={4} {...({ component: 'div' } as any)}>
        {/* Left Column: Timeline & Ratings */}
        <Grid item xs={12} lg={5} {...({ component: 'div' } as any)}>
          <Paper sx={{ p: 3, mb: 4, borderRadius: 4, border: 'none' }}>
            <Typography variant="subtitle1" gutterBottom sx={{ display: 'flex', alignItems: 'center', fontWeight: 700, mb: 3 }}>
              <TimelineIcon sx={{ mr: 1.5, color: 'primary.main' }} /> Trip Lifecycle
            </Typography>
            <Box sx={{ position: 'relative', pl: 3, borderLeft: '2px solid', borderColor: 'divider', ml: 1.5 }}>
              {auditData.timeline.map((event: any, idx: number) => (
                <Box key={idx} sx={{ position: 'relative', mb: 3, '&:last-child': { mb: 0 } }}>
                  <Box sx={{ 
                    position: 'absolute', 
                    left: -32, 
                    top: 4, 
                    width: 14, 
                    height: 14, 
                    borderRadius: '50%', 
                    bgcolor: 'primary.main',
                    border: '3px solid white',
                    boxShadow: '0 0 0 2px rgba(0,0,0,0.05)'
                  }} />
                  <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>{event.event}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
                    {format(new Date(event.time), 'PPP p')}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Paper>

          <Paper sx={{ p: 3, borderRadius: 4, border: 'none' }}>
            <Typography variant="subtitle1" gutterBottom sx={{ display: 'flex', alignItems: 'center', fontWeight: 700, mb: 3 }}>
              <StarIcon sx={{ mr: 1.5, color: '#C79A4A' }} /> Feedback Exchange
            </Typography>
            {auditData.ratings.all_ratings.length > 0 ? (
              <List disablePadding>
                {auditData.ratings.all_ratings.map((r: any, idx: number) => (
                  <React.Fragment key={idx}>
                    <ListItem alignItems="flex-start" sx={{ px: 0, py: 2 }}>
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, justifyContent: 'space-between' }}>
                            <Typography variant="body2" sx={{ fontWeight: 800, color: 'text.primary' }}>
                              {r.target_role === 'DRIVER' ? 'RIDER FEEDBACK' : 'DRIVER FEEDBACK'}
                            </Typography>
                            <Chip 
                              label={`${r.rating}.0`} 
                              size="small" 
                              sx={{ 
                                fontWeight: 800, 
                                height: 20, 
                                bgcolor: '#1a1a1a', 
                                color: 'white',
                                '& .MuiChip-icon': { color: '#C79A4A', fontSize: 14 }
                              }} 
                              icon={<StarIcon />} 
                            />
                          </Box>
                        }
                        secondary={
                          <Box sx={{ mt: 1 }}>
                            <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 500, fontStyle: r.review_text ? 'normal' : 'italic', bgcolor: 'background.default', p: 2, borderRadius: 2 }}>
                              {r.review_text || 'No comments provided by participant.'}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block', textAlign: 'right', fontWeight: 600 }}>
                              LOGGED: {format(new Date(r.created_at), 'HH:mm • MMM d, yyyy')}
                            </Typography>
                          </Box>
                        }
                      />
                    </ListItem>
                    {idx < auditData.ratings.all_ratings.length - 1 && <Divider sx={{ borderStyle: 'dashed' }} />}
                  </React.Fragment>
                ))}
              </List>
            ) : (
              <Box sx={{ p: 4, textAlign: 'center', bgcolor: 'background.default', borderRadius: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>No ratings have been submitted for this trip.</Typography>
              </Box>
            )}
          </Paper>
        </Grid>

        {/* Right Column: Compliance Snapshot */}
        <Grid item xs={12} lg={7} {...({ component: 'div' } as any)}>
          <Paper sx={{ p: 4, borderRadius: 4, border: 'none' }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 4 }}>
              <Box>
                <Typography variant="subtitle1" sx={{ display: 'flex', alignItems: 'center', fontWeight: 700, mb: 1 }}>
                  <VerifiedIcon sx={{ mr: 1.5, color: 'secondary.main' }} /> Dispatch Compliance Snapshot
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
                  Captured automatically on {snapshot.captured_at ? format(new Date(snapshot.captured_at), 'PPP p') : '---'}
                </Typography>
              </Box>
              <Chip label="IMMUTABLE RECORD" size="small" variant="outlined" sx={{ fontWeight: 800, fontSize: '0.65rem' }} />
            </Box>

            <Grid container spacing={2.5} {...({ component: 'div' } as any)}>
              {[
                { title: 'Driver License', status: 'VERIFIED', expiry: snapshot.license_expiry, url: snapshot.license_photo },
                { title: 'Commercial Insurance', status: 'VERIFIED', url: snapshot.insurance_photo },
                { title: 'Vehicle Registration', status: 'VERIFIED', url: snapshot.registration_photo },
                { title: 'Inspection Certificate', status: snapshot.inspection_status, expiry: snapshot.inspection_expiry, url: snapshot.inspection_photo }
              ].map((doc, idx) => (
                <Grid item xs={12} sm={6} key={idx} {...({ component: 'div' } as any)}>
                  <Card sx={{ border: '1px solid', borderColor: 'divider', boxShadow: 'none', transition: 'all 0.2s', '&:hover': { borderColor: 'primary.main', transform: 'scale(1.02)' } }}>
                    <CardContent sx={{ p: 2, pb: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1.5 }}>
                        <Typography variant="body2" sx={{ fontWeight: 800 }}>{doc.title}</Typography>
                        {isExpired(doc.expiry) && <Chip label="EXPIRED" color="error" size="small" sx={{ height: 18, fontSize: '0.6rem', fontWeight: 900 }} />}
                      </Box>
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', fontWeight: 600 }}>
                          Status: <Box component="span" sx={{ color: doc.status === 'APPROVED' || doc.status === 'VERIFIED' ? 'success.main' : 'warning.main', ml: 0.5 }}>{doc.status || 'UNKNOWN'}</Box>
                        </Typography>
                        {doc.expiry && (
                          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                            Validity: {format(new Date(doc.expiry), 'MMM d, yyyy')}
                          </Typography>
                        )}
                      </Box>
                    </CardContent>
                    {doc.url ? (
                      <CardMedia
                        component="img"
                        height="160"
                        image={doc.url}
                        alt={doc.title}
                        sx={{ objectFit: 'cover', bgcolor: '#f5f5f5', cursor: 'pointer', borderTop: '1px solid rgba(0,0,0,0.05)' }}
                        onClick={() => window.open(doc.url, '_blank')}
                      />
                    ) : (
                      <Box sx={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#fafafa', borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                        <WarningIcon color="disabled" sx={{ fontSize: 32 }} />
                      </Box>
                    )}
                  </Card>
                </Grid>
              ))}
            </Grid>

            <Box sx={{ mt: 5, p: 3, bgcolor: '#f0f4f2', borderRadius: 3, borderLeft: '6px solid', borderColor: 'secondary.main' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 800, color: 'secondary.dark', mb: 1 }}>Audit Integrity Notice</Typography>
              <Typography variant="caption" sx={{ color: 'secondary.dark', display: 'block', lineHeight: 1.6, fontWeight: 500 }}>
                This compliance state reflects the driver's eligibility at the exact second the trip was dispatched. Subsequent updates to the driver's profile do not modify this historical report. Use this for legal disputes or safety investigations.
              </Typography>
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default RideAudit;
