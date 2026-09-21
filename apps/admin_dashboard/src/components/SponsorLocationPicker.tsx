import React, { useCallback, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  Box,
  TextField,
  Button,
  Stack,
  Typography,
  CircularProgress,
  InputAdornment,
  Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';

// Inline SVG pin — no external asset dependency.
const pinIcon = L.divIcon({
  html: `<svg width="34" height="42" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="#4F46E5" stroke="#3730A3" stroke-width="1.5"/>
    <circle cx="12" cy="12" r="5" fill="white"/>
  </svg>`,
  iconSize: [34, 42],
  iconAnchor: [17, 42],
  popupAnchor: [0, -36],
});

const DEFAULT_CENTER: [number, number] = [34.0522, -118.2437];

const ClickHandler: React.FC<{ onPick: (lat: number, lng: number) => void }> = ({ onPick }) => {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
};

const FlyToPin: React.FC<{ position: [number, number] | null }> = ({ position }) => {
  const map = useMap();
  React.useEffect(() => {
    if (position) map.flyTo(position, 15, { duration: 0.6 });
  }, [position, map]);
  return null;
};

export interface SponsorLocation {
  latitude: number | null;
  longitude: number | null;
}

interface Props {
  value: SponsorLocation;
  onChange: (loc: SponsorLocation) => void;
  /** Free-text address used by the "find on map" geocode button. */
  address?: string;
  height?: number;
}

/**
 * Leaflet click-to-pin location picker for sponsor registration.
 * - Click anywhere on the map (or drag the pin) to set the SPECIALS location.
 * - Lat/lng fields are editable directly.
 * - "Find on map" geocodes the address via Nominatim (free, no API key).
 * The coordinates are what the rider app uses to place the map marker.
 */
const SponsorLocationPicker: React.FC<Props> = ({ value, onChange, address = '', height = 300 }) => {
  const [geocoding, setGeocoding] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const latRef = useRef<HTMLInputElement>(null);
  const lngRef = useRef<HTMLInputElement>(null);

  const position: [number, number] | null =
    value.latitude != null && value.longitude != null
      ? [value.latitude, value.longitude]
      : null;

  const handlePick = useCallback(
    (lat: number, lng: number) => onChange({ latitude: lat, longitude: lng }),
    [onChange],
  );

  const handleLatText = (v: string) => {
    const n = v.trim() === '' ? null : Number(v);
    onChange({ latitude: n, longitude: value.longitude });
  };

  const handleLngText = (v: string) => {
    const n = v.trim() === '' ? null : Number(v);
    onChange({ latitude: value.latitude, longitude: n });
  };

  const handleGeocode = async () => {
    if (!address.trim()) {
      setGeoError('Fill in the address first, then use Find on map.');
      return;
    }
    setGeocoding(true);
    setGeoError(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error('Geocoding service unavailable');
      const rows = (await res.json()) as { lat: string; lon: string }[];
      if (rows.length === 0) throw new Error('Address not found');
      onChange({ latitude: Number(rows[0].lat), longitude: Number(rows[0].lon) });
    } catch (err: unknown) {
      setGeoError(err instanceof Error ? err.message : 'Geocoding failed');
    } finally {
      setGeocoding(false);
    }
  };

  const handleClear = () => onChange({ latitude: null, longitude: null });

  return (
    <Box>
      <Box sx={{ position: 'relative', borderRadius: 3, overflow: 'hidden', border: '1px solid', borderColor: 'divider' }}>
        <MapContainer center={position ?? DEFAULT_CENTER} zoom={position ? 15 : 11} style={{ height, width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />
          <ClickHandler onPick={handlePick} />
          {position && (
            <Marker
              position={position}
              icon={pinIcon}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const p = (e.target as L.Marker).getLatLng();
                  handlePick(p.lat, p.lng);
                },
              }}
            />
          )}
          <FlyToPin position={position} />
        </MapContainer>
        <Typography
          variant="caption"
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            bgcolor: 'rgba(255,255,255,0.92)',
            px: 1,
            py: 0.5,
            borderRadius: 1,
            fontWeight: 700,
            fontSize: 11,
            zIndex: 1000,
          }}
        >
          {position ? 'Click the map or drag the pin to set the SPECIALS location' : 'Click the map to set the SPECIALS location'}
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 1.5 }} alignItems="center">
        <TextField
          size="small"
          label="Latitude"
          type="number"
          value={value.latitude ?? ''}
          onChange={(e) => handleLatText(e.target.value)}
          sx={{ width: { xs: '100%', sm: 140 } }}
          inputRef={latRef}
          slotProps={{ input: { endAdornment: <InputAdornment position="end">°</InputAdornment> } }}
        />
        <TextField
          size="small"
          label="Longitude"
          type="number"
          value={value.longitude ?? ''}
          onChange={(e) => handleLngText(e.target.value)}
          sx={{ width: { xs: '100%', sm: 140 } }}
          inputRef={lngRef}
          slotProps={{ input: { endAdornment: <InputAdornment position="end">°</InputAdornment> } }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={geocoding ? <CircularProgress size={14} /> : <SearchIcon />}
          onClick={handleGeocode}
          disabled={geocoding}
        >
          Find on map
        </Button>
        {position && (
          <Tooltip title="Remove the map pin">
            <Button size="small" color="error" startIcon={<ClearIcon />} onClick={handleClear}>
              Clear
            </Button>
          </Tooltip>
        )}
      </Stack>
      {geoError && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {geoError}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        This location places the sponsor&apos;s SPECIALS pin on the rider&apos;s map. A sponsor without a
        location is never shown to riders.
      </Typography>
    </Box>
  );
};

export default SponsorLocationPicker;