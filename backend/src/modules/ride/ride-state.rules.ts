// backend/src/modules/ride/ride-state.rules.ts
//
// Pure ride-lifecycle rules shared by the service layer and unit tests.
// Kept free of database/app imports so the state and concurrency guards can
// be asserted without booting the server graph.

import { TripStatus } from '../../types';

/**
 * Extra, atomic preconditions for a system-initiated cancellation. The
 * watchdog queries candidate ids, but the cancel itself must re-verify the
 * same age/state predicate inside the UPDATE — otherwise a ride that
 * started or completed between the query and the write is clobbered
 * (TOCTOU). Columns are allowlisted so no caller-supplied SQL can enter.
 */
export interface TerminalCancelGuard {
  statuses?: TripStatus[];
  beforeColumn?: 'created_at' | 'accepted_at' | 'started_at';
  before?: Date;
  requireStartedAtNull?: boolean;
  /** Allow scheduled rides only when `scheduled_at < this` (or not scheduled). */
  requireNotScheduledBefore?: Date;
}

/**
 * Pure builder for the atomic-cancel predicate (unit-tested). Only the
 * allowlisted columns can ever appear in the SQL; all values are bound.
 * `startIndex` is the 1-based parameter position of the first status
 * placeholder in the caller's values array.
 */
export function buildTerminalCancelGuardSql(
  statuses: TripStatus[],
  guard: TerminalCancelGuard | undefined,
  startIndex: number,
): { statusPlaceholders: string; extraWhere: string; extraValues: any[] } {
  const statusPlaceholders = statuses.map((_, i) => `$${startIndex + i}`).join(', ');
  let extraWhere = '';
  const extraValues: any[] = [];

  const nextIndex = () => startIndex + statuses.length + extraValues.length;

  if (guard?.beforeColumn && guard.before) {
    extraWhere += ` AND ${guard.beforeColumn} < $${nextIndex()}`;
    extraValues.push(guard.before);
  }
  if (guard?.requireStartedAtNull) {
    extraWhere += ` AND started_at IS NULL`;
  }
  if (guard?.requireNotScheduledBefore) {
    extraWhere += ` AND (is_scheduled IS NOT TRUE OR scheduled_at < $${nextIndex()})`;
    extraValues.push(guard.requireNotScheduledBefore);
  }

  return { statusPlaceholders, extraWhere, extraValues };
}
