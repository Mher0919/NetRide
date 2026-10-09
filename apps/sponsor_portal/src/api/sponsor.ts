import api from './index';

// NOTE: portal authentication (login + email 2FA + password change) is
// handled by the unified portal API (api/portal.ts → /portal/auth/*).
// The legacy /sponsor/auth/* credential endpoints were removed from the
// backend because they bypassed the mandatory 2FA step.

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

// ----- Budget funding (Stripe) ---------------------------------------------

export interface PortalFundingData {
  configured: boolean;
  mode: string;
  budget: {
    initialBudgetCents: number;
    remainingBudgetCents: number;
    reservedBudgetCents: number;
    usedBudgetCents: number;
    spendableBudgetCents: number;
  };
  payments: Array<{
    id: string;
    amount_cents: number;
    currency: string;
    status: string;
    stripe_payment_intent_id: string | null;
    failure_reason: string | null;
    created_at: string;
    succeeded_at: string | null;
  }>;
}

export const getPortalFunding = async () => {
  const response = await api.get<PortalFundingData>('/sponsor/funding');
  return response.data;
};

export const createPortalFundingSession = async (amountCents: number, idempotencyKey?: string) => {
  const response = await api.post<{ url: string; paymentRowId: string }>('/sponsor/funding/session', {
    amountCents,
    idempotencyKey,
  });
  return response.data;
};