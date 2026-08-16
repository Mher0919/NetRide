import api from './index';

export interface SponsorSession {
  token: string;
  sponsor: {
    id: string;
    businessName: string;
    email: string;
    mustChangePassword: boolean;
  };
}

export const sponsorLogin = async (email: string, password: string) => {
  const response = await api.post<SponsorSession>('/sponsor/auth/login', { email, password });
  return response.data;
};

export const sponsorChangePassword = async (newPassword: string) => {
  const response = await api.post('/sponsor/auth/change-password', { newPassword });
  return response.data;
};

export interface PortalSponsor {
  id: string;
  businessName: string;
  businessType: string;
  status: string;
  discountLabel: string;
  remainingBudgetCents: number;
  usedBudgetCents: number;
}

export const getPortalDashboard = async () => {
  const response = await api.get<{ sponsor: PortalSponsor; stats: { pendingValidations: number; redeemedCount: number; redeemedDiscountCents: number; rewardAmountCents: number } }>('/sponsor/dashboard');
  return response.data;
};

export const listPortalValidations = async (status: string, limit = 50, offset = 0) => {
  const response = await api.get<{ validations: Record<string, unknown>[] }>('/sponsor/validations', { params: { status, limit, offset } });
  return response.data;
};

export const portalValidate = async (code: string, confirmed: boolean) => {
  const response = await api.post('/sponsor/validations/validate', { code, confirmed });
  return response.data;
};

export const portalCancelValidation = async (id: string, reasonCode: string, reasonText: string, confirmed: boolean) => {
  const response = await api.post(`/sponsor/validations/${id}/cancel`, { reasonCode, reasonText, confirmed });
  return response.data;
};

export const listPortalCustomers = async (limit = 50, offset = 0) => {
  const response = await api.get<{ customers: Record<string, unknown>[] }>('/sponsor/customers', { params: { limit, offset } });
  return response.data;
};

export const getPortalSettings = async () => {
  const response = await api.get('/sponsor/settings');
  return response.data;
};

export const updatePortalSettings = async (data: Record<string, unknown>) => {
  const response = await api.patch('/sponsor/settings', data);
  return response.data;
};