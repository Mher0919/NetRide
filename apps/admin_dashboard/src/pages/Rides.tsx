import React, { useEffect, useState } from 'react';
import { 
  Box, 
  Typography, 
  Paper, 
  Chip, 
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useNavigate } from 'react-router-dom';
import { getRides } from '../api/admin';
import { format } from 'date-fns';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3000';

interface RidesProps {
  status: 'ACTIVE' | 'COMPLETED';
  title: string;
}

const Rides: React.FC<RidesProps> = ({ status, title }) => {
  const navigate = useNavigate();
  const [rides, setRides] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [loading, setLoading] = useState(true);

  const fetchRides = async () => {
    setLoading(true);
    try {
      const data = await getRides({ status, page: page + 1, limit: rowsPerPage });
      setRides(data.rides);
      setTotal(data.total);
    } catch (error) {
      console.error('Failed to fetch rides:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRides();
    
    const socket = io(API_URL, {
      auth: { token: localStorage.getItem('admin_token') }
    });

    socket.on('connect', () => {
      socket.emit('subscribeToMonitoring');
    });

    socket.on('tripUpdate', (updatedTrip: any) => {
      if (status === 'ACTIVE') {
        if (['COMPLETED', 'CANCELLED'].includes(updatedTrip.status)) {
          setRides(prev => prev.filter(r => r.id !== updatedTrip.id));
        } else {
          setRides(prev => {
            const index = prev.findIndex(r => r.id === updatedTrip.id);
            if (index !== -1) {
              const newRides = [...prev];
              newRides[index] = updatedTrip;
              return newRides;
            } else {
              if (page === 0) return [updatedTrip, ...prev].slice(0, rowsPerPage);
              return prev;
            }
          });
        }
      } 
      else if (status === 'COMPLETED' && updatedTrip.status === 'COMPLETED') {
        if (page === 0) {
          setRides(prev => [updatedTrip, ...prev].slice(0, rowsPerPage));
        }
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [status, page, rowsPerPage]);

  const handleChangePage = (_event: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const getStatusChip = (status: string) => {
    let color: any = 'default';
    let label = status;
    
    switch (status) {
      case 'REQUESTED': color = 'warning'; break;
      case 'ACCEPTED': color = 'info'; break;
      case 'DRIVER_ARRIVING': color = 'info'; break;
      case 'IN_PROGRESS': color = 'primary'; label = 'IN RIDE'; break;
      case 'COMPLETED': color = 'success'; break;
      case 'CANCELLED': color = 'error'; break;
    }

    return (
      <Chip 
        label={label} 
        size="small" 
        sx={{ 
          fontWeight: 700, 
          fontSize: '0.65rem',
          borderRadius: '6px',
          height: 24,
          px: 0.5,
          color: color === 'default' ? 'text.secondary' : 'white',
          bgcolor: color === 'primary' ? 'primary.main' : undefined
        }}
        color={color !== 'primary' ? color : undefined}
      />
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 5 }}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          {title}
        </Typography>
        <Button 
          startIcon={<RefreshIcon />} 
          variant="contained" 
          onClick={fetchRides}
          disabled={loading}
          sx={{ borderRadius: '12px' }}
        >
          Refresh
        </Button>
      </Box>

      <Paper sx={{ width: '100%', mb: 2, border: 'none', overflow: 'hidden' }}>
        <TableContainer>
          <Table sx={{ minWidth: 750 }}>
            <TableHead sx={{ backgroundColor: '#f8f9fa' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2 }}>ID</TableCell>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2 }}>Participants</TableCell>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2 }}>Route</TableCell>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2 }}>Status</TableCell>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2 }}>Timestamp</TableCell>
                <TableCell sx={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.75rem', color: 'text.secondary', py: 2, textAlign: 'right' }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rides.map((ride) => (
                <TableRow key={ride.id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                  <TableCell sx={{ fontSize: '0.8rem', color: 'text.secondary', fontWeight: 600 }}>
                    #{ride.id.substring(0, 8)}
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{ride.rider?.full_name}</Typography>
                        <Chip label="RIDER" size="small" sx={{ ml: 1, height: 16, fontSize: '0.6rem', fontWeight: 700 }} />
                      </Box>
                      {ride.driver ? (
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>{ride.driver?.full_name}</Typography>
                          <Chip label="DRIVER" size="small" variant="outlined" sx={{ ml: 1, height: 16, fontSize: '0.6rem', fontWeight: 700 }} />
                        </Box>
                      ) : (
                        <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>Waiting for driver...</Typography>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', flexDirection: 'column', maxWidth: 250 }}>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                        <Box component="span" sx={{ color: 'success.main', mr: 1 }}>●</Box>
                        {ride.pickup_address}
                      </Typography>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                        <Box component="span" sx={{ color: 'error.main', mr: 1 }}>■</Box>
                        {ride.destination_address}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    {getStatusChip(ride.status)}
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {ride.created_at ? format(new Date(ride.created_at), 'MMM d') : '-'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {ride.created_at ? format(new Date(ride.created_at), 'HH:mm') : '-'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Button 
                      size="small" 
                      variant="outlined"
                      color="primary"
                      onClick={() => navigate(`/rides/${ride.id}`)}
                      sx={{ borderRadius: '8px', fontWeight: 700, fontSize: '0.75rem' }}
                    >
                      Details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rides.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 10 }}>
                    <Box sx={{ opacity: 0.5 }}>
                      <RefreshIcon sx={{ fontSize: 48, mb: 2 }} />
                      <Typography variant="h6">No ride records found</Typography>
                    </Box>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          rowsPerPageOptions={[10, 25, 50]}
          component="div"
          count={total}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
          sx={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}
        />
      </Paper>
    </Box>
  );
};

export default Rides;
