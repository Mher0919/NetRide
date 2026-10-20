import React from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Paper,
  Rating,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import StorefrontIcon from '@mui/icons-material/Storefront';
import PlaceIcon from '@mui/icons-material/Place';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  getGoogleBusinessDetails,
  getNearbyGoogleBusinesses,
  searchGoogleBusinesses,
  type GoogleBusinessDetails,
  type GoogleBusinessSuggestion,
} from '../api/admin';
import { resolveApiUrl } from '../api';

export interface GoogleBusinessSelection {
  placeId: string;
  name: string;
  category: string | null;
  address: string | null;
  shortAddress?: string | null;
  latitude: number | null;
  longitude: number | null;
  photoUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
  /** HMAC token issued by the backend; required when saving a NEW selection. */
  selectionToken: string;
  /** True when hydrated from an existing sponsor (no fresh token). */
  fromExisting?: boolean;
  /** Full Places details loaded after the business was selected. */
  details?: GoogleBusinessDetails | null;
  detailsLoaded?: boolean;
}

interface Props {
  location: { latitude: number | null; longitude: number | null };
  /** Free-text location (address/city/region) used when no map pin is set. */
  locationText?: string;
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

/** Fold the full Places response into the selection used by the form. */
function withGoogleDetails(
  base: GoogleBusinessSelection,
  details: GoogleBusinessDetails,
): GoogleBusinessSelection {
  return {
    ...base,
    name: details.name || base.name,
    category: details.category ?? base.category,
    address: details.address ?? base.address,
    shortAddress: details.shortAddress ?? base.shortAddress ?? null,
    latitude: details.latitude ?? base.latitude,
    longitude: details.longitude ?? base.longitude,
    photoUrl: details.photos[0]?.thumbUrl ?? details.photos[0]?.url ?? base.photoUrl,
    rating: details.rating ?? base.rating,
    reviewCount: details.reviewCount ?? base.reviewCount,
    details,
    detailsLoaded: true,
  };
}

const errorMessage = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

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
const GoogleBusinessSelector: React.FC<Props> = ({ location, locationText = '', value, onChange, disabled = false }) => {
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
  const [detailsLoading, setDetailsLoading] = React.useState(false);
  const [detailsError, setDetailsError] = React.useState<string | null>(null);
  const [connectingPlaceId, setConnectingPlaceId] = React.useState<string | null>(null);
  const lastNearbyKey = React.useRef<string>('');
  const detailsLoadedFor = React.useRef('');
  const detailsSeq = React.useRef(0);
  const onChangeRef = React.useRef(onChange);
  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
      // A typed location (no map pin) is sent as free text and folded into
      // the text query server-side — never silently dropped.
      ...(!hasLocation && locationText.trim() ? { location: locationText.trim() } : {}),
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
  }, [debouncedQuery, location.latitude, location.longitude, hasLocation, locationText]);

  const mismatch = React.useMemo(() => {
    if (!value || value.latitude == null || value.longitude == null || !hasLocation) return false;
    return (
      haversineMiles(
        { lat: value.latitude, lon: value.longitude },
        { lat: location.latitude!, lon: location.longitude! },
      ) > 1.0
    );
  }, [value, hasLocation, location.latitude, location.longitude]);

  /**
   * Load the full Places record (hours, phone, website, photos and reviews)
   * immediately after a business is connected. The form receives the enriched
   * selection so its fields can be autofilled from Google.
   *
   * On failure the basic suggestion is still selected — the connection stays
   * valid and the admin can retry the optional details.
   */
  const loadDetails = React.useCallback(async (base: GoogleBusinessSelection) => {
    const seq = ++detailsSeq.current;
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const res = await getGoogleBusinessDetails(base.placeId, 'full');
      if (seq !== detailsSeq.current) return;
      detailsLoadedFor.current = base.placeId;
      onChangeRef.current(withGoogleDetails(base, res.business));
    } catch (err) {
      if (seq !== detailsSeq.current) return;
      detailsLoadedFor.current = base.placeId;
      setDetailsError(
        errorMessage(
          err,
          'Connected to Google, but ratings, photos and reviews could not be loaded.',
        ),
      );
      onChangeRef.current(base);
    } finally {
      if (seq === detailsSeq.current) setDetailsLoading(false);
    }
  }, []);

  // Hydrate an existing connection (edit dialog) so reviews/photos are shown
  // without marking the Google association as changed.
  React.useEffect(() => {
    const placeId = value?.placeId;
    if (!placeId || value?.detailsLoaded) return;
    if (detailsLoadedFor.current === placeId) return;
    detailsLoadedFor.current = placeId;
    void loadDetails(value!);
  }, [value, loadDetails]);

  const select = (business: GoogleBusinessSuggestion) => {
    if (disabled || connectingPlaceId) return;
    const base: GoogleBusinessSelection = {
      placeId: business.placeId,
      name: business.name,
      category: business.category,
      address: business.address,
      shortAddress: business.shortAddress,
      latitude: business.latitude,
      longitude: business.longitude,
      photoUrl: business.photoUrl,
      rating: business.rating,
      reviewCount: business.reviewCount,
      selectionToken: business.selectionToken,
    };
    setMismatchDismissed(false);
    setConnectingPlaceId(business.placeId);
    void loadDetails(base).finally(() => setConnectingPlaceId(null));
  };

  const retryDetails = () => {
    if (!value) return;
    detailsLoadedFor.current = '';
    void loadDetails(value);
  };

  const changeBusiness = () => {
    onChange(null);
    setManualMode(false);
    setQuery('');
    setDebouncedQuery('');
    setMismatchDismissed(false);
    setDetailsError(null);
    detailsLoadedFor.current = '';
    detailsSeq.current += 1;
    lastNearbyKey.current = '';
  };

  const results = debouncedQuery.length >= 2 ? searchResults ?? [] : nearby;
  const showingSearch = debouncedQuery.length >= 2;
  const loadingResults = showingSearch ? searching : loading;
  const details = value?.details ?? null;
  const googleMapsUrl =
    details?.googleMapsUri ??
    (value?.placeId ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(value.placeId)}` : null);

  return (
    <Box aria-label="Google business association">
      <Stack direction="row" spacing={1} sx={{ mb: 0.5, alignItems: 'center' }}>
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
          Type a business name{locationText.trim() ? ' — results are ranked around the address you entered' : ' to search Google Maps'}. Set a map pin to also see nearby businesses.
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
              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                {value.rating != null && (
                  <Rating
                    value={value.rating}
                    precision={0.1}
                    readOnly
                    size="small"
                    sx={{ color: '#E8A33D' }}
                    aria-label={`Google rating ${value.rating.toFixed(1)} out of 5`}
                  />
                )}
                {value.rating != null && (
                  <Typography variant="body2" sx={{ color: '#5F6B62', fontWeight: 700 }}>
                    {value.rating.toFixed(1)}
                  </Typography>
                )}
                {value.reviewCount != null && (
                  <Typography variant="body2" sx={{ color: '#5F6B62' }}>
                    · {fmtReviews(value.reviewCount)} reviews
                  </Typography>
                )}
              </Stack>
            )}
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.75, flexWrap: 'wrap', gap: 0.75 }}>
              {value.category && (
                <Chip size="small" label={value.category} sx={{ fontWeight: 700, fontSize: 10 }} />
              )}
              {details?.priceLevel && (
                <Chip
                  size="small"
                  label={`Price ${details.priceLevel}`}
                  sx={{ bgcolor: '#EDEDFF', color: '#4F46E5', fontWeight: 700, fontSize: 10 }}
                />
              )}
              {details?.priceRange && (
                <Chip
                  size="small"
                  label={details.priceRange}
                  sx={{ bgcolor: '#EDEDFF', color: '#4F46E5', fontWeight: 700, fontSize: 10 }}
                />
              )}
              {details?.openNow != null && (
                <Chip
                  size="small"
                  label={details.openNow ? 'Open now' : 'Closed now'}
                  sx={{
                    bgcolor: details.openNow ? '#E5F0EB' : '#EEEEEE',
                    color: details.openNow ? '#2E7D32' : '#666',
                    fontWeight: 700,
                    fontSize: 10,
                  }}
                />
              )}
              {details?.businessStatus === 'CLOSED_PERMANENTLY' && (
                <Chip size="small" label="Permanently closed" sx={{ bgcolor: '#FCE9E9', color: '#C65A5A', fontWeight: 700, fontSize: 10 }} />
              )}
            </Stack>
            {value.address && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {value.address}
              </Typography>
            )}
            {(details?.phone || details?.website) && (
              <Stack direction="row" spacing={1.5} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
                {details?.phone && (
                  <Typography variant="caption" color="text.secondary">{details.phone}</Typography>
                )}
                {details?.website && (
                  <Link
                    href={details.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="hover"
                    variant="caption"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}
                  >
                    Website <OpenInNewIcon sx={{ fontSize: 12 }} />
                  </Link>
                )}
              </Stack>
            )}
            {details?.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontSize: 13 }}>
                {details.description}
              </Typography>
            )}

            {detailsLoading && !value.detailsLoaded && (
              <Stack direction="row" spacing={1} sx={{ mt: 1.25, alignItems: 'center' }}>
                <CircularProgress size={14} />
                <Typography variant="caption" color="text.secondary">
                  Loading ratings, photos and reviews from Google…
                </Typography>
              </Stack>
            )}

            {detailsError && (
              <Alert
                severity="warning"
                sx={{ mt: 1.25, borderRadius: 2 }}
                action={
                  <Button color="inherit" size="small" onClick={retryDetails} disabled={disabled || detailsLoading}>
                    Retry
                  </Button>
                }
              >
                {detailsError}
              </Alert>
            )}

            {details && details.photos.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                  Photos from Google
                </Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                  {details.photos.map((photo) => (
                    <Tooltip
                      key={photo.name}
                      title={photo.attribution?.displayName ? `Photo by ${photo.attribution.displayName}` : 'Business photo'}
                    >
                      <Box
                        component="img"
                        src={resolveApiUrl(photo.thumbUrl || photo.url) ?? undefined}
                        alt={photo.attribution?.displayName ? `Business photo by ${photo.attribution.displayName}` : 'Business photo'}
                        sx={{
                          width: 88,
                          height: 66,
                          objectFit: 'cover',
                          borderRadius: 2,
                          border: '1px solid',
                          borderColor: 'divider',
                        }}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              </Box>
            )}

            {details && details.reviews.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
                  <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                    Google reviews
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Powered by Google</Typography>
                </Stack>
                <Stack spacing={1} sx={{ mt: 0.75 }}>
                  {details.reviews.map((review, index) => (
                    <Paper
                      key={`${review.authorName}-${index}`}
                      variant="outlined"
                      sx={{ p: 1.25, borderRadius: 2 }}
                    >
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', gap: 0.75 }}>
                        <Avatar
                          src={review.authorPhotoUrl ?? undefined}
                          sx={{ width: 24, height: 24, fontSize: 11, bgcolor: '#E5F0EB', color: '#2E7D32' }}
                        >
                          {review.authorName?.[0]?.toUpperCase() ?? 'G'}
                        </Avatar>
                        <Typography variant="caption" sx={{ fontWeight: 700 }}>
                          {review.authorName}
                        </Typography>
                        {review.relativeTime && (
                          <Typography variant="caption" color="text.secondary">
                            · {review.relativeTime}
                          </Typography>
                        )}
                        <Rating
                          value={review.rating}
                          readOnly
                          size="small"
                          sx={{ ml: 'auto', color: '#E8A33D', fontSize: 14 }}
                        />
                      </Stack>
                      <Typography
                        variant="body2"
                        sx={{
                          mt: 0.5,
                          fontSize: 13,
                          display: '-webkit-box',
                          WebkitLineClamp: 4,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {review.text}
                      </Typography>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}

            <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <CheckCircleIcon sx={{ fontSize: 15, color: '#2E7D32' }} />
              <Typography variant="caption" sx={{ color: '#2E7D32', fontWeight: 700 }}>
                Connected to Google Maps
              </Typography>
              {googleMapsUrl && (
                <Link
                  href={googleMapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  variant="caption"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}
                >
                  View on Google Maps <OpenInNewIcon sx={{ fontSize: 12 }} />
                </Link>
              )}
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
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
          <TextField
            size="small"
            fullWidth
            placeholder="Search Google Maps"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            slotProps={{
              htmlInput: { 'aria-label': 'Search Google Maps for a business' },
              input: {
                startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />,
                endAdornment: searching ? <CircularProgress size={16} /> : null,
              },
            }}
            sx={{ mb: 1.5 }}
          />

          {error && (
            <Alert severity={googleDown ? 'warning' : 'error'} sx={{ mb: 1.5, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 700, color: 'text.secondary' }}>
            {showingSearch
              ? 'Google Maps results'
              : hasLocation
                ? 'Businesses near this location'
                : 'Search a business name above'}
          </Typography>

          {loadingResults ? (
            <Stack spacing={1}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} variant="rounded" height={72} sx={{ borderRadius: 2 }} />
              ))}
            </Stack>
          ) : results.length > 0 ? (
            <Box role="list" aria-label="Google business suggestions">
              <Stack spacing={1}>
                {results.map((b) => (
                  <Box role="listitem" key={b.placeId}>
                    <ButtonBase
                      onClick={() => select(b)}
                      disabled={disabled || !!connectingPlaceId}
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
                      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                        <BusinessThumb photoUrl={b.photoUrl} size={52} />
                        <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                          <Tooltip title={b.name}>
                            <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                              {b.name}
                            </Typography>
                          </Tooltip>
                          {(b.rating != null || b.reviewCount != null) && (
                            <Typography variant="caption" sx={{ color: '#5F6B62', display: 'block' }}>
                              {b.rating != null ? `★ ${b.rating.toFixed(1)}` : ''}
                              {b.rating != null && b.reviewCount != null ? ' · ' : ''}
                              {fmtReviews(b.reviewCount) ? `${fmtReviews(b.reviewCount)} reviews` : ''}
                            </Typography>
                          )}
                          {(b.shortAddress || b.address) && (
                            <Tooltip title={b.shortAddress ?? b.address ?? ''}>
                              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                                {b.shortAddress ?? b.address}
                              </Typography>
                            </Tooltip>
                          )}
                          <Tooltip title={[b.category, fmtDistance(b.distanceMiles)].filter(Boolean).join(' · ')}>
                            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                              {[b.category, fmtDistance(b.distanceMiles)].filter(Boolean).join(' · ')}
                            </Typography>
                          </Tooltip>
                        </Box>
                        <Box
                          aria-hidden
                          sx={{
                            px: 1.5,
                            py: 0.5,
                            minWidth: 64,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: '1px solid',
                            borderColor: 'primary.main',
                            borderRadius: 2,
                            color: 'primary.main',
                            fontWeight: 700,
                            fontSize: 12,
                            flexShrink: 0,
                          }}
                        >
                          {connectingPlaceId === b.placeId ? <CircularProgress size={14} /> : 'Select'}
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
          ) : (showingSearch || hasLocation) && !loadingResults && !error ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', py: 1 }}>
              {showingSearch ? 'No businesses matched that search.' : 'No businesses found near this location.'}{' '}
              Try a different search or enter the business manually.
            </Typography>
          ) : null}

          <Divider sx={{ my: 1.5 }} />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
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
