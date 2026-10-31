// backend/src/modules/groups/group-events.ts
//
// Authorized real-time fan-out for group activity.
//
// Every authenticated socket may join `group:<id>` only after the gateway
// verifies membership (see socket.gateway.ts `subscribeGroup`). Services emit
// to that room; the per-member `rider:<id>` room is only used for small
// invalidation pings that let the Groups inbox update its unread/activity
// state without subscribing every user to every group.

import { getIo } from '../../gateway/io-handle';
import { pool } from '../../config/database';

function io() {
  return getIo();
}

export function groupRoom(groupId: string): string {
  return `group:${groupId}`;
}

export async function groupMemberIds(groupId: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT user_id FROM ride_group_members
      WHERE group_id = $1
        AND status NOT IN ('INVITED','LEFT','REMOVED')`,
    [groupId],
  );
  return res.rows.map((r: any) => r.user_id);
}

export async function emitGroupUpdated(groupId: string, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupUpdated', { groupId, ...payload });
  } catch {
    /* socket server may not be initialized in unit tests */
  }
  await pingInbox(groupId, { event: 'groupUpdated', ...payload });
}

export async function emitGroupMessage(groupId: string, message: Record<string, unknown>): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupMessageReceived', message);
  } catch {
    /* optional */
  }
  await pingInbox(groupId, { event: 'groupMessageReceived', groupId, message });
}

export async function emitGroupPaymentUpdated(groupId: string, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupPaymentUpdated', { groupId, ...payload });
  } catch {
    /* optional */
  }
  await pingInbox(groupId, { event: 'groupPaymentUpdated', ...payload });
}

export async function emitGroupRideUpdated(groupId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupRideUpdated', { groupId, ...payload });
  } catch {
    /* optional */
  }
  await pingInbox(groupId, { event: 'groupRideUpdated', ...payload });
}

export async function emitGroupDriverLocation(
  groupId: string,
  payload: { lat: number; lng: number; heading?: number | null; driverId?: string | null },
): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupDriverLocation', { groupId, ...payload });
  } catch {
    /* optional */
  }
}

export async function emitGroupPickupConfirmed(
  groupId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    io().to(groupRoom(groupId)).emit('groupPickupConfirmed', { groupId, ...payload });
  } catch {
    /* optional */
  }
  await pingInbox(groupId, { event: 'groupPickupConfirmed', ...payload });
}

async function pingInbox(groupId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const ids = await groupMemberIds(groupId);
    for (const userId of ids) {
      io().to(`rider:${userId}`).emit('groupActivity', { groupId, ...payload });
    }
  } catch {
    /* optional */
  }
}

export async function emitGroupInvitation(userId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    io().to(`rider:${userId}`).emit('groupInvitationReceived', payload);
  } catch {
    /* optional */
  }
}
