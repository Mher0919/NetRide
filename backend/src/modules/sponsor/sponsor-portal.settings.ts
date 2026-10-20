// backend/src/modules/sponsor/sponsor-portal.settings.ts
//
// SPONSOR (COLAB) SETTINGS POLICY — the single source of truth for which
// profile fields a sponsor portal identity may change on its own account.
//
// NetRide admin owns the rider-facing business identity (name, type and the
// business DESCRIPTION shown on SPECIALS). Sponsors may only maintain their
// operational contact/address details. The restriction is enforced here —
// in the server — not just by disabling inputs in the portal UI, so a custom
// API client can never mutate admin-owned fields.

/** Fields a sponsor portal identity may update. */
export const SPONSOR_PORTAL_EDITABLE_FIELDS = [
  'manager_name',
  'phone',
  'email',
  'other_contact_info',
  'address',
  'city',
  'state',
  'postal_code',
  'country',
] as const;

/**
 * Rider-facing identity fields reserved to NetRide admin. Both wire casing
 * variants are rejected so no client shape can sneak past the guard.
 */
export const SPONSOR_PORTAL_ADMIN_ONLY_FIELDS = [
  'business_name',
  'businessName',
  'business_type',
  'businessType',
  'business_description',
  'businessDescription',
] as const;

export class SponsorPortalFieldForbiddenError extends Error {
  readonly code = 'SPONSOR_FIELD_FORBIDDEN';
  constructor(readonly field: string) {
    super(`"${field}" is managed by NetRide and can only be changed by an admin.`);
    this.name = 'SponsorPortalFieldForbiddenError';
  }
}

/**
 * Builds the whitelisted settings patch for a sponsor-portal PATCH.
 *
 * A forbidden field is REJECTED (not silently dropped): silently ignoring it
 * would let the caller believe the description was saved. Unknown fields are
 * still ignored (forward compatibility), while allowed fields pass through
 * untouched for SponsorService to validate/normalize.
 */
export function buildSponsorPortalSettingsPatch(
  body: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const input = body ?? {};
  for (const field of SPONSOR_PORTAL_ADMIN_ONLY_FIELDS) {
    if (input[field] !== undefined) {
      throw new SponsorPortalFieldForbiddenError(field);
    }
  }
  const patch: Record<string, unknown> = {};
  for (const key of SPONSOR_PORTAL_EDITABLE_FIELDS) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return patch;
}
