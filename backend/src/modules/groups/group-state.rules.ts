// backend/src/modules/groups/group-state.rules.ts
//
// Explicit lifecycle model for group rides. Every transition is validated by
// the backend before a write; invalid transitions are rejected rather than
// coerced. Kept pure so the rules are unit-testable without a database.

export type GroupStatus =
  | 'DRAFT'
  | 'COLLECTING_MEMBERS'
  | 'CONFIGURING'
  | 'AWAITING_PAYMENT'
  | 'READY_TO_REQUEST'
  | 'RIDE_REQUESTED'
  | 'DRIVER_MATCHING'
  | 'DRIVER_ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED';

export type MemberStatus =
  | 'INVITED'
  | 'JOINED'
  | 'PICKUP_PENDING'
  | 'PICKUP_CONFIRMED'
  | 'PICKED_UP'
  | 'COMPLETED'
  | 'LEFT'
  | 'REMOVED'
  | 'CANCELLED'
  | 'NO_SHOW';

export type PaymentStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REFUNDED'
  | 'CANCELLED';

const GROUP_TRANSITIONS: Record<GroupStatus, GroupStatus[]> = {
  DRAFT: ['COLLECTING_MEMBERS', 'CANCELLED', 'EXPIRED'],
  COLLECTING_MEMBERS: ['CONFIGURING', 'CANCELLED', 'EXPIRED'],
  CONFIGURING: ['AWAITING_PAYMENT', 'COLLECTING_MEMBERS', 'CANCELLED', 'EXPIRED'],
  AWAITING_PAYMENT: ['READY_TO_REQUEST', 'CONFIGURING', 'CANCELLED', 'EXPIRED'],
  READY_TO_REQUEST: ['RIDE_REQUESTED', 'AWAITING_PAYMENT', 'CONFIGURING', 'CANCELLED', 'EXPIRED'],
  RIDE_REQUESTED: ['DRIVER_MATCHING', 'CANCELLED'],
  DRIVER_MATCHING: ['DRIVER_ASSIGNED', 'RIDE_REQUESTED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['IN_PROGRESS', 'DRIVER_MATCHING', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const MEMBER_TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  INVITED: ['JOINED', 'LEFT', 'CANCELLED', 'REMOVED'],
  JOINED: ['PICKUP_PENDING', 'PICKUP_CONFIRMED', 'PICKED_UP', 'LEFT', 'REMOVED', 'CANCELLED', 'NO_SHOW'],
  PICKUP_PENDING: ['PICKUP_CONFIRMED', 'PICKED_UP', 'LEFT', 'REMOVED', 'CANCELLED', 'NO_SHOW'],
  PICKUP_CONFIRMED: ['PICKED_UP', 'LEFT', 'REMOVED', 'CANCELLED', 'NO_SHOW'],
  PICKED_UP: ['COMPLETED', 'NO_SHOW'],
  COMPLETED: [],
  LEFT: [],
  REMOVED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  NOT_REQUIRED: [],
  PENDING: ['PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['REFUNDED'],
  FAILED: ['PENDING', 'PROCESSING', 'CANCELLED'],
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransitionGroup(from: GroupStatus, to: GroupStatus): boolean {
  if (from === to) return true;
  return (GROUP_TRANSITIONS[from] ?? []).includes(to);
}

export function assertGroupTransition(from: GroupStatus, to: GroupStatus): void {
  if (!canTransitionGroup(from, to)) {
    throw new Error(`Invalid group state transition: ${from} -> ${to}`);
  }
}

export function canTransitionMember(from: MemberStatus, to: MemberStatus): boolean {
  if (from === to) return true;
  return (MEMBER_TRANSITIONS[from] ?? []).includes(to);
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  return (PAYMENT_TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses in which membership/quote configuration may still change. */
export const CONFIGURABLE_GROUP_STATUSES: GroupStatus[] = [
  'DRAFT',
  'COLLECTING_MEMBERS',
  'CONFIGURING',
  'AWAITING_PAYMENT',
  'READY_TO_REQUEST',
];

/** Statuses in which the booking belongs to the ride lifecycle. */
export const RIDE_ACTIVE_GROUP_STATUSES: GroupStatus[] = [
  'RIDE_REQUESTED',
  'DRIVER_MATCHING',
  'DRIVER_ASSIGNED',
  'IN_PROGRESS',
];

export const FINAL_GROUP_STATUSES: GroupStatus[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

export function isConfigurable(status: GroupStatus): boolean {
  return CONFIGURABLE_GROUP_STATUSES.includes(status);
}

export function isRideActive(status: GroupStatus): boolean {
  return RIDE_ACTIVE_GROUP_STATUSES.includes(status);
}

/** A participant with this status occupies a seat and counts for capacity. */
export function occupiesSeat(status: MemberStatus): boolean {
  return status === 'JOINED' || status === 'PICKUP_PENDING' || status === 'PICKUP_CONFIRMED';
}

export function isActiveMember(status: MemberStatus): boolean {
  return status === 'JOINED' ||
    status === 'PICKUP_PENDING' ||
    status === 'PICKUP_CONFIRMED' ||
    status === 'PICKED_UP' ||
    status === 'COMPLETED';
}
