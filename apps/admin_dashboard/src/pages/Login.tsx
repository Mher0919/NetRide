import React, { useState } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  TextField, 
  Button, 
  Alert, 
  CircularProgress,
  Container,
  FormControlLabel,
  Checkbox 
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import { useNavigate, Navigate } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [showOTP, setShowOTP] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login, isAuthenticated } = useAuth();

  if (isAuthenticated) {
    return <Navigate to="/" />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (showOTP) {
        const response = await api.post('/auth/admin/verify-2fa', { email, code: otp });
        const { user, token, trustedDeviceToken } = response.data;
        
        if (trustDevice) {
          // Remember this device for 30 days — no email code on next login
          // until the token expires.
          localStorage.setItem('trusted_device_token', trustedDeviceToken ?? token);
        }

        login(user, token);
        navigate('/');
        return;
      }

      const response = await api.post('/auth/login-password', { 
        email, 
        password, 
        trusted_device_token: localStorage.getItem('trusted_device_token') 
      });
      const { user, token, password_expired, otp_required } = response.data;

      if (otp_required) {
        setShowOTP(true);
        setLoading(false);
        return;
      }

      if (user.role !== 'ADMIN') {
        setError('Access denied. Administrative authorization required.');
        setLoading(false);
        return;
      }

      if (password_expired) {
        navigate('/change-password', { state: { expired: true, token, user } });
        return;
      }

      login(user, token);
      navigate('/');
    } catch (err: any) {
      const apiError = err.response?.data?.error;
      if (apiError) {
        setError(apiError);
      } else if (!err.response) {
        setError('Unable to reach the server. Please verify the backend is running, then try again.');
      } else {
        setError('Authentication failed. Please check your credentials.');
      }
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
        background: 'linear-gradient(135deg, #1a1a1a 0%, #333333 100%)',
        p: 3
      }}
    >
      <Container maxWidth="xs">
        <Paper 
          elevation={0} 
          sx={{ 
            p: 5, 
            borderRadius: 5, 
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            bgcolor: 'white',
            textAlign: 'center'
          }}
        >
          <Box sx={{ mb: 4 }}>
            <Box sx={{ 
              width: 56, 
              height: 56, 
              bgcolor: 'primary.main', 
              borderRadius: '16px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              mx: 'auto',
              mb: 3,
              boxShadow: '0 8px 24px rgba(0,0,0,0.1)'
            }}>
              <DashboardIcon sx={{ color: 'white', fontSize: 32 }} />
            </Box>
            <Typography variant="h4" sx={{ fontWeight: 800, letterSpacing: '-0.04em', mb: 1 }}>
              NetRide <Typography component="span" variant="h4" sx={{ fontWeight: 400, color: 'text.secondary' }}>Admin</Typography>
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
              {showOTP ? 'Enter the verification code sent to your email' : 'Operational Management Console'}
            </Typography>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 3, borderRadius: 3, fontWeight: 600, fontSize: '0.85rem' }}>
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit}>
            {!showOTP ? (
              <>
                <TextField
                  fullWidth
                  label="Administrator Email"
                  variant="filled"
                  margin="normal"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  {...({
                    InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
                  } as any)}
                />
                <TextField
                  fullWidth
                  label="Security Password"
                  type="password"
                  variant="filled"
                  margin="normal"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  {...({
                    InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
                  } as any)}
                />
              </>
            ) : (
              <>
                <Box sx={{ mb: 2, p: 2, bgcolor: '#f0f4f2', borderRadius: 3, border: '1px dashed', borderColor: 'secondary.main' }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: 'secondary.dark' }}>
                    A secure code was dispatched to your authorized inbox.
                  </Typography>
                </Box>
                <TextField
                  fullWidth
                  label="Security OTP"
                  variant="filled"
                  margin="normal"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  required
                  autoFocus
                  {...({
                    inputProps: { maxLength: 6, style: { textAlign: 'center', letterSpacing: '0.5em', fontSize: '1.5rem', fontWeight: 800 } },
                    InputProps: { disableUnderline: true, sx: { borderRadius: 3, bgcolor: '#f5f5f5' } }
                  } as any)}
                />
                <FormControlLabel
                  control={
                    <Checkbox 
                      checked={trustDevice} 
                      onChange={(e) => setTrustDevice(e.target.checked)} 
                      color="primary"
                    />
                  }
                  label="Remember this device for 30 days"
                  sx={{ mt: 1, '& .MuiTypography-root': { fontWeight: 600, fontSize: '0.85rem' } }}
                />
              </>
            )}
            
            <Button
              fullWidth
              variant="contained"
              size="large"
              type="submit"
              disabled={loading}
              sx={{ 
                mt: 4, 
                mb: 2, 
                height: 56, 
                borderRadius: '14px', 
                fontSize: '1rem',
                boxShadow: '0 8px 20px rgba(0,0,0,0.15)'
              }}
            >
              {loading ? <CircularProgress size={24} color="inherit" /> : (showOTP ? 'Authorize Access' : 'Initialize Session')}
            </Button>

            {showOTP && (
              <Button
                fullWidth
                variant="text"
                onClick={() => setShowOTP(false)}
                disabled={loading}
                sx={{ fontWeight: 700, color: 'text.secondary', py: 1.5 }}
              >
                Back to credentials
              </Button>
            )}
          </form>
          
          <Box sx={{ mt: 4 }}>
            <Typography variant="caption" color="text.disabled" sx={{ fontWeight: 600, letterSpacing: 1 }}>
              SYSTEM SECURED BY NETRIDE CORE
            </Typography>
          </Box>
        </Paper>
      </Container>
    </Box>
  );
};

export default Login;
