import React from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PlaceIcon from '@mui/icons-material/Place';
import {
  getNearbyGoogleBusinesses,
  searchGoogleBusinesses,
  type GoogleBusinessSuggestion,
} from '../api/admin';
import { resolveApiUrl } from '../api';

export interface GoogleBusinessSelection {
  placeId: string;
  name: string;
  category: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  photoUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** HMAC token issued by the backend; required when saving a NEW selection. */
  selectionToken: string;
  /** True when hydrated from an existing sponsor (no fresh token). */
  fromExisting?: boolean;
}

interface Props {
  location: { latitude: number | null; longitude: number | null };
  value: GoogleBusinessSelection | null;
  onChange: (value: GoogleBusinessSelection | null) => void;
  disabled?: boolean;
}

function haversineMiles(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lon - a.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(x));
}

const fmtDistance = (miles: number | null | undefined) =>
  miles == null ? null : `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;

const fmtReviews = (count: number | null | undefined) =>
  count == null ? null : count.toLocaleString('en-US');

const suggestionFromSponsor = (sponsor: Record<string, unknown>): GoogleBusinessSelection | null => {
  const placeId = sponsor.google_place_id as string | undefined;
  if (!placeId) return null;
  return {
    placeId,
    name: (sponsor.google_business_name as string) || (sponsor.business_name as string) || 'Business',
    category: (sponsor.google_business_category as string) ?? null,
    address: (sponsor.google_business_address as string) ?? null,
    latitude: sponsor.google_business_latitude != null ? Number(sponsor.google_business_latitude) : null,
    longitude: sponsor.google_business_longitude != null ? Number(sponsor.google_business_longitude) : null,
    photoUrl: null,
    rating: null,
    reviewCount: null,
    selectionToken: '',
    fromExisting: true,
  };
};

export { suggestionFromSponsor };

const BusinessThumb: React.FC<{ photoUrl: string | null; size: number }> = ({ photoUrl, size }) => {
  const url = resolveApiUrl(photoUrl);
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 2,
        bgcolor: '#EFF1EE',
        backgroundImage: url ? `url(${url})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#7A8A7F',
        overflow: 'hidden',
      }}
    >
      {!url && <StorefrontIcon sx={{ fontSize: size * 0.45 }} />}
    </Box>
  );
};

/**
 * Google Business association selector for the Special create/edit dialogs.
 *
 * The admin sets the Special location first; this component then suggests
 * nearby Google businesses, lets the admin search Google Maps, or fall back
 * to a manual (non-Google) business. Selecting a business stores the Google
 * Place ID via a backend-signed selection token — never a raw client value.
 */
const GoogleBusinessSelector: React.FC<Props> = ({ location, value, onChange, disabled = false }) => {
  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [nearby, setNearby] = React.useState<GoogleBusinessSuggestion[]>([]);
  const [searchResults, setSearchResults] = React.useState<GoogleBusinessSuggestion[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [googleDown, setGoogleDown] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [manualMode, setManualMode] = React.useState(false);
  const [mismatchDismissed, setMismatchDismissed] = React.useState(false);
  const lastNearbyKey = React.useRef<string>('');

  const hasLocation =
    location.latitude != null &&
    location.longitude != null &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude);
  const locationKey = hasLocation
    ? `${location.latitude!.toFixed(4)},${location.longitude!.toFixed(4)}`
    : '';

  React.useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => window.clearTimeout(id);
  }, [query]);

  // Location changed → reset transient UI so stale suggestions can't be
  // mistaken for the new location (spec §34).
  React.useEffect(() => {
    lastNearbyKey.current = '';
    setNearby([]);
    setSearchResults(null);
    setError(null);
    setMismatchDismissed(false);
  }, [locationKey]);

  React.useEffect(() => {
    if (!hasLocation || value || manualMode) return;
    if (debouncedQuery.length >= 2) return;
    if (lastNearbyKey.current === locationKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getNearbyGoogleBusinesses({
      lat: location.latitude!,
      lng: location.longitude!,
      limit: 7,
      radius: 2400,
    })
      .then((res) => {
        if (cancelled) return;
        lastNearbyKey.current = locationKey;
        setNearby(res.businesses ?? []);
        setGoogleDown(!res.googleAvailable);
        setError(res.googleAvailable ? null : res.error ?? 'Google business search is temporarily unavailable.');
      })
      .catch(() => {
        if (cancelled) return;
        lastNearbyKey.current = locationKey;
        setGoogleDown(true);
        setError('Google business search is temporarily unavailable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasLocation, location.latitude, location.longitude, locationKey, value, manualMode, debouncedQuery]);

  React.useEffect(() => {
    if (debouncedQuery.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError(null);
    searchGoogleBusinesses({
      q: debouncedQuery,
      lat: location.latitude ?? undefined,
      lng: location.longitude ?? undefined,
    })
      .then((res) => {
        if (cancelled) return;
        setSearchResults(res.businesses ?? []);
        setGoogleDown(!res.googleAvailable);
        setError(res.googleAvailable ? null : res.error ?? 'Google business search is temporarily unavailable.');
      })
      .catch(() => {
        if (cancelled) return;
        setSearchResults([]);
        setGoogleDown(true);
        setError('Google business search is temporarily unavailable.');
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, location.latitude, location.longitude]);

  const mismatch = React.useMemo(() => {
    if (!value || value.latitude == null || value.longitude == null || !hasLocation) return false;
    return (
      haversineMiles(
        { lat: value.latitude, lon: value.longitude },
        { lat: location.latitude!, lon: location.longitude! },
      ) > 1.0
    );
  }, [value, hasLocation, location.latitude, location.longitude]);

  const select = (business: GoogleBusinessSuggestion) => {
    onChange({
      placeId: business.placeId,
      name: business.name,
      category: business.category,
      address: business.address,
      latitude: business.latitude,
      longitude: business.longitude,
      photoUrl: business.photoUrl,
      rating: business.rating,
      reviewCount: business.reviewCount,
      selectionToken: business.selectionToken,
    });
    setMismatchDismissed(false);
  };

  const changeBusiness = () => {
    onChange(null);
    setManualMode(false);
    setQuery('');
    setDebouncedQuery('');
    setMismatchDismissed(false);
    lastNearbyKey.current = '';
  };

  const results = debouncedQuery.length >= 2 ? searchResults ?? [] : nearby;
  const showingSearch = debouncedQuery.length >= 2;
  const loadingResults = showingSearch ? searching : loading;

  return (
    <Box aria-label="Google business association">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
          Google Business
        </Typography>
        {value && (
          <Chip
            size="small"
            icon={<CheckCircleIcon sx={{ fontSize: 14 }} />}
            label="Connected"
            sx={{ bgcolor: '#E5F0EB', color: '#2E7D32', fontWeight: 700, fontSize: 10 }}
          />
        )}
        {!value && manualMode && (
          <Chip size="small" label="Manual" sx={{ bgcolor: '#EEEEEE', color: '#666', fontWeight: 700, fontSize: 10 }} />
        )}
      </Stack>

      {!hasLocation && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Set the Special&apos;s location on the map above to see nearby Google businesses.
        </Typography>
      )}

      {value ? (
        <>
          {mismatch && !mismatchDismissed && (
            <Alert
              severity="warning"
              sx={{ mb: 1.5, borderRadius: 2 }}
              action={
                <Button color="inherit" size="small" onClick={changeBusiness} disabled={disabled}>
                  Select new
                </Button>
              }
              onClose={() => setMismatchDismissed(true)}
            >
              Your selected Google business may no longer match this location. Would you like to select a new
              business?
            </Alert>
          )}
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
            <Box
              sx={{
                height: 120,
                borderRadius: 2,
                mb: 1.5,
                bgcolor: '#EFF1EE',
                backgroundImage: resolveApiUrl(value.photoUrl) ? `url(${resolveApiUrl(value.photoUrl)})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#7A8A7F',
              }}
            >
              {!resolveApiUrl(value.photoUrl) && <StorefrontIcon sx={{ fontSize: 40 }} />}
            </Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
              {value.name}
            </Typography>
            {(value.rating != null || value.reviewCount != null) && (
              <Typography variant="body2" sx={{ color: '#5F6B62', mt: 0.25 }}>
                {value.rating != null ? `★ ${value.rating.toFixed(1)}` : ''}
                {value.rating != null && value.reviewCount != null ? ' · ' : ''}
                {fmtReviews(value.reviewCount) ? `${fmtReviews(value.reviewCount)} reviews` : ''}
              </Typography>
            )}
            {value.category && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {value.category}
              </Typography>
            )}
            {value.address && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {value.address}
              </Typography>
            )}
            <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 1 }}>
              <CheckCircleIcon sx={{ fontSize: 15, color: '#2E7D32' }} />
              <Typography variant="caption" sx={{ color: '#2E7D32', fontWeight: 700 }}>
                Connected to Google Maps
              </Typography>
            </Stack>
            {!value.fromExisting && value.selectionToken && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                Verified Google Place ID · {value.placeId.slice(0, 18)}…
              </Typography>
            )}
            <Button
              size="small"
              onClick={changeBusiness}
              disabled={disabled}
              sx={{ mt: 1, textTransform: 'none', fontWeight: 700 }}
            >
              Change business
            </Button>
          </Paper>
        </>
      ) : manualMode ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <PlaceIcon sx={{ color: 'text.secondary' }} />
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                Manually configured business
              </Typography>
              <Typography variant="caption" color="text.secondary">
                This Special will show your admin-entered information only — no Google Maps link.
              </Typography>
            </Box>
          </Stack>
          <Button
            size="small"
            onClick={() => setManualMode(false)}
            disabled={disabled}
            sx={{ mt: 1, textTransform: 'none', fontWeight: 700 }}
          >
            Connect a Google business
          </Button>
        </Paper>
      ) : (
        <>
          {hasLocation && (
            <TextField
              size="small"
              fullWidth
              placeholder="Search Google Maps"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={disabled}
              inputProps={{ 'aria-label': 'Search Google Maps for a business' }}
              sx={{ mb: 1.5 }}
              InputProps={{
                startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
                endAdornment: searching ? <CircularProgress size={16} /> : null,
              }}
            />
          )}

          {error && (
            <Alert severity={googleDown ? 'warning' : 'error'} sx={{ mb: 1.5, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          {hasLocation && (
            <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 700, color: 'text.secondary' }}>
              {showingSearch ? 'Google Maps results' : 'Businesses near this location'}
            </Typography>
          )}

          {loadingResults ? (
            <Stack spacing={1}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} variant="rounded" height={72} sx={{ borderRadius: 2 }} />
              ))}
            </Stack>
          ) : hasLocation && results.length > 0 ? (
            <Box role="list" aria-label="Google business suggestions">
              <Stack spacing={1}>
                {results.map((b) => (
                  <Box role="listitem" key={b.placeId}>
                    <ButtonBase
                      onClick={() => !disabled && select(b)}
                      disabled={disabled}
                      sx={{
                        width: '100%',
                        textAlign: 'left',
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: 'divider',
                        p: 1.25,
                        display: 'block',
                        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
                      }}
                      aria-label={`Select ${b.name}`}
                    >
                      <Stack direction="row" spacing={1.5} alignItems="center">
                        <BusinessThumb photoUrl={b.photoUrl} size={52} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                            {b.name}
                          </Typography>
                          {(b.rating != null || b.reviewCount != null) && (
                            <Typography variant="caption" sx={{ color: '#5F6B62', display: 'block' }}>
                              {b.rating != null ? `★ ${b.rating.toFixed(1)}` : ''}
                              {b.rating != null && b.reviewCount != null ? ' · ' : ''}
                              {fmtReviews(b.reviewCount) ? `${fmtReviews(b.reviewCount)} reviews` : ''}
                            </Typography>
                          )}
                          {(b.shortAddress || b.address) && (
                            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                              {b.shortAddress ?? b.address}
                            </Typography>
                          )}
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                            {[b.category, fmtDistance(b.distanceMiles)].filter(Boolean).join(' · ')}
                          </Typography>
                        </Box>
                        <Box
                          aria-hidden
                          sx={{
                            px: 1.5,
                            py: 0.5,
                            border: '1px solid',
                            borderColor: 'primary.main',
                            borderRadius: 2,
                            color: 'primary.main',
                            fontWeight: 700,
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          Select
                        </Box>
                      </Stack>
                    </ButtonBase>
                  </Box>
                ))}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                Powered by Google
              </Typography>
            </Box>
          ) : hasLocation && !loadingResults && !error ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', py: 1 }}>
              {showingSearch ? 'No businesses matched that search.' : 'No businesses found near this location.'}{' '}
              Try searching Google Maps or enter the business manually.
            </Typography>
          ) : null}

          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Button
              size="small"
              onClick={() => {
                setManualMode(true);
                setQuery('');
                setDebouncedQuery('');
              }}
              disabled={disabled}
              sx={{ textTransform: 'none', fontWeight: 700 }}
            >
              Enter business manually
            </Button>
          </Stack>
        </>
      )}
    </Box>
  );
};

export default GoogleBusinessSelector;
