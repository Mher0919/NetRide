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
  // Driver cancellation list per the ride-lifecycle spec (§24): concise and
  // operational — what a driver actually needs to express when releasing
  // an accepted ride.
  DRIVER: [
    { code: 'rider_not_at_pickup', label: 'Rider is not at pickup location' },
    { code: 'rider_requested_cancel', label: 'Rider requested cancellation' },
    { code: 'unsafe_pickup', label: 'Unsafe pickup location' },
    { code: 'vehicle_issue', label: 'Vehicle issue' },
    { code: 'emergency', label: 'Emergency' },
    { code: 'unable_to_complete', label: 'Unable to complete the ride' },
    { code: 'rider_behavior', label: 'Rider behavior/problem' },
    { code: 'other', label: 'Other' },
  ],
};

export const REPORT_REASONS: Record<PartyRole, ReasonOption[]> = {
  // A rider reporting their driver (§35).
  RIDER: [
    { code: 'unsafe_behavior', label: 'Unsafe behavior' },
    { code: 'vehicle_mismatch', label: 'Driver/vehicle mismatch' },
    { code: 'driver_asked_cancel', label: 'Driver asked me to cancel' },
    { code: 'driver_not_where_expected', label: 'Driver was not where expected' },
    { code: 'rude_behavior', label: 'Rude/inappropriate behavior' },
    { code: 'other', label: 'Other' },
  ],
  // A driver reporting their rider (§35).
  DRIVER: [
    { code: 'rider_not_at_pickup', label: 'Rider was not at pickup' },
    { code: 'unsafe_behavior', label: 'Unsafe behavior' },
    { code: 'rider_asked_cancel', label: 'Rider asked me to cancel' },
    { code: 'rude_behavior', label: 'Rude/inappropriate behavior' },
    { code: 'false_information', label: 'False information' },
    { code: 'other', label: 'Other' },
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