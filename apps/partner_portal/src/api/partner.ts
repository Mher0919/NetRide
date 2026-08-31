import api from './index';

export interface PartnerSession {
  token: string;
  refreshToken: string;
  partner: {
    id: string;
    email: string;
  };
}

export const partnerLogin = async (email: string, password: string) => {
  const response = await api.post<PartnerSession>('/partner/auth/login', { email, password });
  return response.data;
};

export const partnerRefresh = async (refreshToken: string) => {
  const response = await api.post<{ token: string; refreshToken: string }>('/partner/auth/refresh', { refreshToken });
  return response.data;
};

export const partnerLogout = async (refreshToken: string) => {
  try {
    await api.post('/partner/auth/logout', { refreshToken });
  } catch {
    // Best-effort logout
  }
};

export const partnerForgotPassword = async (email: string) => {
  const response = await api.post('/partner/auth/forgot-password', { email });
  return response.data;
};

export const partnerVerifyResetOTP = async (email: string, code: string) => {
  const response = await api.post<{ resetToken: string }>('/partner/auth/verify-reset-otp', { email, code });
  return response.data;
};

export const partnerResetPassword = async (resetToken: string, newPassword: string) => {
  const response = await api.post('/partner/auth/reset-password', { resetToken, newPassword });
  return response.data;
};

export const partnerChangePassword = async (newPassword: string) => {
  const response = await api.post('/partner/auth/change-password', { newPassword });
  return response.data;
};

export interface PartnerDashboardData {
  partner: {
    id: string;
    name: string;
    email: string;
    status: string;
  };
  usage: {
    total_uses: number;
    recent_rides: Array<{
      id: string;
      status: string;
      promo_code: string | null;
      rider_name: string | null;
      created_at: string;
    }>;
    total: number;
  };
  earnings: {
    total_earnings_cents: number;
    total_tip_cents: number;
    total_rides: number;
    recent_earnings: Array<{
      ride_id: string;
      promo_code: string | null;
      fare_cents: number;
      final_payment_cents: number;
      earnings_cents: number;
      completed_at: string;
    }>;
  };
  commission: {
    commission_rate: number;
    commission_type: string;
    lifetime_earnings_cents: number;
    pending_earnings_cents: number;
    paid_earnings_cents: number;
  };
}

export const partnerDashboard = async (): Promise<PartnerDashboardData> => {
  const response = await api.get<PartnerDashboardData>('/partner/dashboard');
  return response.data;
};

export const partnerUsage = async (params: { page?: number; limit?: number }) => {
  const response = await api.get<{ rides: any[]; total: number }>('/partner/usage', { params });
  return response.data;
};

export const partnerEarnings = async (params: { page?: number; limit?: number }) => {
  const response = await api.get<{
    total_earnings_cents: number;
    total_tip_cents: number;
    total_rides: number;
    recent_earnings: any[];
  }>('/partner/earnings', { params });
  return response.data;
};

export const partnerCommission = async () => {
  const response = await api.get('/partner/commission');
  return response.data;
};