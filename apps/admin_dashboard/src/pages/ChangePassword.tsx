import React, { useState } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  TextField, 
  Button, 
  Alert, 
  CircularProgress,
  Container 
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext';

const ChangePassword: React.FC = () => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated } = useAuth();

  const isExpired = location.state?.expired;
  const tempToken = location.state?.token;
  const tempUser = location.state?.user;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      setLoading(false);
      return;
    }

    try {
      const headers = tempToken ? { Authorization: `Bearer ${tempToken}` } : {};
      await api.post('/auth/change-password', 
        { currentPassword, newPassword },
        { headers }
      );
      
      setSuccess('Your security credentials have been updated.');
      
      setTimeout(() => {
        if (isExpired && tempUser && tempToken) {
          login(tempUser, tempToken);
          navigate('/');
        } else if (isAuthenticated) {
          navigate('/');
        } else {
          navigate('/login');
        }
      }, 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Credential update failed. Please verify your current password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box 
      sx={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: isExpired ? 'linear-gradient(135deg, #1a1a1a 0%, #333333 100%)' : 'background.default',
        p: 3
      }}
    >
      <Container maxWidth="xs">
        <Paper 
          elevation={0} 
          sx={{ 
            p: 5, 
            borderRadius: 5, 
            boxShadow: isExpired ? '0 20px 60px rgba(0,0,0,0.3)' : '0 10px 40px rgba(0,0,0,0.05)',
            bgcolor: 'white',
            textAlign: 'center'
          }}
        >
          <Box sx={{ mb: 4 }}>
            <Box sx={{ 
              width: 56, 
              height: 56, 
              bgcolor: 'secondary.main', 
              borderRadius: '16px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              mx: 'auto',
              mb: 3,
              boxShadow: '0 8px 24px rgba(0,0,0,0.1)'
            }}>
              <LockIcon sx={{ color: 'white', fontSize: 32 }} />
            </Box>
            <Typography variant="h5" sx={{ fontWeight: 800, mb: 1 }}>
              {isExpired ? 'Update Required' : 'Security Settings'}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
              {isExpired 
                ? 'Your administrative password has expired and must be updated for security compliance.' 
                : 'Modify your administrative access credentials.'}
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 3, borderRadius: 3, fontWeight: 600, fontSize: '0.85rem' }}>
              {error}
            </Alert>
          )}

          {success && (
            <Alert severity="success" sx={{ mb: 3, borderRadius: 3, fontWeight: 600, fontSize: '0.85rem' }}>
              {success}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            {!isExpired && (
              <TextField
                fullWidth
                label="Current Security Password"
                type="password"
                variant="filled"
                margin="normal"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                {...({
                  InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
                } as any)}
              />
            )}
            <TextField
              fullWidth
              label="New Access Password"
              type="password"
              variant="filled"
              margin="normal"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              {...({
                InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
              } as any)}
            />
            <TextField
              fullWidth
              label="Confirm New Password"
              type="password"
              variant="filled"
              margin="normal"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              {...({
                InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
              } as any)}
            />
            
            <Button
              fullWidth
              variant="contained"
              size="large"
              type="submit"
              disabled={loading || !!success}
              sx={{ 
                mt: 4, 
                mb: 2, 
                height: 56, 
                borderRadius: '14px', 
                fontSize: '1rem',
                boxShadow: '0 8px 20px rgba(0,0,0,0.15)'
              }}
            >
              {loading ? <CircularProgress size={24} color="inherit" /> : 'Update Security Protocol'}
            </Button>

            {!isExpired && (
              <Button
                fullWidth
                variant="text"
                onClick={() => navigate('/')}
                disabled={loading || !!success}
                sx={{ fontWeight: 700, color: 'text.secondary', py: 1.5 }}
              >
                Return to Dashboard
              </Button>
            )}
          </form>
        </Paper>
      </Container>
    </Box>
  );
};

export default ChangePassword;
