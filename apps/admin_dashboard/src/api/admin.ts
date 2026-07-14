import api from './index';

export const getAdminStats = async () => {
  const response = await api.get('/admin/stats');
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
