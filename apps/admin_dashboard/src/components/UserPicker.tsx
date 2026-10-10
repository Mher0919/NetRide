import React from 'react';
import { Autocomplete, TextField, Chip, Paper, Typography, Box } from '@mui/material';
import { searchPortalUsers, type PortalUserOption } from '../api/admin';

/**
 * Async user picker for the "use existing user" flow when creating a partner
 * or sponsor — the admin searches the NetRide user base and picks an identity
 * that may already own other portal dashboards (same email = same person).
 */
const UserPicker: React.FC<{
  value: PortalUserOption | null;
  onChange: (user: PortalUserOption | null) => void;
  disabled?: boolean;
  label?: string;
}> = ({ value, onChange, disabled, label = 'Search existing user (name or email)' }) => {
  const [options, setOptions] = React.useState<PortalUserOption[]>([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const query = search.trim();
    const t = window.setTimeout(async () => {
      if (!query) {
        setOptions([]);
        return;
      }
      setLoading(true);
      try {
        const data = await searchPortalUsers(query);
        setOptions(data?.users ?? []);
      } catch {
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [search]);

  return (
    <Autocomplete
      options={options}
      loading={loading}
      disabled={disabled}
      value={value}
      onChange={(_, v) => onChange(v)}
      onInputChange={(_, v) => setSearch(v)}
      getOptionLabel={(o) => (o.full_name ? `${o.full_name} (${o.email})` : o.email)}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      filterOptions={(x) => x}
      renderInput={(params) => (
        <TextField {...params} label={label} placeholder="Type a name or email…" size="small" />
      )}
      renderOption={(props, o) => (
        <Paper
          component="li"
          {...props}
          key={o.id}
          sx={{ borderRadius: 2, mb: 0.25, p: 0.5, cursor: 'pointer' }}
        >
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, width: '100%' }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {o.full_name || '—'} · {o.email}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              <Chip size="small" label={`role: ${o.role}`} sx={{ fontWeight: 700, fontSize: 10 }} />
              {o.is_partner && <Chip size="small" label="Partner" sx={{ bgcolor: '#EDEDFF', color: '#4F46E5', fontWeight: 700, fontSize: 10 }} />}
              {o.is_sponsor && <Chip size="small" label="Sponsor" sx={{ bgcolor: '#E5F0EB', color: '#2E7D32', fontWeight: 700, fontSize: 10 }} />}
              {o.is_fleet && <Chip size="small" label="Fleet" sx={{ bgcolor: '#FFF4E5', color: '#B26A00', fontWeight: 700, fontSize: 10 }} />}
            </Box>
          </Box>
        </Paper>
      )}
      noOptionsText={search.trim() ? 'No users found' : 'Type to search users…'}
      fullWidth
    />
  );
};

export default UserPicker;