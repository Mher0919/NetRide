// apps/sponsor_portal/src/api/portal.ts
// Unified portal API — one login for sponsor / partner / fleet accounts.

import api from './index';

export type PortalType = 'SPONSOR' | 'PARTNER' | 'FLEET';

export interface PortalSession {
  token: string;
  refreshToken: string;
  portal: {
    type: PortalType;
    id: string;
    name: string;
    email: string;
    mustChangePassword: boolean;
  };
}

export const portalLogin = async (email: string, password: string) => {
  const response = await api.post<PortalSession>('/portal/auth/login', { email, password });
  return response.data;
};

export const portalRefresh = async (refreshToken: string) => {
  const response = await api.post<{ token: string; refreshToken: string }>('/portal/auth/refresh', { refreshToken });
  return response.data;
};

export const portalLogout = async (refreshToken: string) => {
  try {
    await api.post('/portal/auth/logout', { refreshToken });
  } catch {
    // Best-effort logout
  }
};

export const portalForgotPassword = async (email: string) => {
  const response = await api.post('/portal/auth/forgot-password', { email });
  return response.data;
};

export const portalVerifyResetOTP = async (email: string, code: string) => {
  const response = await api.post<{ resetToken: string }>('/portal/auth/verify-reset-otp', { email, code });
  return response.data;
};

export const portalResetPassword = async (token: string, newPassword: string) => {
  const response = await api.post('/portal/auth/reset-password', { token, newPassword });
  return response.data;
};

export const portalChangePassword = async (newPassword: string) => {
  const response = await api.post('/portal/auth/change-password', { newPassword });
  return response.data;
};

// ---------------------------------------------------------------------------
// Dashboard (type-aware) + per-type reports
// ---------------------------------------------------------------------------

export interface PortalDashboard {
  type: PortalType;
  // SPONSOR
  sponsor?: {
    id: string;
    businessName: string;
    businessType: string;
    status: string;
    remainingBudgetCents: number;
    usedBudgetCents: number;
  };
  stats?: {
    pendingValidations: number;
    redeemedCount: number;
    redeemedDiscountCents: number;
    rewardAmountCents: number;
    // FLEET
    driverCount?: number;
    completedRides?: number;
    totalRides?: number;
    lifetimeEarningsCents?: number;
    last30dEarningsCents?: number;
  };
  // PARTNER
  partner?: {
    id: string;
    name: string;
    status: string;
    commissionRate: number;
  };
  usage?: { total_uses: number };
  earnings?: {
    lifetimeEarningsCents: number;
    pendingEarningsCents: number;
    paidEarningsCents: number;
  };
  recentCommissions?: Array<{
    id: string;
    ride_id: string;
    promo_code: string | null;
    ride_price_cents: number;
    commission_cents: number;
    commission_rate: number;
    status: string;
    rider_name: string | null;
    created_at: string;
  }>;
  // FLEET
  fleet?: {
    id: string;
    name: string;
    contact_name: string | null;
    contact_email: string | null;
    platformSharePercent: number;
    is_active: boolean;
  };
}

export const portalDashboard = async () => {
  const response = await api.get<PortalDashboard>('/portal/dashboard');
  return response.data;
};

export const portalUsage = async (page = 1, limit = 20) => {
  const response = await api.get('/portal/usage', { params: { page, limit } });
  return response.data as {
    rides: Array<{
      id: string;
      status: string;
      promo_code: string | null;
      final_payment_cents: number;
      fare_amount: number;
      rider_name: string | null;
      created_at: string;
    }>;
    total: number;
    page: number;
    limit: number;
  };
};

export const portalEarnings = async () => {
  const response = await api.get('/portal/earnings');
  return response.data as {
    totals: { totalEarningsCents: number; totalTipCents: number; totalRides: number };
    recent: Array<{
      id: string;
      ride_id: string;
      promo_code: string | null;
      fare_cents: number;
      driver_share_cents: number;
      tip_cents: number;
      status: string;
      completed_at: string;
      rider_name: string | null;
    }>;
  };
};

export const portalCommission = async () => {
  const response = await api.get('/portal/commission');
  return response.data as {
    commission_rate: number;
    commission_type: string;
    lifetimeEarningsCents: number;
    pendingEarningsCents: number;
    paidEarningsCents: number;
  };
};

export const portalFleetDrivers = async () => {
  const response = await api.get('/portal/fleet/drivers');
  return response.data as {
    drivers: Array<{
      id: string;
      full_name: string;
      email: string;
      phone_number: string | null;
      rating: number;
      is_active: boolean;
      total_rides: number | null;
      background_check_status: string | null;
    }>;
  };
};

export const portalFleetRides = async (limit = 20) => {
  const response = await api.get('/portal/fleet/rides', { params: { limit } });
  return response.data as {
    rides: Array<{
      id: string;
      status: string;
      pickup_address: string | null;
      destination_address: string | null;
      completed_at: string | null;
      fleet_earnings_cents: number;
      driver_name: string | null;
    }>;
  };
};