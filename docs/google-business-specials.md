# Google Business Information for SPECIALS

Netride Specials can be linked to a real Google business. The **Google Place
ID** is the canonical external identifier; Google remains the source of truth
for business identity, rating, photos, open hours and reviews, while the
admin-created Special stays the source of truth for the promotion itself.

## Setup

1. In Google Cloud Console, enable **Places API (New)** on the project that
   owns the server key and enable billing.
2. Configure the key (see `backend/.env.example`):
   - `GOOGLE_PLACES_API_KEY` (preferred), falling back to
     `GOOGLE_MAPS_API_KEY`, then `GOOGLE_ROUTES_API_KEY`.
   - Server key restrictions only (IP / none). Never ship a browser, Android
     or iOS key for this feature.
3. Apply the database migration:

   ```bash
   cd backend
   node scripts/run-migrations.cjs 050_special_google_business.sql
   ```

## Architecture

```
Admin selects location
  → GET /api/places/nearby (admin)            ~7 nearby businesses + selection tokens
  → "Search Google Maps" GET /api/places/text-search (admin)
  → select                      → sponsor.google_place_id stored from a signed token
  → save Special                → POST/PATCH /api/admin/sponsors (token verified server-side)

Rider opens a Special
  → GET /api/specials/:id/business?level=basic (identity, rating, photo)
  → GET /api/specials/:id/business?level=full  (hours, phone, website, reviews)
  → photos stream from GET /api/places/photo (signed, cacheable proxy)
```

No Google key is exposed to clients. The client only ever calls Netride.

## Cost & policy controls

- Field masks are tiered: suggestions/`basic` never request the expensive
  Enterprise fields; `full` (hours, phone, website, reviews) loads only when
  the rider expands the bottom sheet.
- Redis caches: nearby/text 10 min per location, basic details 24 h, full
  details 1 h, photo bytes 24 h (in-memory) + `Cache-Control` for browsers.
- In-flight de-duplication prevents duplicate Google calls.
- Only the Place ID (indefinite) and a minimal cached identity
  (name/category/address/coordinates + sync timestamp) are persisted.
  Reviews, hours and photos are never written to the database.
- "Powered by Google" attribution is displayed with photos and reviews, and
  every Google-connected view links back to Google Maps.

## Behavior when Google is unavailable

- Admin: nearby/search return an empty list with `googleAvailable: false`;
  the manual business fallback stays available.
- Rider: the Special still renders; Google-only sections hide and a
  "Business information is currently unavailable." notice is shown.
