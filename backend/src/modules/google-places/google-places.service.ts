// backend/src/modules/google-places/google-places.service.ts
//
// GOOGLE PLACES API (New) — server-side only. The API key never reaches a
// client: the rider/admin apps call Netride, Netride calls Google.
//
//   Google Place ID is the canonical business identifier. Netride persists
//   only the Place ID plus the minimal cached identity fields it needs for
//   fallback display; everything else is fetched from Google on demand and
//   cached within Google's storage rules (Redis, short TTLs).
//
// Architecture:
//   searchNearby()  → places:searchNearby  (admin business suggestions)
//   searchText()    → places:searchText    (admin "Search Google Maps")
//   getDetails()    → places/{id}          (rider sheet + admin verification)
//   getPhotoMedia() → places/{photo}/media (proxied bytes, signed URLs)
//
// Cost control (spec §22/§39): tiered field masks (basic vs full), Redis
// caching, in-flight de-duplication, signed photo proxy URLs so browsers
// cache image bytes instead of re-billing Google.
//
// Selection tokens: every business handed to the admin is wrapped in an
// HMAC-signed token. On save the backend verifies the token instead of
// trusting client-provided Place IDs / coordinates / metadata (spec §24).

import axios from 'axios';
import crypto from 'crypto';
import { redis } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';

export type PlaceLevel = 'basic' | 'full';

export interface GoogleBusinessPhoto {
  name: string;
  width: number | null;
  height: number | null;
  url: string;
  thumbUrl: string;
  attribution: { displayName: string; uri: string | null } | null;
}

export interface GoogleBusinessReview {
  authorName: string;
  authorPhotoUrl: string | null;
  authorUri: string | null;
  rating: number;
  relativeTime: string;
  text: string;
  publishTime: string | null;
}

export interface GoogleBusiness {
  placeId: string;
  name: string;
  category: string | null;
  address: string | null;
  shortAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  businessStatus: string | null;
  googleMapsUri: string | null;
  openNow: boolean | null;
  weekdayDescriptions: string[];
  phone: string | null;
  website: string | null;
  photos: GoogleBusinessPhoto[];
  reviews: GoogleBusinessReview[];
  level: PlaceLevel;
  attribution: string;
}

export interface GoogleBusinessSuggestion {
  placeId: string;
  name: string;
  category: string | null;
  address: string | null;
  shortAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
  reviewCount: number | null;
  distanceMiles: number | null;
  photoUrl: string | null;
  photoAttribution: { displayName: string; uri: string | null } | null;
  selectionToken: string;
}

export interface GoogleSelectionPayload {
  p: string;
  n: string;
  c: string | null;
  a: string | null;
  la: number | null;
  ln: number | null;
}

export class GooglePlacesError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GooglePlacesError';
  }
}

const GOOGLE_PLACES_BASE = 'https://places.googleapis.com/v1/places';
const PHOTO_BASE = 'https://places.googleapis.com/v1';
const ATTRIBUTION = 'Powered by Google';

const NEARBY_CACHE_TTL_S = 600;
const TEXT_CACHE_TTL_S = 600;
const DETAILS_BASIC_TTL_S = 86400;
const DETAILS_FULL_TTL_S = 3600;
const PHOTO_CACHE_TTL_MS = 86400 * 1000;
const PHOTO_CACHE_MAX_ENTRIES = 80;
const SELECTION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

const BASIC_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'shortFormattedAddress',
  'location',
  'types',
  'primaryTypeDisplayName',
  'rating',
  'userRatingCount',
  'photos',
  'googleMapsUri',
  'businessStatus',
  'priceLevel',
].join(',');

const FULL_FIELD_MASK = `${BASIC_FIELD_MASK},internationalPhoneNumber,websiteUri,regularOpeningHours,reviews`;

const SUGGESTION_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.types',
  'places.primaryTypeDisplayName',
  'places.rating',
  'places.userRatingCount',
  'places.photos',
].join(',');

const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

export function isValidPlaceId(placeId: unknown): placeId is string {
  return typeof placeId === 'string' && PLACE_ID_RE.test(placeId.trim());
}

function secretKey(): string {
  return env.JWT_SECRET;
}

function hmac(value: string): string {
  return crypto.createHmac('sha256', secretKey()).update(value).digest('base64url');
}

export function photoSignature(name: string, width: number): string {
  return hmac(`photo:${name}:${width}`).slice(0, 32);
}

export function verifyPhotoSignature(name: string, width: number, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = photoSignature(name, width);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signSelectionToken(
  payload: GoogleSelectionPayload,
  ttlMs: number = SELECTION_TOKEN_TTL_MS,
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + ttlMs }),
  ).toString('base64url');
  return `${body}.${hmac(`selection:${body}`)}`;
}

export function verifySelectionToken(token: unknown): GoogleSelectionPayload | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(`selection:${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.p !== 'string' || !isValidPlaceId(parsed.p)) return null;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    return {
      p: parsed.p,
      n: typeof parsed.n === 'string' ? parsed.n : '',
      c: typeof parsed.c === 'string' ? parsed.c : null,
      a: typeof parsed.a === 'string' ? parsed.a : null,
      la: typeof parsed.la === 'number' && Number.isFinite(parsed.la) ? parsed.la : null,
      ln: typeof parsed.ln === 'number' && Number.isFinite(parsed.ln) ? parsed.ln : null,
    };
  } catch {
    return null;
  }
}

export function haversineMiles(
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

export function formatCategory(raw: any): string | null {
  const display = raw?.primaryTypeDisplayName?.text;
  if (typeof display === 'string' && display.trim()) return display.trim();
  const types: string[] = Array.isArray(raw?.types) ? raw.types : [];
  const skip = new Set(['point_of_interest', 'establishment', 'premise', 'political']);
  const pick = types.find((t) => typeof t === 'string' && !skip.has(t));
  if (!pick) return null;
  return pick.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function priceLevelLabel(raw: any): string | null {
  switch (raw) {
    case 'PRICE_LEVEL_FREE':
      return 'Free';
    case 'PRICE_LEVEL_INEXPENSIVE':
      return '$';
    case 'PRICE_LEVEL_MODERATE':
      return '$$';
    case 'PRICE_LEVEL_EXPENSIVE':
      return '$$$';
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return '$$$$';
    default:
      return null;
  }
}

export function shapePhoto(raw: any): GoogleBusinessPhoto | null {
  const name: string | undefined = raw?.name;
  if (typeof name !== 'string' || !name.startsWith('places/') || !name.includes('/photos/')) {
    return null;
  }
  const width = Number(raw?.widthPx);
  const height = Number(raw?.heightPx);
  const attribution = Array.isArray(raw?.authorAttributions) ? raw.authorAttributions[0] : null;
  const photoUrl = (w: number) =>
    `/api/places/photo?name=${encodeURIComponent(name)}&w=${w}&sig=${photoSignature(name, w)}`;
  return {
    name,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
    url: photoUrl(1200),
    thumbUrl: photoUrl(400),
    attribution:
      attribution && typeof attribution.displayName === 'string'
        ? {
            displayName: attribution.displayName,
            uri: typeof attribution.uri === 'string' ? attribution.uri : null,
          }
        : null,
  };
}

export function shapeReview(raw: any): GoogleBusinessReview | null {
  const author = raw?.authorAttribution ?? {};
  const text = raw?.text?.text ?? raw?.originalText?.text;
  const rating = Number(raw?.rating);
  if (typeof text !== 'string' || !text.trim() || !Number.isFinite(rating)) return null;
  return {
    authorName: typeof author.displayName === 'string' ? author.displayName : 'Google user',
    authorPhotoUrl: typeof author.photoUri === 'string' ? author.photoUri : null,
    authorUri: typeof author.uri === 'string' ? author.uri : null,
    rating,
    relativeTime:
      typeof raw?.relativePublishTimeDescription === 'string'
        ? raw.relativePublishTimeDescription
        : '',
    text: text.trim().slice(0, 1200),
    publishTime: typeof raw?.publishTime === 'string' ? raw.publishTime : null,
  };
}

export function shapeSuggestion(
  raw: any,
  origin?: { lat: number; lon: number } | null,
): GoogleBusinessSuggestion | null {
  if (!isValidPlaceId(raw?.id)) return null;
  const name = raw?.displayName?.text;
  if (typeof name !== 'string' || !name.trim()) return null;
  const lat = Number(raw?.location?.latitude);
  const lng = Number(raw?.location?.longitude);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  const rating = Number(raw?.rating);
  const reviewCount = Number(raw?.userRatingCount);
  const photo = shapePhoto(Array.isArray(raw?.photos) ? raw.photos[0] : null);
  const distanceMiles =
    origin && hasLoc
      ? Math.round(haversineMiles(origin, { lat, lon: lng }) * 10) / 10
      : null;
  const payload: GoogleSelectionPayload = {
    p: raw.id,
    n: name.trim().slice(0, 200),
    c: formatCategory(raw),
    a: typeof raw?.formattedAddress === 'string' ? raw.formattedAddress : null,
    la: hasLoc ? lat : null,
    ln: hasLoc ? lng : null,
  };
  return {
    placeId: raw.id,
    name: payload.n,
    category: payload.c,
    address: payload.a,
    shortAddress:
      typeof raw?.shortFormattedAddress === 'string' ? raw.shortFormattedAddress : null,
    latitude: hasLoc ? lat : null,
    longitude: hasLoc ? lng : null,
    rating: Number.isFinite(rating) ? Math.round(rating * 10) / 10 : null,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
    distanceMiles,
    photoUrl: photo?.thumbUrl ?? null,
    photoAttribution: photo?.attribution ?? null,
    selectionToken: signSelectionToken(payload),
  };
}

export function shapeDetails(raw: any, level: PlaceLevel): GoogleBusiness {
  const placeId = isValidPlaceId(raw?.id) ? raw.id : '';
  const name = raw?.displayName?.text;
  const lat = Number(raw?.location?.latitude);
  const lng = Number(raw?.location?.longitude);
  const rating = Number(raw?.rating);
  const reviewCount = Number(raw?.userRatingCount);
  const hours = raw?.regularOpeningHours ?? {};
  const photos = (Array.isArray(raw?.photos) ? raw.photos : [])
    .map(shapePhoto)
    .filter((p: GoogleBusinessPhoto | null): p is GoogleBusinessPhoto => p !== null)
    .slice(0, level === 'full' ? 8 : 3);
  const reviews =
    level === 'full'
      ? (Array.isArray(raw?.reviews) ? raw.reviews : [])
          .map(shapeReview)
          .filter((r: GoogleBusinessReview | null): r is GoogleBusinessReview => r !== null)
          .slice(0, 5)
      : [];
  return {
    placeId,
    name: typeof name === 'string' && name.trim() ? name.trim() : 'Business',
    category: formatCategory(raw),
    address: typeof raw?.formattedAddress === 'string' ? raw.formattedAddress : null,
    shortAddress:
      typeof raw?.shortFormattedAddress === 'string' ? raw.shortFormattedAddress : null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    rating: Number.isFinite(rating) ? Math.round(rating * 10) / 10 : null,
    reviewCount: Number.isFinite(reviewCount) ? reviewCount : null,
    priceLevel: priceLevelLabel(raw?.priceLevel),
    businessStatus: typeof raw?.businessStatus === 'string' ? raw.businessStatus : null,
    googleMapsUri: typeof raw?.googleMapsUri === 'string' ? raw.googleMapsUri : null,
    openNow: typeof hours?.openNow === 'boolean' ? hours.openNow : null,
    weekdayDescriptions: Array.isArray(hours?.weekdayDescriptions)
      ? hours.weekdayDescriptions.filter((d: unknown) => typeof d === 'string').slice(0, 7)
      : [],
    phone: level === 'full' && typeof raw?.internationalPhoneNumber === 'string'
      ? raw.internationalPhoneNumber
      : null,
    website: level === 'full' && typeof raw?.websiteUri === 'string' ? raw.websiteUri : null,
    photos,
    reviews,
    level,
    attribution: ATTRIBUTION,
  };
}

interface PhotoCacheEntry {
  data: Buffer;
  contentType: string;
  expiresAt: number;
}

export class GooglePlacesService {
  private static inFlight = new Map<string, Promise<unknown>>();
  private static photoCache = new Map<string, PhotoCacheEntry>();

  static get configured(): boolean {
    return Boolean(env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || env.GOOGLE_ROUTES_API_KEY);
  }

  private static get apiKey(): string | undefined {
    return env.GOOGLE_PLACES_API_KEY || env.GOOGLE_MAPS_API_KEY || env.GOOGLE_ROUTES_API_KEY;
  }

  private static requireConfigured(): string {
    const key = this.apiKey;
    if (!key) {
      throw new GooglePlacesError(
        'GOOGLE_PLACES_NOT_CONFIGURED',
        503,
        'Google business information is not configured on this server.',
      );
    }
    return key;
  }

  private static mapError(err: any, fallbackCode: string): GooglePlacesError {
    if (err instanceof GooglePlacesError) return err;
    const status = err?.response?.status;
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
      logger.error({ code: err?.code }, 'google_places_timeout');
      return new GooglePlacesError('GOOGLE_PLACES_TIMEOUT', 504, 'Google Places timed out.');
    }
    if (status === 400) {
      return new GooglePlacesError('INVALID_REQUEST', 400, 'Google Places rejected the request.');
    }
    if (status === 403 || status === 429) {
      logger.error({ status, googleStatus: err?.response?.data?.error?.status }, 'google_places_forbidden');
      return new GooglePlacesError(
        'GOOGLE_PLACES_UNAVAILABLE',
        503,
        'Google business information is currently unavailable.',
      );
    }
    if (!status) {
      logger.error({ err: err?.message }, 'google_places_network_error');
      return new GooglePlacesError(
        'GOOGLE_PLACES_UNAVAILABLE',
        503,
        'Google business information is currently unavailable.',
      );
    }
    logger.error({ status, fallbackCode }, 'google_places_error');
    return new GooglePlacesError('GOOGLE_PLACES_ERROR', 502, 'Google Places request failed.');
  }

  private static async cacheGet<T>(key: string): Promise<T | null> {
    try {
      const raw = await redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private static async cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      // Cache write failure is non-critical.
    }
  }

  private static dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  static async searchNearby(
    lat: number,
    lng: number,
    opts: { radiusM?: number; limit?: number } = {},
  ): Promise<GoogleBusinessSuggestion[]> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new GooglePlacesError('INVALID_REQUEST', 400, 'A valid location is required.');
    }
    const radius = Math.min(Math.max(Math.round(opts.radiusM ?? 1600), 100), 50000);
    const limit = Math.min(Math.max(Math.round(opts.limit ?? 7), 1), 20);
    const key = `gplaces:nearby:${lat.toFixed(3)}:${lng.toFixed(3)}:${radius}:${limit}`;
    const cached = await this.cacheGet<GoogleBusinessSuggestion[]>(key);
    if (cached) return cached;

    return this.dedupe(key, async () => {
      const apiKey = this.requireConfigured();
      try {
        const resp = await axios.post(
          `${GOOGLE_PLACES_BASE}:searchNearby`,
          {
            maxResultCount: limit,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: { center: { latitude: lat, longitude: lng }, radius },
            },
          },
          {
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': SUGGESTION_FIELD_MASK,
            },
            timeout: 6000,
          },
        );
        const origin = { lat, lon: lng };
        const rows = (resp.data?.places ?? [])
          .map((r: any) => shapeSuggestion(r, origin))
          .filter((r: GoogleBusinessSuggestion | null): r is GoogleBusinessSuggestion => r !== null);
        await this.cacheSet(key, rows, NEARBY_CACHE_TTL_S);
        return rows;
      } catch (err) {
        throw this.mapError(err, 'GOOGLE_PLACES_NEARBY_FAILED');
      }
    });
  }

  static async searchText(
    query: string,
    lat?: number,
    lng?: number,
    opts: { limit?: number } = {},
  ): Promise<GoogleBusinessSuggestion[]> {
    const q = (query || '').trim();
    if (q.length < 2 || q.length > 160) {
      throw new GooglePlacesError('INVALID_REQUEST', 400, 'Enter at least 2 characters to search.');
    }
    const limit = Math.min(Math.max(Math.round(opts.limit ?? 7), 1), 20);
    const latKey = Number.isFinite(lat) ? lat!.toFixed(3) : '0';
    const lngKey = Number.isFinite(lng) ? lng!.toFixed(3) : '0';
    const key = `gplaces:text:${q.toLowerCase()}:${latKey}:${lngKey}:${limit}`;
    const cached = await this.cacheGet<GoogleBusinessSuggestion[]>(key);
    if (cached) return cached;

    return this.dedupe(key, async () => {
      const apiKey = this.requireConfigured();
      try {
        const body: Record<string, unknown> = {
          textQuery: q,
          languageCode: 'en',
          maxResultCount: limit,
        };
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          body.locationBias = {
            circle: { center: { latitude: lat, longitude: lng }, radius: 30000 },
          };
        }
        const resp = await axios.post(`${GOOGLE_PLACES_BASE}:searchText`, body, {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': SUGGESTION_FIELD_MASK,
          },
          timeout: 6000,
        });
        const origin = Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat!, lon: lng! } : null;
        const rows = (resp.data?.places ?? [])
          .map((r: any) => shapeSuggestion(r, origin))
          .filter((r: GoogleBusinessSuggestion | null): r is GoogleBusinessSuggestion => r !== null);
        await this.cacheSet(key, rows, TEXT_CACHE_TTL_S);
        return rows;
      } catch (err) {
        throw this.mapError(err, 'GOOGLE_PLACES_SEARCH_FAILED');
      }
    });
  }

  static async getDetails(placeId: string, level: PlaceLevel = 'basic'): Promise<GoogleBusiness> {
    if (!isValidPlaceId(placeId)) {
      throw new GooglePlacesError('INVALID_PLACE_ID', 400, 'Invalid Google Place ID.');
    }
    const safeLevel: PlaceLevel = level === 'full' ? 'full' : 'basic';
    const key = `gplaces:details:${placeId}:${safeLevel}`;
    const cached = await this.cacheGet<GoogleBusiness>(key);
    if (cached) return cached;

    return this.dedupe(key, async () => {
      const apiKey = this.requireConfigured();
      try {
        const resp = await axios.get(
          `${GOOGLE_PLACES_BASE}/${encodeURIComponent(placeId)}`,
          {
            headers: {
              'X-Goog-Api-Key': apiKey,
              'X-Goog-FieldMask': safeLevel === 'full' ? FULL_FIELD_MASK : BASIC_FIELD_MASK,
            },
            timeout: 7000,
          },
        );
        const shaped = shapeDetails(resp.data, safeLevel);
        if (!shaped.placeId) {
          throw new GooglePlacesError('INVALID_PLACE_ID', 404, 'Business not found.');
        }
        await this.cacheSet(
          key,
          shaped,
          safeLevel === 'full' ? DETAILS_FULL_TTL_S : DETAILS_BASIC_TTL_S,
        );
        return shaped;
      } catch (err: any) {
        if (err instanceof GooglePlacesError) throw err;
        if (err?.response?.status === 404) {
          throw new GooglePlacesError('INVALID_PLACE_ID', 404, 'Business not found.');
        }
        throw this.mapError(err, 'GOOGLE_PLACES_DETAILS_FAILED');
      }
    });
  }

  static verifySelectionToken(token: unknown): GoogleSelectionPayload | null {
    return verifySelectionToken(token);
  }

  static async getPhotoMedia(
    name: string,
    width: number,
  ): Promise<{ data: Buffer; contentType: string }> {
    if (
      typeof name !== 'string' ||
      !name.startsWith('places/') ||
      !name.includes('/photos/') ||
      name.length > 400
    ) {
      throw new GooglePlacesError('INVALID_REQUEST', 400, 'Invalid photo reference.');
    }
    const w = Math.min(Math.max(Math.round(width || 800), 100), 1600);
    const key = `${name}:${w}`;
    const cached = this.photoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { data: cached.data, contentType: cached.contentType };
    }

    const apiKey = this.requireConfigured();
    try {
      const resp = await axios.get(`${PHOTO_BASE}/${name}/media`, {
        params: { maxWidthPx: w, key: apiKey },
        responseType: 'arraybuffer',
        timeout: 9000,
      });
      const data = Buffer.from(resp.data);
      const contentType = String(resp.headers?.['content-type'] || 'image/jpeg');
      if (this.photoCache.size >= PHOTO_CACHE_MAX_ENTRIES) {
        const oldest = this.photoCache.keys().next().value;
        if (oldest !== undefined) this.photoCache.delete(oldest);
      }
      this.photoCache.set(key, { data, contentType, expiresAt: Date.now() + PHOTO_CACHE_TTL_MS });
      return { data, contentType };
    } catch (err) {
      throw this.mapError(err, 'GOOGLE_PLACES_PHOTO_FAILED');
    }
  }
}
