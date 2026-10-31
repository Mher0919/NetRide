// backend/src/modules/groups/group-fare.service.ts
//
// PURE, DETERMINISTIC GROUP FARE ALLOCATION.
//
// The backend generates a versioned group quote. This file is the single
// implementation of how the discounted payable total is divided between
// participants. It is intentionally pure (no I/O) so it can be exhaustively
// unit-tested and so the same math is used by quote preview, payment
// confirmation and the final booking validation.
//
// Financial rules
// ---------------
// * All amounts are integer cents.
// * The promo discount is applied ONCE to the whole group fare before any
//   allocation. There is no per-passenger promo application.
// * Booking fee, service fee and tax are part of the single group fare. They
//   are allocated (equal/distance/custom) rather than charged again per
//   passenger, so a fixed fee can never be duplicated.
// * Rounding: largest-remainder method. Every participant gets the floor of
//   their exact share, then the remaining cents are handed out one by one to
//   the largest fractional remainders (ties broken by ascending user id).
//   The sum of shares is therefore EXACTLY the payable total.
// * HOST_PAYS is the default: the host is responsible for the whole total and
//   friends owe nothing.

export type GroupSplitMethod = 'HOST_PAYS' | 'EQUAL' | 'DISTANCE' | 'CUSTOM';

export interface GroupParticipantShare {
  userId: string;
  amountCents: number;
  distanceMeters: number;
  weight: number;
  required: boolean;
}

export interface GroupShareInput {
  totalCents: number;
  method: GroupSplitMethod;
  hostId: string;
  participants: Array<{ userId: string; distanceMeters?: number }>;
  customShares?: Record<string, number>;
}

export type GroupShareResult =
  | { ok: true; shares: GroupParticipantShare[] }
  | { ok: false; error: string; code: string };

const MAX_PARTICIPANTS_HARD_LIMIT = 5;

function assertTotal(totalCents: number): number {
  if (!Number.isFinite(totalCents)) {
    throw new Error('Group total must be a finite amount');
  }
  const total = Math.round(totalCents);
  if (total < 0) throw new Error('Group total cannot be negative');
  return total;
}

/** Floor + largest-remainder distribution. `numerators` share denominator. */
function largestRemainder(
  totalCents: number,
  numerators: number[],
  denominator: number,
  tieBreakIds: string[],
): number[] {
  if (numerators.length === 0) return [];
  if (denominator <= 0) {
    throw new Error('Cannot allocate a distance share with zero total weight');
  }
  const assigned = numerators.map((n) => Math.floor((totalCents * n) / denominator));
  let remaining = totalCents - assigned.reduce((a, b) => a + b, 0);
  const remainders = numerators.map((n, i) => ({
    index: i,
    rem: (totalCents * n) % denominator,
    id: tieBreakIds[i] ?? String(i),
  }));
  remainders.sort((a, b) => {
    if (b.rem !== a.rem) return b.rem - a.rem;
    return a.id.localeCompare(b.id);
  });
  let cursor = 0;
  while (remaining > 0 && remainders.length > 0) {
    assigned[remainders[cursor % remainders.length].index] += 1;
    remaining -= 1;
    cursor += 1;
  }
  return assigned;
}

export function allocateEqual(
  totalCents: number,
  participantIds: string[],
): GroupParticipantShare[] {
  const total = assertTotal(totalCents);
  if (participantIds.length === 0) return [];
  const ids = [...participantIds].sort((a, b) => a.localeCompare(b));
  const amounts = largestRemainder(total, ids.map(() => 1), ids.length, ids);
  return ids.map((userId, i) => ({
    userId,
    amountCents: amounts[i],
    distanceMeters: 0,
    weight: 1 / ids.length,
    required: amounts[i] > 0,
  }));
}

export function allocateDistance(
  totalCents: number,
  entries: Array<{ userId: string; distanceMeters: number }>,
): GroupParticipantShare[] {
  const total = assertTotal(totalCents);
  if (entries.length === 0) return [];
  const clean = entries
    .map((e) => ({
      userId: e.userId,
      distanceMeters: Math.max(0, Math.round(Number(e.distanceMeters) || 0)),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

  const totalDistance = clean.reduce((sum, e) => sum + e.distanceMeters, 0);
  if (totalDistance <= 0) {
    throw new Error('Distance-based splitting requires a road distance for every pickup');
  }
  const amounts = largestRemainder(
    total,
    clean.map((e) => e.distanceMeters),
    totalDistance,
    clean.map((e) => e.userId),
  );
  return clean.map((e, i) => ({
    userId: e.userId,
    amountCents: amounts[i],
    distanceMeters: e.distanceMeters,
    weight: e.distanceMeters / totalDistance,
    required: amounts[i] > 0,
  }));
}

export function allocateHostPays(
  totalCents: number,
  hostId: string,
  participantIds: string[],
): GroupParticipantShare[] {
  const total = assertTotal(totalCents);
  const unique = Array.from(new Set([hostId, ...participantIds]));
  return unique.map((userId) => ({
    userId,
    amountCents: userId === hostId ? total : 0,
    distanceMeters: 0,
    weight: userId === hostId ? 1 : 0,
    required: userId === hostId && total > 0,
  }));
}

export function validateCustomShares(
  totalCents: number,
  participantIds: string[],
  customShares: Record<string, number>,
): { ok: true; shares: GroupParticipantShare[] } | { ok: false; error: string; code: string } {
  const total = assertTotal(totalCents);
  const unique = Array.from(new Set(participantIds));
  if (unique.length !== Object.keys(customShares).length) {
    return {
      ok: false,
      code: 'CUSTOM_SHARE_MEMBERS_MISMATCH',
      error: 'Every group participant must have exactly one custom share',
    };
  }
  let sum = 0;
  const shares: GroupParticipantShare[] = [];
  for (const userId of unique) {
    if (!(userId in customShares)) {
      return {
        ok: false,
        code: 'CUSTOM_SHARE_MISSING',
        error: 'Every group participant must have exactly one custom share',
      };
    }
    const raw = customShares[userId];
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      return {
        ok: false,
        code: 'CUSTOM_SHARE_INVALID',
        error: 'Custom shares must be non-negative whole cents',
      };
    }
    sum += raw;
    shares.push({
      userId,
      amountCents: raw,
      distanceMeters: 0,
      weight: total > 0 ? raw / total : 0,
      required: raw > 0,
    });
  }
  if (sum !== total) {
    return {
      ok: false,
      code: 'CUSTOM_SHARE_MISMATCH',
      error: `Custom shares must add up to the group total (${total} cents)`,
    };
  }
  return { ok: true, shares: shares.sort((a, b) => a.userId.localeCompare(b.userId)) };
}

export function computeGroupShares(input: GroupShareInput): GroupShareResult {
  const total = assertTotal(input.totalCents);
  const ids = input.participants.map((p) => p.userId);
  if (ids.length === 0) {
    return { ok: false, code: 'NO_PARTICIPANTS', error: 'The group has no participants' };
  }
  if (ids.length > MAX_PARTICIPANTS_HARD_LIMIT) {
    return { ok: false, code: 'GROUP_FULL', error: 'A group can have at most five participants' };
  }
  if (!ids.includes(input.hostId)) {
    return { ok: false, code: 'HOST_NOT_MEMBER', error: 'The host must be a group participant' };
  }

  try {
    switch (input.method) {
      case 'HOST_PAYS':
        return { ok: true, shares: allocateHostPays(total, input.hostId, ids) };
      case 'EQUAL':
        return { ok: true, shares: allocateEqual(total, ids) };
      case 'DISTANCE':
        return {
          ok: true,
          shares: allocateDistance(
            total,
            input.participants.map((p) => ({
              userId: p.userId,
              distanceMeters: p.distanceMeters ?? 0,
            })),
          ),
        };
      case 'CUSTOM':
        return validateCustomShares(total, ids, input.customShares ?? {});
      default:
        return { ok: false, code: 'INVALID_SPLIT_METHOD', error: 'Unsupported split method' };
    }
  } catch (err: any) {
    return { ok: false, code: 'ALLOCATION_FAILED', error: String(err?.message ?? err) };
  }
}

/** Sum helper used by booking validation and tests. */
export function sumShares(shares: GroupParticipantShare[]): number {
  return shares.reduce((sum, s) => sum + s.amountCents, 0);
}

export const GROUP_MAX_PARTICIPANTS_HARD_LIMIT = MAX_PARTICIPANTS_HARD_LIMIT;
