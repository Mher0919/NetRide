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
} from '@mui/material';
import LockResetIcon from '@mui/icons-material/LockReset';
import { useNavigate } from 'react-router-dom';
import { sponsorChangePassword } from '../api/sponsor';

const ChangePassword: React.FC = () => {
  const navigate = useNavigate();
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
      await sponsorChangePassword(password);
      setSnack({ open: true, message: 'Password updated. Please log in again.', severity: 'success' });
      localStorage.removeItem('sponsor_token');
      localStorage.removeItem('sponsor_user');
      window.setTimeout(() => navigate('/login'), 1200);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Update failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 2 }}>
      <Paper sx={{ p: 4, borderRadius: 4, maxWidth: 400, width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: 2, bgcolor: 'primary.main', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LockResetIcon />
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800 }}>Set a new password</Typography>
            <Typography variant="caption" color="text.secondary">Required before you can use the portal</Typography>
          </Box>
        </Box>
        <form onSubmit={handleSubmit}>
          <TextField
            label="New password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            required
            autoFocus
            helperText="At least 8 characters"
            sx={{ mb: 2 }}
          />
          <TextField
            label="Confirm password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            fullWidth
            required
            sx={{ mb: 3 }}
          />
          <Button type="submit" variant="contained" fullWidth size="large" disabled={loading}>
            {loading ? <CircularProgress size={22} color="inherit" /> : 'Update password'}
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