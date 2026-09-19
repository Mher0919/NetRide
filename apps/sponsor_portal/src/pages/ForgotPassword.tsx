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
  Stepper,
  Step,
  StepLabel,
} from '@mui/material';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { useNavigate } from 'react-router-dom';
import { portalForgotPassword, portalVerifyResetOTP, portalResetPassword } from '../api/portal';
import PasswordField from '../components/PasswordField';

const steps = ['Enter email', 'Verify code', 'Set new password'];

const ForgotPassword: React.FC = () => {
  const navigate = useNavigate();
  const [activeStep, setActiveStep] = React.useState(0);
  const [email, setEmail] = React.useState('');
  const [code, setCode] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [resetToken, setResetToken] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'error' });

  const handleRequestOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setSnack({ open: true, message: 'Email is required', severity: 'error' });
      return;
    }
    setLoading(true);
    try {
      await portalForgotPassword(email.trim());
      // Intentionally generic: identical for existing and non-existing
      // accounts so the response never reveals account existence.
      setSnack({ open: true, message: 'If an account with that email exists, a verification code has been sent.', severity: 'success' });
      setActiveStep(1);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to send code';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setSnack({ open: true, message: 'Please enter the 6-digit code', severity: 'error' });
      return;
    }
    setLoading(true);
    try {
      const res = await portalVerifyResetOTP(email.trim(), code);
      setResetToken(res.resetToken);
      setActiveStep(2);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Invalid or expired code';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      setSnack({ open: true, message: 'Password must be at least 8 characters', severity: 'error' });
      return;
    }
    if (newPassword !== confirm) {
      setSnack({ open: true, message: 'Passwords do not match', severity: 'error' });
      return;
    }
    setLoading(true);
    try {
      await portalResetPassword(resetToken, newPassword);
      setSnack({ open: true, message: 'Password reset successful. Redirecting to login...', severity: 'success' });
      window.setTimeout(() => navigate('/login'), 2000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Password reset failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 4, borderRadius: 4, maxWidth: 460, width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <StorefrontIcon />
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: '-0.03em' }}>Reset Password</Typography>
            <Typography variant="caption" color="text.secondary">Sponsor portal account recovery</Typography>
          </Box>
        </Box>

        <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
          {steps.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {activeStep === 0 && (
          <form onSubmit={handleRequestOTP}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Enter the email address associated with your sponsor portal account. If an account exists, we'll send you a verification code.
            </Typography>
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              fullWidth
              required
              autoFocus
              sx={{ mb: 3 }}
            />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
              {loading ? <CircularProgress size={22} color="inherit" /> : 'Send verification code'}
            </Button>
          </form>
        )}

        {activeStep === 1 && (
          <form onSubmit={handleVerifyOTP}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Enter the 6-digit code we may have sent to <b>{email}</b>
            </Typography>
            <TextField
              label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              fullWidth
              required
              autoFocus
              inputMode="numeric"
              placeholder="000000"
              sx={{ mt: 1, mb: 3 }}
            />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
              {loading ? <CircularProgress size={22} color="inherit" /> : 'Verify code'}
            </Button>
            <Button fullWidth sx={{ mt: 1 }} disabled={loading} onClick={() => setActiveStep(0)}>
              Back
            </Button>
          </form>
        )}

        {activeStep === 2 && (
          <form onSubmit={handleResetPassword}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Create a new password for your account.
            </Typography>
            <PasswordField
              label="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              fullWidth
              required
              autoFocus
              helperText="At least 8 characters"
              sx={{ mb: 2 }}
            />
            <PasswordField
              label="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              fullWidth
              required
              sx={{ mb: 3 }}
            />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
              {loading ? <CircularProgress size={22} color="inherit" /> : 'Reset password'}
            </Button>
          </form>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3, textAlign: 'center' }}>
          <Button size="small" onClick={() => navigate('/login')} sx={{ textTransform: 'none' }}>
            Back to sign in
          </Button>
        </Typography>
      </Paper>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default ForgotPassword;
