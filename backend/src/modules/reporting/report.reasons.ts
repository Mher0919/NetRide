// backend/src/modules/reporting/report.reasons.ts
//
// Single source of truth for the machine-readable reason codes used by:
//   - required cancellation reasons (rides.cancellation_reason_code)
//   - post-cancellation / post-ride party reports (ride_reports.reason_code)
//
// Cancellation lists are keyed by the CANCELLER's role. Report lists are
// keyed by the REPORTER's role because a report is always filed against the
// OTHER party (a rider reports a driver, a driver reports a rider).

export interface ReasonOption {
  code: string;
  label: string;
}

export type PartyRole = 'RIDER' | 'DRIVER';

export const CANCELLATION_REASONS: Record<PartyRole, ReasonOption[]> = {
  RIDER: [
    { code: 'driver_took_too_long', label: 'Driver took too long to arrive' },
    { code: 'wrong_pickup', label: 'Wrong pickup location' },
    { code: 'driver_unprofessional', label: 'Driver was unprofessional' },
    { code: 'emergency', label: 'Emergency' },
    { code: 'changed_plans', label: 'I changed my plans' },
    { code: 'other', label: 'Another reason' },
  ],
  DRIVER: [
    { code: 'vehicle_issue', label: 'Vehicle issue' },
    { code: 'too_far_pickup', label: 'Pickup is too far away' },
    { code: 'personal_emergency', label: 'Personal emergency' },
    { code: 'unruly_rider', label: 'Rider was unruly' },
    { code: 'other', label: 'Another reason' },
  ],
};

export const REPORT_REASONS: Record<PartyRole, ReasonOption[]> = {
  // A rider reporting their driver.
  RIDER: [
    { code: 'unsafe_driving', label: 'Unsafe or reckless driving' },
    { code: 'vehicle_mismatch', label: 'Vehicle did not match the app' },
    { code: 'unprofessional_behavior', label: 'Unprofessional behavior' },
    { code: 'discriminatory_behavior', label: 'Discriminatory behavior' },
    { code: 'unsanitary_vehicle', label: 'Unsanitary vehicle' },
    { code: 'other', label: 'Something else' },
  ],
  // A driver reporting their rider.
  DRIVER: [
    { code: 'unruly_behavior', label: 'Unruly or disrespectful behavior' },
    { code: 'unsafe_behavior', label: 'Unsafe behavior in the vehicle' },
    { code: 'unsanitary_behavior', label: 'Unsanitary behavior' },
    { code: 'discriminatory_behavior', label: 'Discriminatory behavior' },
    { code: 'damage_to_vehicle', label: 'Damage to the vehicle' },
    { code: 'other', label: 'Something else' },
  ],
};

export function isCancellationReasonValid(role: PartyRole, code: string): boolean {
  return CANCELLATION_REASONS[role].some((o) => o.code === code);
}

export function isReportReasonValid(role: PartyRole, code: string): boolean {
  return REPORT_REASONS[role].some((o) => o.code === code);
}

export function cancellationReasonLabel(role: PartyRole, code: string): string {
  return (
    CANCELLATION_REASONS[role].find((o) => o.code === code)?.label ?? code
  );
}

export function reportReasonLabel(role: PartyRole, code: string): string {
  return REPORT_REASONS[role].find((o) => o.code === code)?.label ?? code;
}