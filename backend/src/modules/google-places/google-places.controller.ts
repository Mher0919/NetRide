// backend/src/modules/google-places/google-places.controller.ts
//
// HTTP surface for the Google Places proxy. All Google calls happen
// server-side; the admin/rider clients only ever talk to Netride.
//
//   GET /api/places/nearby?lat&lng&radius&limit   admin — nearby suggestions
//   GET /api/places/text-search?q&lat&lng          admin — "Search Google Maps"
//   GET /api/places/business/:placeId?level=basic  auth  — business details
//   GET /api/places/photo?name&w&sig               public signed photo proxy
//
// Failure semantics: the client degrades gracefully — nearby/search return
// an empty list plus an error code, details return the mapped error so the
// rider sheet can fall back to admin content.

import { Request, Response } from 'express';
import {
  GooglePlacesError,
  GooglePlacesService,
  verifyPhotoSignature,
} from './google-places.service';

function sendError(res: Response, err: unknown) {
  if (err instanceof GooglePlacesError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: 'Google Places request failed.', code: 'GOOGLE_PLACES_ERROR' });
}

export class GooglePlacesController {
  static async nearby(req: Request, res: Response) {
    try {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: 'lat and lng are required.', code: 'INVALID_REQUEST' });
      }
      const radius = req.query.radius != null ? Number(req.query.radius) : undefined;
      const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
      const businesses = await GooglePlacesService.searchNearby(lat, lng, { radiusM: radius, limit });
      res.json({ businesses, googleAvailable: true });
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        // Admin UX: a Google outage must not break the page — return an
        // empty list with the flag so the UI shows its fallback states.
        return res.json({ businesses: [], googleAvailable: false, error: err.message, code: err.code });
      }
      sendError(res, err);
    }
  }

  static async search(req: Request, res: Response) {
    try {
      const q = String(req.query.q ?? '');
      const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
      const lng = req.query.lng != null ? Number(req.query.lng) : undefined;
      const businesses = await GooglePlacesService.searchText(q, lat, lng);
      res.json({ businesses, googleAvailable: true });
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        return res.json({ businesses: [], googleAvailable: false, error: err.message, code: err.code });
      }
      sendError(res, err);
    }
  }

  static async details(req: Request, res: Response) {
    try {
      const level = req.query.level === 'full' ? 'full' : 'basic';
      const business = await GooglePlacesService.getDetails(req.params.placeId, level);
      res.json({ business });
    } catch (err) {
      sendError(res, err);
    }
  }

  static async photo(req: Request, res: Response) {
    try {
      const name = String(req.query.name ?? '');
      const width = Number(req.query.w ?? 800);
      const sig = req.query.sig as string | undefined;
      if (!verifyPhotoSignature(name, Number.isFinite(width) ? Math.round(width) : 800, sig)) {
        return res.status(403).json({ error: 'Invalid photo signature.' });
      }
      const { data, contentType } = await GooglePlacesService.getPhotoMedia(name, width);
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400, immutable');
      return res.send(data);
    } catch (err) {
      if (err instanceof GooglePlacesError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      return res.status(502).json({ error: 'Photo unavailable.' });
    }
  }
}
