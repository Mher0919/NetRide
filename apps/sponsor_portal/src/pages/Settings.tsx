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
  Stack,
  Grid,
} from '@mui/material';
import { getPortalSettings, updatePortalSettings } from '../api/sponsor';

type SettingsState = Record<string, unknown> & {
  businessName?: string;
  discount?: string;
};

const Settings: React.FC = () => {
  const [settings, setSettings] = React.useState<SettingsState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [snack, setSnack] = React.useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({ open: false, message: '', severity: 'success' });

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const s = await getPortalSettings();
      setSettings(s);
    } catch (err) {
      console.error('Failed to load settings', err);
      setLoadError('We could not load your settings. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // Deferred past the current render so the loading flip never cascades
    // inside the effect body (react-hooks/set-state-in-effect).
    const t = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const set = (key: string, value: string) =>
    setSettings((s) => (s ? ({ ...s, [key]: value } as SettingsState) : s));

  const save = async () => {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const key of ['business_description', 'manager_name', 'phone', 'email', 'other_contact_info', 'address', 'city', 'state', 'postal_code', 'country']) {
        const v = settings?.[key];
        if (v !== undefined) payload[key] = v ?? null;
      }
      await updatePortalSettings(payload);
      setSnack({ open: true, message: 'Settings saved', severity: 'success' });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Save failed';
      setSnack({ open: true, message: msg, severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}><CircularProgress /></Box>;
  }

  if (loadError || !settings) {
    return (
      <Box sx={{ maxWidth: 720 }}>
        <Box sx={{ mb: 3 }}>
          <Typography variant="h4">Settings</Typography>
        </Box>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {loadError ?? 'Settings are unavailable right now.'}
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 720 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4">Settings</Typography>
        <Typography variant="body2" color="text.secondary">
          Your business profile as shown on the rider&rsquo;s SPECIALS screen. Financial fields are managed by NetRide.
        </Typography>
      </Box>

      <Paper sx={{ p: { xs: 2, sm: 3 }, borderRadius: '16px' }}>
        <Grid container spacing={2}>
          <Grid size={12}>
            <TextField label="Business name" value={settings.businessName ?? ''} disabled fullWidth helperText="Contact NetRide to change your business name" />
          </Grid>
          <Grid size={12}>
            <TextField label="Description" value={settings.business_description ?? ''} onChange={(e) => set('business_description', e.target.value)} fullWidth multiline minRows={2} />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField label="Manager name" value={settings.manager_name ?? ''} onChange={(e) => set('manager_name', e.target.value)} fullWidth autoComplete="name" />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField label="Phone" type="tel" value={settings.phone ?? ''} onChange={(e) => set('phone', e.target.value)} fullWidth autoComplete="tel" />
          </Grid>
          <Grid size={12}>
            <TextField label="Email" type="email" value={settings.email ?? ''} onChange={(e) => set('email', e.target.value)} fullWidth autoComplete="email" />
          </Grid>
          <Grid size={12}>
            <TextField label="Other contact info" value={settings.other_contact_info ?? ''} onChange={(e) => set('other_contact_info', e.target.value)} fullWidth />
          </Grid>
          <Grid size={12}>
            <TextField label="Address" value={settings.address ?? ''} onChange={(e) => set('address', e.target.value)} fullWidth autoComplete="street-address" />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <TextField label="City" value={settings.city ?? ''} onChange={(e) => set('city', e.target.value)} fullWidth autoComplete="address-level2" />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField label="State" value={settings.state ?? ''} onChange={(e) => set('state', e.target.value)} fullWidth autoComplete="address-level1" />
          </Grid>
          <Grid size={{ xs: 6, sm: 3 }}>
            <TextField label="Postal code" value={settings.postal_code ?? ''} onChange={(e) => set('postal_code', e.target.value)} fullWidth autoComplete="postal-code" />
          </Grid>
          <Grid size={12}>
            <TextField label="Country" value={settings.country ?? ''} onChange={(e) => set('country', e.target.value)} fullWidth autoComplete="country-name" />
          </Grid>
        </Grid>
        <Stack
          direction="row"
          spacing={2}
          sx={{ mt: 3, alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Button variant="contained" size="large" disabled={saving} onClick={save}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {settings.discount ? (
              <>Your discount: <b>{settings.discount}</b> of the rider&rsquo;s fare</>
            ) : (
              'Discount details are managed by NetRide.'
            )}
          </Typography>
        </Stack>
      </Paper>

      <Snackbar open={snack.open} autoHideDuration={4000} onClose={() => setSnack({ ...snack, open: false })} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Alert severity={snack.severity} variant="filled">{snack.message}</Alert>
      </Snackbar>
    </Box>
  );
};

export default Settings;
