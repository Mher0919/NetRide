import React, { useEffect, useState } from 'react';
import { 
  Paper, 
  Typography, 
  Box, 
  CircularProgress,
  Card,
  CardContent,
  Chip
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import PeopleIcon from '@mui/icons-material/People';
import DriverIcon from '@mui/icons-material/LocalTaxi';
import PendingIcon from '@mui/icons-material/PendingActions';
import VerifiedIcon from '@mui/icons-material/CheckCircle';
import RejectedIcon from '@mui/icons-material/Cancel';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../api';

interface Stats {
  totalRiders: number;
  totalDrivers: number;
  pendingVerifications: number;
  verifiedUsers: number;
  rejectedUsers: number;
  pendingDocumentReviews: number;
}

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await api.get('/admin/stats');
        setStats(response.data);
      } catch (error) {
        console.error('Failed to fetch stats', error);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();

    // Poll stats every 30 seconds to keep dashboard data current
    const pollTimer = setInterval(fetchStats, 30_000);
    return () => clearInterval(pollTimer);
  }, []);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress thickness={5} size={50} sx={{ color: 'primary.main' }} />
      </Box>
    );
  }

  const statCards = [
    { title: 'Total Riders', value: stats?.totalRiders, icon: <PeopleIcon />, color: '#e3f2fd', iconColor: '#1976d2' },
    { title: 'Total Drivers', value: stats?.totalDrivers, icon: <DriverIcon />, color: '#f3e5f5', iconColor: '#9c27b0' },
    { title: 'Pending', value: stats?.pendingVerifications, icon: <PendingIcon />, color: '#fff3e0', iconColor: '#ed6c02' },
    { title: 'Verified', value: stats?.verifiedUsers, icon: <VerifiedIcon />, color: '#e8f5e9', iconColor: '#2e7d32' },
    { title: 'Rejected', value: stats?.rejectedUsers, icon: <RejectedIcon />, color: '#ffebee', iconColor: '#d32f2f' },
    { title: 'Docs Pending', value: stats?.pendingDocumentReviews, icon: <DescriptionIcon />, color: '#e8eaf6', iconColor: '#3f51b5' },
  ];

  const chartData = [
    { name: 'Riders', count: stats?.totalRiders },
    { name: 'Drivers', count: stats?.totalDrivers },
    { name: 'Pending', count: stats?.pendingVerifications },
    { name: 'Verified', count: stats?.verifiedUsers },
    { name: 'Rejected', count: stats?.rejectedUsers },
    { name: 'Docs Pending', count: stats?.pendingDocumentReviews },
  ];

  return (
    <Box sx={{ maxWidth: '100%', mx: 'auto' }}>
      <Typography variant="h4" sx={{ mb: 4, fontWeight: 800 }}>
        Platform Overview
      </Typography>

      <Box 
        sx={{ 
          display: 'grid', 
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
            lg: 'repeat(5, 1fr)'
          }, 
          gap: 3,
          mb: 5 
        }}
      >
        {statCards.map((card) => (
          <Card key={card.title} sx={{ border: 'none', transition: 'transform 0.2s', '&:hover': { transform: 'translateY(-4px)' } }}>
            <CardContent sx={{ p: 3 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <Box sx={{ 
                  p: 1.5, 
                  borderRadius: '12px', 
                  backgroundColor: card.color, 
                  display: 'flex', 
                  color: card.iconColor,
                  mr: 2 
                }}>
                  {React.cloneElement(card.icon as React.ReactElement, { 
                    style: { fontSize: 20 }
                  } as any)}
                </Box>
                <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                  {card.title}
                </Typography>
              </Box>
              <Typography variant="h3" sx={{ fontWeight: 800, color: 'text.primary' }}>
                {card.value?.toLocaleString()}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      <Box sx={{ width: '100%', mt: 4, display: 'flex', justifyContent: 'center' }}>
        <Paper sx={{ p: 4, borderRadius: 4, width: '90%', maxWidth: 1400, boxSizing: 'border-box', border: 'none' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              System Distribution
            </Typography>
            <Chip label="Live Data" size="small" sx={{ fontWeight: 700, bgcolor: 'secondary.main', color: 'white' }} />
          </Box>
          <Box sx={{ height: 500, width: '100%', minWidth: 0 }}>
            {/* Explicit numeric height: avoids Recharts' first-paint
                “width(-1) and height(-1)” measurement warning. */}
            <ResponsiveContainer width="100%" height={500}>
              <BarChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#9e9e9e', fontSize: 13, fontWeight: 500 }} 
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fill: '#9e9e9e', fontSize: 13, fontWeight: 500 }} 
                />
                <Tooltip 
                  cursor={{ fill: '#f5f5f5' }}
                  contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 8px 24px rgba(0,0,0,0.1)' }}
                />
                <Bar 
                  dataKey="count" 
                  fill="#1a1a1a" 
                  radius={[8, 8, 0, 0]} 
                  barSize={60}
                />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </Paper>
      </Box>
    </Box>
  );
};

export default Dashboard;
