import api from './index';

export const getAdminStats = async () => {
  const response = await api.get('/admin/stats');
  return response.data;
};

// ----- Block / unblock ----------------------------------------------------

export const blockUser = async (id: string, reason: string) => {
  const response = await api.patch(`/admin/users/${id}/block`, { reason });
  return response.data;
};

export const unblockUser = async (id: string) => {
  const response = await api.patch(`/admin/users/${id}/unblock`);
  return response.data;
};

export const getRides = async (params: { status?: string, page?: number, limit?: number }) => {
  const response = await api.get('/admin/rides', { params });
  return response.data;
};

export const getRideById = async (id: string) => {
  const response = await api.get(`/admin/rides/${id}`);
  return response.data;
};

export const getRideRoutes = async (id: string) => {
  const response = await api.get(`/admin/rides/${id}/routes`);
  return response.data;
};

export const getRideLedger = async (id: string) => {
  const response = await api.get(`/admin/rides/${id}/ledger`);
  return response.data;
};

export const getLiveDrivers = async () => {
  const response = await api.get('/admin/drivers/live');
  return response.data;
};

export const getUsers = async (params: any) => {
  const response = await api.get('/admin/users', { params });
  return response.data;
};

export const getUserById = async (id: string) => {
  const response = await api.get(`/admin/users/${id}`);
  return response.data;
};

export const getDriverRidePreferences = async (id: string) => {
  const response = await api.get(`/admin/users/${id}/ride-preferences`);
  return response.data;
};

export const verifyUser = async (id: string) => {
  const response = await api.patch(`/admin/users/${id}/verify`);
  return response.data;
};

export const rejectUser = async (id: string, reason: string) => {
  const response = await api.patch(`/admin/users/${id}/reject`, { reason });
  return response.data;
};

export const setPending = async (id: string) => {
  const response = await api.patch(`/admin/users/${id}/pending`);
  return response.data;
};

export const getAuditLogs = async (params: any) => {
  const response = await api.get('/admin/logs', { params });
  return response.data;
};

// ----- Safety / speeding -----------------------------------------------------

export const getSpeedingViolations = async (params?: { dangerousOnly?: boolean; limit?: number }) => {
  const response = await api.get('/admin/speeding/violations', { params });
  return response.data as { violations: any[]; count: number };
};

export const getDriverSpeeding = async (id: string, params?: { limit?: number }) => {
  const response = await api.get(`/admin/users/${id}/speeding`, { params });
  return response.data as { violations: any[]; count: number };
};

export const getDriverEarnings = async (id: string, params?: any) => {
  const response = await api.get(`/admin/users/${id}/earnings`, { params });
  return response.data;
};

export const getDangerousDrivers = async () => {
  const response = await api.get('/admin/drivers/dangerous');
  return response.data as { drivers: any[]; count: number };
};

export const clearDangerousFlag = async (id: string, notes?: string) => {
  const response = await api.patch(`/admin/users/${id}/clear-dangerous`, { notes });
  return response.data;
};

// ----- Driver profile-change approval queue ---------------------------------

export const listProfileChanges = async (status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL' = 'PENDING') => {
  const response = await api.get('/admin/profile-changes', { params: { status } });
  return response.data as { requests: any[]; count: number };
};

export const getProfileChange = async (id: string) => {
  const response = await api.get(`/admin/profile-changes/${id}`);
  return response.data;
};

export const approveProfileChange = async (id: string) => {
  const response = await api.post(`/admin/profile-changes/${id}/approve`);
  return response.data;
};

export const rejectProfileChange = async (id: string, reason: string) => {
  const response = await api.post(`/admin/profile-changes/${id}/reject`, { reason });
  return response.data;
};

// ----- Payout cards ---------------------------------------------------------

export const listPayoutCards = async (status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL' = 'PENDING') => {
  const response = await api.get('/admin/payout-cards', { params: { status } });
  return response.data as { cards: any[]; count: number };
};

export const approvePayoutCard = async (id: string) => {
  const response = await api.post(`/admin/payout-cards/${id}/approve`);
  return response.data;
};

export const rejectPayoutCard = async (id: string, reason: string) => {
  const response = await api.post(`/admin/payout-cards/${id}/reject`, { reason });
  return response.data;
};

/// Fetch the count of pending document reviews from dashboard stats.
export const getPendingDocumentReviewsCount = async () => {
  try {
    const stats = await getAdminStats();
    return (stats as any)?.pendingDocumentReviews ?? 0;
  } catch {
    return 0;
  }
};

// ----- Document resubmission requirements -----------------------------------

export const requestDocumentResubmission = async (driverId: string, documentType: string, reason: string) => {
  const response = await api.post(`/admin/users/${driverId}/request-docs`, { documentType, reason });
  return response.data;
};

export const getDriverDocumentRequirements = async (driverId: string) => {
  const response = await api.get(`/admin/users/${driverId}/document-requirements`);
  return response.data as { requirements: any[] };
};

export const reviewDocumentRequirement = async (requirementId: string, decision: 'approved' | 'rejected') => {
  const response = await api.patch(`/admin/document-requirements/${requirementId}/review`, { decision });
  return response.data;
};

// ----- Vehicle submissions --------------------------------------------------

export const approveVehicleSubmission = async (submissionId: string) => {
  const response = await api.post(`/admin/vehicles/submissions/${submissionId}/approve`);
  return response.data;
};

export const rejectVehicleSubmission = async (submissionId: string, reason: string) => {
  const response = await api.post(`/admin/vehicles/submissions/${submissionId}/reject`, { reason });
  return response.data;
};

export const requestVehicleChanges = async (submissionId: string, reason: string) => {
  const response = await api.post(`/admin/vehicles/submissions/${submissionId}/request-changes`, { reason });
  return response.data;
};

export const requestVehicleResubmission = async (driverId: string, reason: string) => {
  const response = await api.post(`/admin/users/${driverId}/request-vehicle-resubmission`, { reason });
  return response.data;
};

// ----- License management ---------------------------------------------------

export const updateLicense = async (userId: string, data: { license_number?: string; license_expiry_date?: string }) => {
  const response = await api.patch(`/admin/users/${userId}/license`, data);
  return response.data;
};

// ----- Admin image/document management ---------------------------------------

export const uploadUserDocument = async (userId: string, field: string, image: string, mimetype: string) => {
  const response = await api.post(`/admin/users/${userId}/upload-document`, { field, image, mimetype });
  return response.data as { url: string };
};

export const deleteUserDocument = async (userId: string, field: string) => {
  const response = await api.delete(`/admin/users/${userId}/document`, { data: { field } });
  return response.data as { success: boolean };
};

// ----- Payouts --------------------------------------------------------------

export const listPayouts = async (status: 'PENDING' | 'PAID' | 'ALL' = 'PENDING') => {
  const response = await api.get('/admin/payouts', { params: { status } });
  return response.data as { payouts: any[]; count: number };
};

export const markPayoutPaid = async (id: string, reference: string, notes?: string) => {
  const response = await api.post(`/admin/payouts/${id}/mark-paid`, { reference, notes });
  return response.data;
};

// ----- Flagged ride ratings ------------------------------------------------

export const getFlaggedRatings = async (params: { page?: number; limit?: number } = {}) => {
  const response = await api.get('/admin/ratings/flagged', { params });
  return response.data as { ratings: any[]; total: number; page: number; totalPages: number };
};

// ----- Partners ------------------------------------------------------------

export const listPartners = async (params: { search?: string; status?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/partners', { params });
  return response.data as { partners: any[] };
};

export const createPartner = async (data: Record<string, unknown>) => {
  const response = await api.post('/admin/partners', data);
  return response.data;
};

export const getPartner = async (id: string) => {
  const response = await api.get(`/admin/partners/${id}`);
  return response.data;
};

export const updatePartner = async (id: string, data: Record<string, unknown>) => {
  const response = await api.patch(`/admin/partners/${id}`, data);
  return response.data;
};

export const setPartnerStatus = async (id: string, status: string) => {
  const response = await api.post(`/admin/partners/${id}/status/${status}`);
  return response.data;
};

export const getPartnerCommissions = async (id: string, params: { status?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get(`/admin/partners/${id}/commissions`, { params });
  return response.data as { commissions: any[] };
};

export const markCommissionPaid = async (commissionId: string, reference: string) => {
  const response = await api.post(`/admin/partners/commissions/${commissionId}/mark-paid`, { reference });
  return response.data;
};

export const exportPartners = async () => {
  const response = await api.get('/admin/partners/export', { responseType: 'blob' });
  return response.data as Blob;
};

export const exportPartnerRides = async (id: string) => {
  const response = await api.get(`/admin/partners/${id}/rides/export`, { responseType: 'blob' });
  return response.data as Blob;
};

// ----- Promo codes ---------------------------------------------------------

export const listPromos = async (params: { search?: string; partnerId?: string; active?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/promos', { params });
  return response.data as { promos: any[] };
};

export const getPromo = async (id: string) => {
  const response = await api.get(`/admin/promos/${id}`);
  return response.data as { promo: any; usage: any[] };
};

export const createPromo = async (data: Record<string, unknown>) => {
  const response = await api.post('/admin/promos', data);
  return response.data;
};

export const updatePromo = async (id: string, data: Record<string, unknown>) => {
  const response = await api.patch(`/admin/promos/${id}`, data);
  return response.data;
};

export const deletePromo = async (id: string) => {
  const response = await api.delete(`/admin/promos/${id}`);
  return response.data;
};

export const setPromoActive = async (id: string, active: boolean) => {
  const response = await api.post(`/admin/promos/${id}/${active ? 'activate' : 'deactivate'}`);
  return response.data;
};

export const clonePromo = async (id: string) => {
  const response = await api.post(`/admin/promos/${id}/clone`);
  return response.data;
};

// ----- Referrals -----------------------------------------------------------

export const getReferralStats = async () => {
  const response = await api.get('/admin/referrals/stats');
  return response.data;
};

export const listReferrals = async (params: { status?: string; search?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/referrals', { params });
  return response.data as { relationships: any[] };
};

export const listReferralAbuse = async () => {
  const response = await api.get('/admin/referrals/abuse');
  return response.data as { flags: any[] };
};

// ----- Ride credits --------------------------------------------------------

export const listCreditAccounts = async (params: { search?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/credits', { params });
  return response.data as { accounts: any[] };
};

export const grantCredits = async (userId: string, amountCents: number, reason: string) => {
  const response = await api.post('/admin/credits/grant', { user_id: userId, amount_cents: amountCents, reason });
  return response.data;
};

export const listCreditTransactions = async (params: { userId?: string; type?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/credits/transactions', { params });
  return response.data as { transactions: any[] };
};

export const exportCreditTransactions = async () => {
  const response = await api.get('/admin/credits/transactions/export', { responseType: 'blob' });
  return response.data as Blob;
};

// ----- Ledgers -------------------------------------------------------------

export const getCommissionLedger = async (params: { status?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/ledger/commissions', { params });
  return response.data as { commissions: any[] };
};

export const getRewardLedger = async (params: { limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/ledger/rewards', { params });
  return response.data as { transactions: any[] };
};

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ----- Fleet partners (041) -------------------------------------------------

export const listFleets = async () => {
  const response = await api.get('/admin/fleets');
  return response.data as { fleets: any[] };
};

export const createFleet = async (data: Record<string, unknown>) => {
  const response = await api.post('/admin/fleets', data);
  return response.data as { fleet: any };
};

export const updateFleet = async (id: string, data: Record<string, unknown>) => {
  const response = await api.patch(`/admin/fleets/${id}`, data);
  return response.data as { fleet: any };
};

export const assignDriverFleet = async (driverId: string, fleetId: string | null) => {
  const response = await api.patch(`/admin/drivers/${driverId}/fleet`, { fleet_id: fleetId });
  return response.data as { driver_id: string; fleet_id: string | null };
};

// ----- Pricing + revenue (041) ----------------------------------------------

export const listPricingProfiles = async () => {
  const response = await api.get('/admin/pricing');
  return response.data as { profiles: any[] };
};

export const updatePricingProfile = async (code: string, data: Record<string, unknown>) => {
  const response = await api.patch(`/admin/pricing/${code}`, data);
  return response.data as { profile: any };
};

export const getRevenueOverview = async () => {
  const response = await api.get('/admin/revenue');
  return response.data;
};

export const getRevenueAnalytics = async (params?: any) => {
  const response = await api.get('/admin/analytics', { params });
  return response.data;
};

export const getRegions = async () => {
  const response = await api.get('/admin/regions');
  return response.data;
};

export const upsertRegion = async (body: any) => {
  const response = await api.post('/admin/regions', body);
  return response.data;
};

// ----- Ride reports (042) ---------------------------------------------------

export const listReports = async (params: { status?: string; reported_role?: string; q?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/reports', { params });
  return response.data as { total: number; rows: any[] };
};

export const resolveReport = async (id: string, data: { status: string; action: string; admin_notes?: string }) => {
  const response = await api.post(`/admin/reports/${id}/resolve`, data);
  return response.data as any;
};

// ----- Sponsors / SPECIALS (046) -------------------------------------------

export const listSponsors = async (params: { search?: string; status?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/sponsors', { params });
  return response.data as { sponsors: Array<Record<string, unknown>>; total: number };
};

export const createSponsor = async (data: Record<string, unknown>) => {
  const response = await api.post('/admin/sponsors', data);
  return response.data as { sponsor: Record<string, unknown> };
};

export const getSponsor = async (id: string) => {
  const response = await api.get(`/admin/sponsors/${id}`);
  return response.data;
};

export const updateSponsor = async (id: string, data: Record<string, unknown>) => {
  const response = await api.patch(`/admin/sponsors/${id}`, data);
  return response.data as { sponsor: Record<string, unknown> };
};

export const setSponsorStatus = async (id: string, status: string) => {
  const response = await api.post(`/admin/sponsors/${id}/status/${status}`);
  return response.data as { sponsor: Record<string, unknown> };
};

export const adjustSponsorBudget = async (id: string, amountCents: number, reason: string, direction: 'CREDIT' | 'DEBIT' = 'CREDIT') => {
  const response = await api.post(`/admin/sponsors/${id}/budget/adjust`, { amount_cents: amountCents, reason, direction });
  return response.data;
};

export const getSponsorLedger = async (id: string) => {
  const response = await api.get(`/admin/sponsors/${id}/ledger`);
  return response.data as { entries: Array<Record<string, unknown>> };
};

export const getSponsorFinancialHistory = async (id: string) => {
  const response = await api.get(`/admin/sponsors/${id}/financial-history`);
  return response.data as { rows: Array<Record<string, unknown>> };
};

export const getSponsorAnalytics = async (id: string) => {
  const response = await api.get(`/admin/sponsors/${id}/analytics`);
  return response.data;
};

export const listSponsorRedemptions = async (params: { status?: string; limit?: number; offset?: number } = {}) => {
  const response = await api.get('/admin/sponsors/redemptions', { params });
  return response.data as { redemptions: Array<Record<string, unknown>>; total: number };
};

export const createSponsorPortalAccount = async (id: string, email: string) => {
  const response = await api.post(`/admin/sponsors/${id}/portal-account`, { email });
  return response.data;
};

export const resetSponsorPortalPassword = async (id: string) => {
  const response = await api.post(`/admin/sponsors/${id}/portal-account/reset-password`);
  return response.data;
};

export const disableSponsorPortalAccount = async (id: string) => {
  const response = await api.post(`/admin/sponsors/${id}/portal-account/disable`);
  return response.data;
};
