import React from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  Button,
  Snackbar,
  Alert,
  CircularProgress,
  Link,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { portalLogin, portalVerify2FA } from '../api/portal';
import PasswordField from '../components/PasswordField';

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [otp, setOtp] = React.useState('');
  const [showOTP, setShowOTP] = React.useState(false);
  const [trustDevice, setTrustDevice] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'error' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setSnack({ open: false, message: '', severity: 'error' });
    try {
      if (showOTP) {
        const result = await portalVerify2FA(email.trim(), otp);
        if (trustDevice && result.trustedDeviceToken) {
          // Remember this device for 30 days — no email code on next login
          // until the token expires.
          localStorage.setItem('portal_trusted_device_token', result.trustedDeviceToken);
        }
        login(result);
        navigate(result.portal.mustChangePassword ? '/change-password' : '/');
        return;
      }

      const result = await portalLogin(
        email.trim(),
        password,
        localStorage.getItem('portal_trusted_device_token'),
      );

      if ('otp_required' in result && result.otp_required) {
        setShowOTP(true);
        setSnack({ open: true, message: 'A 6-digit verification code was sent to your email.', severity: 'success' });
        return;
      }

      login(result);
      navigate(result.portal.mustChangePassword ? '/change-password' : '/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Login failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 4, borderRadius: 4, maxWidth: 400, width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <StorefrontIcon />
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>NetRide Partner</Typography>
            <Typography variant="caption" color="text.secondary">
              {showOTP ? 'Enter the 6-digit code sent to your email' : 'Sponsor · Partner · Fleet portal sign in'}
            </Typography>
          </Box>
        </Box>
        <form onSubmit={handleSubmit}>
          {!showOTP ? (
            <>
              <TextField
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                fullWidth
                required
                autoFocus
                sx={{ mb: 2 }}
              />
              <PasswordField
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                required
                sx={{ mb: 1 }}
              />
              <Box sx={{ textAlign: 'right', mb: 3 }}>
                <Link component={RouterLink} to="/forgot-password" variant="body2" sx={{ fontWeight: 600 }}>
                  Forgot password?
                </Link>
              </Box>
            </>
          ) : (
            <>
              <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
                A secure 6-digit code was sent to <b>{email}</b>. Enter it below to finish signing in.
              </Alert>
              <TextField
                label="6-digit code"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                fullWidth
                required
                autoFocus
                inputMode="numeric"
                placeholder="000000"
                sx={{ mt: 1, mb: 1 }}
                InputProps={{ inputProps: { maxLength: 6, style: { textAlign: 'center', letterSpacing: '0.4em', fontSize: '1.25rem', fontWeight: 800 } } }}
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
                sx={{ mb: 1, '& .MuiTypography-root': { fontWeight: 600, fontSize: '0.85rem' } }}
              />
            </>
          )}
          <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
            {loading ? <CircularProgress size={22} color="inherit" /> : (showOTP ? 'Verify & sign in' : 'Sign in')}
          </Button>
          {showOTP && (
            <Button fullWidth sx={{ mt: 1 }} disabled={loading} onClick={() => setShowOTP(false)}>
              Back to credentials
            </Button>
          )}
        </form>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3, textAlign: 'center' }}>
          Credentials are issued by NetRide. Contact support at <a href="mailto:support@netride.org">support@netride.org</a>.
        </Typography>
      </Paper>
      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Login;