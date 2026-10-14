import React from 'react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Snackbar,
  Alert,
  CircularProgress,
} from '@mui/material';
import LockResetIcon from '@mui/icons-material/LockReset';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { portalChangePassword } from '../api/portal';
import PasswordField from '../components/PasswordField';

const ChangePassword: React.FC = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'error' });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setSnack({ open: true, message: 'Password must be at least 8 characters', severity: 'error' });
      return;
    }
    if (password !== confirm) {
      setSnack({ open: true, message: 'Passwords do not match', severity: 'error' });
      return;
    }
    setLoading(true);
    try {
      await portalChangePassword(password);
      setSnack({ open: true, message: 'Password updated. Please log in again.', severity: 'success' });
      logout();
      window.setTimeout(() => navigate('/login'), 1200);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Update failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: { xs: 3, sm: 4 }, borderRadius: '16px', maxWidth: 400, width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: '12px', bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <LockResetIcon />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>Set a new password</Typography>
            <Typography variant="caption" color="text.secondary">Required before you can use the portal</Typography>
          </Box>
        </Box>
        <form onSubmit={handleSubmit}>
          <PasswordField
            label="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            required
            autoFocus
            autoComplete="new-password"
            helperText="At least 8 characters"
            sx={{ mb: 2 }}
          />
          <PasswordField
            label="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            fullWidth
            required
            autoComplete="new-password"
            sx={{ mb: 3 }}
          />
          <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
            {loading ? <CircularProgress size={22} color="inherit" /> : 'Update password'}
          </Button>
          <Button
            fullWidth
            sx={{ mt: 1 }}
            disabled={loading}
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            Sign out instead
          </Button>
        </form>
      </Paper>
      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default ChangePassword;