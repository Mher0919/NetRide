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

export interface PortalPaymentMethod {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

/** Saved payment methods (non-sensitive metadata) for this sponsor. */
export const listPortalPaymentMethods = async (): Promise<PortalPaymentMethod[]> => {
  const response = await api.get<{ methods: PortalPaymentMethod[] }>('/sponsor/payment-methods');
  return response.data.methods ?? [];
};

/** SetupIntent client secret for the in-dashboard Payment Element. */
export const createPortalSetupIntent = async () => {
  const response = await api.post<{
    setupIntentClientSecret: string;
    customerId: string;
    publishableKey: string | null;
    mode: string;
  }>('/sponsor/payment-method/setup-intent');
  return response.data;
};

export const confirmPortalSetupIntent = async (setupIntentId: string) => {
  const response = await api.post<{ applied: boolean }>('/sponsor/payment-method/setup-intent/confirm', {
    setupIntentId,
  });
  return response.data;
};

export const setPortalDefaultMethod = async (paymentMethodId: string) => {
  const response = await api.post<{ success: boolean }>(`/sponsor/payment-methods/${paymentMethodId}/default`);
  return response.data;
};

export const removePortalPaymentMethod = async (paymentMethodId: string) => {
  const response = await api.delete<{ success: boolean }>(`/sponsor/payment-methods/${paymentMethodId}`);
  return response.data;
};

/** PaymentIntent client secret for the in-dashboard "Add funds" flow. */
export const createPortalFundingIntent = async (amountCents: number, idempotencyKey?: string) => {
  const response = await api.post<{
    paymentRowId: string;
    clientSecret: string;
    paymentIntentId: string;
    publishableKey: string | null;
    mode: string;
  }>('/sponsor/funding/intent', { amountCents, idempotencyKey });
  return response.data;
};

export const confirmPortalFundingIntent = async (paymentRowId: string, paymentIntentId: string) => {
  const response = await api.post<{ status: string; reconciling: boolean }>(
    `/sponsor/funding/intent/${paymentRowId}/confirm`,
    { paymentIntentId },
  );
  return response.data;
};

// ----- Managed card + manual withdrawals -----------------------------------

export interface SponsorWithdrawalState {
  eligible: boolean;
  nextAvailableAt: string;
}

export const getPortalPaymentMethod = async () => {
  const response = await api.get<{
    configured: boolean;
    mode: string;
    card: { brand: string | null; last4: string; expMonth: number | null; expYear: number | null } | null;
  }>('/sponsor/payment-method');
  return response.data;
};

export const createPortalCardSetupSession = async () => {
  const response = await api.post<{ url: string }>('/sponsor/payment-method/card-setup-session');
  return response.data;
};

export const getPortalWithdrawals = async () => {
  const response = await api.get<{
    state: SponsorWithdrawalState;
    withdrawals: Array<{
      id: string;
      amount_cents: number;
      status: string;
      failure_reason: string | null;
      requested_at: string;
      completed_at: string | null;
    }>;
  }>('/sponsor/withdrawals');
  return response.data;
};

export const requestPortalWithdrawal = async (amountCents: number) => {
  const response = await api.post<{
    withdrawal: { id: string; amount_cents: number; status: string; failure_reason: string | null };
    state: SponsorWithdrawalState;
  }>('/sponsor/withdrawals/request', { amountCents });
  return response.data;
};