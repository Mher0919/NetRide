# NetRide Admin Dashboard

A production-grade admin dashboard for managing Riders and Drivers verification and monitoring platform activity.

## Features
- **Secure Auth**: Admin-only login with JWT.
- **User Management**: View, Search, and Filter Riders and Drivers.
- **Verification Workflow**: Manual approval/rejection of user documents.
- **Audit Logs**: Track every admin action for accountability.
- **Dashboard Analytics**: Real-time stats on user distribution.

## Tech Stack
- **Frontend**: React, TypeScript, Vite, MUI (Material UI), Recharts.
- **Backend**: Node.js, Express, Prisma, PostgreSQL (Shared with NetRide backend).

## Getting Started

### Prerequisites
- Node.js installed.
- Backend server running (default: http://localhost:3000).

### Installation
1. Navigate to the admin dashboard directory:
   ```bash
   cd apps/admin_dashboard
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (optional, defaults to localhost:3000):
   Create a `.env` file:
   ```
   VITE_API_URL=http://localhost:3000
   ```

### Running the App
```bash
npm run dev
```

### Credentials
Use the following credentials for testing (seeded via `backend/src/scripts/seed-admin.ts`):
- **Email**: admin@netride.com
- **Password**: AdminPassword123!
