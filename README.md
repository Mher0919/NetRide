# NetRide

Ride-hailing platform: two Flutter apps, an Express/TypeScript backend, and two
web dashboards.

## Repository layout

| Path | What it is |
|---|---|
| `apps/rider_flutter/` | Rider mobile app (Flutter) |
| `apps/driver_flutter/` | Driver mobile app (Flutter) |
| `apps/admin_dashboard/` | Admin dashboard (React + Vite) |
| `apps/sponsor_portal/` | Unified partner/sponsor portal (React + Vite) |
| `backend/` | REST + Socket.IO API (Node 24, TypeScript, Prisma/Postgres, Redis, Stripe) |
| `tests/` | All testing infrastructure — see [tests/README.md](tests/README.md) |
| `docs/` | Product/operations documentation |

## Quick start

```bash
# Backend
cd backend && npm install && npm run dev      # http://localhost:3000

# Dashboards
cd apps/admin_dashboard && npm install && npm run dev
cd apps/sponsor_portal  && npm install && npm run dev

# Mobile apps
cd apps/rider_flutter  && flutter pub get && flutter run
cd apps/driver_flutter && flutter pub get && flutter run
```

## Testing

All testing docs, scripts, fixtures, and guides live in
[`tests/`](tests/README.md). The short version:

```bash
cd backend && npm test                  # backend unit suites (offline)
cd apps/rider_flutter  && flutter test  # rider app tests
cd apps/driver_flutter && flutter test  # driver app tests
```

## Deployment

- `render.yaml` — backend, admin dashboard, sponsor portal (Render)
- `codemagic.yaml` — Flutter app builds (Codemagic)
- `docker-compose.yml` / `docker-compose.override.yml` — local stack
