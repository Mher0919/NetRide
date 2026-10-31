// backend/src/modules/groups/group.service.ts
//
// Core coordination service for group rides: creation, friendship-based
// invitations, contact invitations, membership lifecycle, group chat,
// pickup/destination configuration and versioned fare quotes.
//
// Authorization is always enforced here. A non-member receives a 404 (never
// revealing that a group exists); only the host can mutate shared booking
// configuration; members may only change their own pickup and payment.

import { pool } from '../../config/database';
import { computeEstimate, type FareBreakdown } from '../../services/pricing.service';
import { validatePromo } from '../promo/promo.service';
import { CreditsService } from '../credits/credits.service';
import { notifyUser, fmtMoney } from '../../services/notification.service';
import { getIo } from '../../gateway/io-handle';
import {
  canTransitionGroup,
  isConfigurable,
  isRideActive,
  type GroupStatus,
  type MemberStatus,
} from './group-state.rules';
import {
  computeGroupShares,
  sumShares,
  type GroupSplitMethod,
  type GroupParticipantShare,
} from './group-fare.service';
import {
  GroupRouteService,
  type GroupRoutePlanResult,
  type GroupPickupPoint,
} from './group-route.service';
import { getGroupSettings } from './group-settings.service';
import {
  buildGroupInviteLink,
  buildGroupInviteSms,
  generateInviteToken,
  hashInviteToken,
  normalizePhone,
} from './group-invite.util';
import { FriendsService } from './friends.service';
import {
  emitGroupInvitation,
  emitGroupMessage,
  emitGroupPaymentUpdated,
  emitGroupUpdated,
  groupMemberIds,
} from './group-events';
import { GroupPaymentsService } from './group-payments.service';

export class GroupError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface GroupMemberView {
  userId: string;
  fullName: string;
  profileImageUrl: string | null;
  role: 'HOST' | 'MEMBER';
  status: MemberStatus;
  pickup: { lat: number; lng: number; address: string | null } | null;
  pickupSource: string | null;
  paymentStatus: string;
  isMe: boolean;
  joinedAt: string | null;
}

export interface GroupDetail {
  id: string;
  name: string;
  status: GroupStatus;
  hostId: string;
  hostName: string;
  isHost: boolean;
  destination: { lat: number; lng: number; address: string | null } | null;
  splitMethod: GroupSplitMethod;
  vehicleCategory: string;
  participants: GroupMemberView[];
  pendingInvitations: Array<{
    id: string;
    invitedName: string | null;
    invitedPhone: string | null;
    invitedUserId: string | null;
    status: string;
    expiresAt: string;
    createdAt: string;
  }>;
  lastMessage: Record<string, any> | null;
  unreadCount: number;
  quote: Record<string, any> | null;
  routePlan: Record<string, any> | null;
  payments: Array<Record<string, any>>;
  myShare: Record<string, any> | null;
  ride: Record<string, any> | null;
  canRequest: boolean;
  canConfigure: boolean;
  createdAt: string;
  updatedAt: string;
}

const GROUP_CONFIGURABLE_ERROR =
  'This group ride is already being booked and can no longer be changed.';

function iso(value: any): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numberOrNull(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeName(raw: unknown): string {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 1) throw new GroupError('NAME_REQUIRED', 'Enter a group name');
  if (name.length > 80) throw new GroupError('NAME_TOO_LONG', 'Group names can be up to 80 characters');
  return name;
}

export class GroupService {
  // ------------------------------------------------------------------
  // Access helpers
  // ------------------------------------------------------------------
  static async requireMembership(
    groupId: string,
    userId: string,
    client: any = pool,
    opts: { forUpdate?: boolean } = {},
  ): Promise<{ group: any; member: any }> {
    if (!FriendsService.isUuid(groupId)) {
      throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404);
    }
    const groupRes = await client.query(
      `SELECT * FROM ride_groups WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
      [groupId],
    );
    const group = groupRes.rows[0];
    if (!group) throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404);
    const memberRes = await client.query(
      `SELECT * FROM ride_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId],
    );
    const member = memberRes.rows[0];
    if (!member || ![
      'JOINED', 'PICKUP_PENDING', 'PICKUP_CONFIRMED', 'PICKED_UP',
      'COMPLETED', 'CANCELLED', 'NO_SHOW',
    ].includes(member.status)) {
      throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404);
    }
    return { group, member };
  }

  static async requireHost(
    groupId: string,
    userId: string,
    client: any = pool,
    opts: { forUpdate?: boolean } = {},
  ): Promise<{ group: any; member: any }> {
    const ctx = await this.requireMembership(groupId, userId, client, opts);
    if (ctx.group.host_id !== userId) {
      throw new GroupError('HOST_ONLY', 'Only the group host can do that', 403);
    }
    return ctx;
  }

  static async getMemberIds(groupId: string, client: any = pool): Promise<string[]> {
    const res = await client.query(
      `SELECT user_id FROM ride_group_members
        WHERE group_id = $1
          AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED','PICKED_UP','COMPLETED','CANCELLED','NO_SHOW')`,
      [groupId],
    );
    return res.rows.map((r: any) => r.user_id);
  }

  // ------------------------------------------------------------------
  // Messages/system activity
  // ------------------------------------------------------------------
  static async recordSystemMessage(
    client: any,
    groupId: string,
    content: string,
    metadata: Record<string, unknown> = {},
    type: 'SYSTEM' | 'INVITATION' | 'MEMBER' | 'PICKUP' | 'RIDE' | 'PAYMENT' | 'ROUTE' = 'SYSTEM',
  ): Promise<any> {
    const res = await client.query(
      `INSERT INTO ride_group_messages (group_id, sender_id, message_type, content, metadata)
       VALUES ($1, NULL, $2, $3, $4::jsonb)
       RETURNING *`,
      [groupId, type, String(content).slice(0, 2000), JSON.stringify(metadata)],
    );
    return res.rows[0];
  }

  static async listMessages(
    groupId: string,
    userId: string,
    before?: string | null,
    limit = 50,
  ): Promise<{ messages: any[]; hasMore: boolean }> {
    await this.requireMembership(groupId, userId);
    const safeLimit = Math.min(100, Math.max(1, Math.round(limit)));
    const params: any[] = [groupId];
    let where = 'group_id = $1';
    if (before) {
      params.push(before);
      where += ` AND created_at < $${params.length}::timestamptz`;
    }
    params.push(safeLimit + 1);
    const res = await pool.query(
      `SELECT * FROM ride_group_messages
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    const hasMore = res.rows.length > safeLimit;
    const messages = res.rows.slice(0, safeLimit).reverse();
    await pool.query(
      `UPDATE ride_group_members SET last_read_at = NOW()
        WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId],
    );
    return { messages, hasMore };
  }

  static async markRead(groupId: string, userId: string): Promise<void> {
    await this.requireMembership(groupId, userId);
    await pool.query(
      `UPDATE ride_group_members SET last_read_at = NOW()
        WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId],
    );
  }

  static async sendMessage(groupId: string, userId: string, raw: string): Promise<any> {
    const text = String(raw ?? '').trim();
    if (text.length < 1) throw new GroupError('MESSAGE_EMPTY', 'Write a message first');
    if (text.length > 2000) throw new GroupError('MESSAGE_TOO_LONG', 'Messages can be up to 2000 characters');
    const ctx = await this.requireMembership(groupId, userId);
    const res = await pool.query(
      `INSERT INTO ride_group_messages (group_id, sender_id, message_type, content)
       VALUES ($1, $2, 'TEXT', $3)
       RETURNING *`,
      [groupId, userId, text],
    );
    const user = await pool.query(`SELECT full_name, profile_image_url FROM users WHERE id = $1`, [userId]);
    const message = {
      ...res.rows[0],
      sender_name: user.rows[0]?.full_name ?? 'Member',
      sender_photo_url: user.rows[0]?.profile_image_url ?? null,
    };
    await emitGroupMessage(groupId, message);
    // Inbox preview updates for every member (including sender).
    await emitGroupUpdated(groupId, {
      lastMessage: {
        id: message.id,
        content: message.content,
        senderName: message.sender_name,
        createdAt: iso(message.created_at),
      },
      // `ctx` is only here to prove membership was checked above.
      status: ctx.group.status,
    });
    return message;
  }

  // ------------------------------------------------------------------
  // Creation and listing
  // ------------------------------------------------------------------
  static async createGroup(
    hostId: string,
    input: { name: string; memberIds?: string[] },
  ): Promise<GroupDetail> {
    const name = normalizeName(input.name);
    const settings = await getGroupSettings();
    const memberIds = Array.from(new Set((input.memberIds ?? []).filter(Boolean)));
    if (memberIds.includes(hostId)) {
      throw new GroupError('HOST_INCLUDED', 'The host is added automatically');
    }
    if (memberIds.length + 1 > settings.maxParticipants) {
      throw new GroupError(
        'GROUP_FULL',
        `A group can have at most ${settings.maxParticipants} participants`,
      );
    }
    for (const id of memberIds) {
      if (!FriendsService.isUuid(id)) throw new GroupError('INVALID_FRIEND', 'Invalid friend');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const host = await client.query(
        `SELECT id, full_name FROM users WHERE id = $1::uuid AND is_active IS NOT FALSE`,
        [hostId],
      );
      if (!host.rows[0]) throw new GroupError('ACCOUNT_UNAVAILABLE', 'Account unavailable', 403);
      const hostName = host.rows[0].full_name;

      if (memberIds.length > 0) {
        const friends = await client.query(
          `SELECT CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END AS friend_id
             FROM friendships f
            WHERE (f.user_low = $1::uuid OR f.user_high = $1::uuid)
              AND f.status = 'ACCEPTED'
              AND (CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END) = ANY($2::uuid[])`,
          [hostId, memberIds],
        );
        const accepted = new Set(friends.rows.map((r: any) => r.friend_id));
        const notFriends = memberIds.filter((id) => !accepted.has(id));
        if (notFriends.length > 0) {
          throw new GroupError('NOT_FRIENDS', 'You can only add accepted NetRide friends to a group', 403);
        }
      }

      const groupRes = await client.query(
        `INSERT INTO ride_groups (host_id, name, status)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [hostId, name, memberIds.length > 0 ? 'CONFIGURING' : 'COLLECTING_MEMBERS'],
      );
      const group = groupRes.rows[0];

      await client.query(
        `INSERT INTO ride_group_members
           (group_id, user_id, role, status, joined_at)
         VALUES ($1, $2, 'HOST', 'JOINED', NOW())`,
        [group.id, hostId],
      );
      await this.recordSystemMessage(client, group.id, `${hostName} created the group.`);
      if (memberIds.length > 0) {
        await client.query(
          `INSERT INTO ride_group_members (group_id, user_id, role, status, joined_at)
           SELECT $1::uuid, friend_id, 'MEMBER', 'JOINED', NOW()
             FROM unnest($2::uuid[]) AS friend_id`,
          [group.id, memberIds],
        );
        const names = await client.query(
          `SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])`,
          [memberIds],
        );
        for (const row of names.rows) {
          await this.recordSystemMessage(
            client,
            group.id,
            `${row.full_name} joined the group.`,
            { userId: row.id },
            'MEMBER',
          );
        }
      }
      await client.query('COMMIT');
      for (const memberId of memberIds) {
        await notifyUser({
          userId: memberId,
          role: 'rider',
          type: 'group_member_joined',
          title: 'You were added to a group',
          body: `${hostName} added you to "${name}" for a group ride.`,
          data: { groupId: group.id, route: '/groups' },
          eventId: `group-created-member:${group.id}:${memberId}`,
        }).catch(() => undefined);
      }
      await emitGroupUpdated(group.id, { created: true });
      return this.getGroup(group.id, hostId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async listGroups(userId: string): Promise<any[]> {
    const res = await pool.query(
      `SELECT g.*, u.full_name AS host_name,
              (SELECT COUNT(*) FROM ride_group_members m2
                WHERE m2.group_id = g.id
                  AND m2.status NOT IN ('INVITED','LEFT','REMOVED')) AS participant_count,
              lm.content AS last_message,
              lm.created_at AS last_message_at,
              lm.message_type AS last_message_type,
              lm.sender_id AS last_message_sender_id,
              lu.full_name AS last_message_sender_name,
              (SELECT COUNT(*) FROM ride_group_messages msg
                WHERE msg.group_id = g.id
                  AND msg.sender_id IS DISTINCT FROM $1::uuid
                  AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at)) AS unread_count,
              r.status AS ride_status,
              r.id AS ride_id
         FROM ride_group_members m
         JOIN ride_groups g ON g.id = m.group_id
         JOIN users u ON u.id = g.host_id
         LEFT JOIN LATERAL (
           SELECT content, created_at, message_type, sender_id
             FROM ride_group_messages
            WHERE group_id = g.id
            ORDER BY created_at DESC LIMIT 1
         ) lm ON TRUE
         LEFT JOIN users lu ON lu.id = lm.sender_id
         LEFT JOIN rides r ON r.id = g.active_ride_id
        WHERE m.user_id = $1::uuid
          AND m.status NOT IN ('INVITED','LEFT','REMOVED')
        ORDER BY COALESCE(lm.created_at, g.updated_at) DESC
        LIMIT 100`,
      [userId],
    );
    const groupIds = res.rows.map((r: any) => r.id);
    const membersByGroup = new Map<string, any[]>();
    if (groupIds.length > 0) {
      const membersRes = await pool.query(
        `SELECT m.group_id, m.user_id, m.role, u.full_name, u.profile_image_url
           FROM ride_group_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.group_id = ANY($1::uuid[])
            AND m.status NOT IN ('INVITED','LEFT','REMOVED')
          ORDER BY m.group_id,
                   CASE WHEN m.role = 'HOST' THEN 0 ELSE 1 END,
                   m.joined_at ASC NULLS LAST`,
        [groupIds],
      );
      for (const m of membersRes.rows) {
        const list = membersByGroup.get(m.group_id) ?? [];
        if (list.length < 5) {
          list.push({
            userId: m.user_id,
            fullName: m.full_name,
            profileImageUrl: m.profile_image_url ?? null,
            role: m.role,
          });
        }
        membersByGroup.set(m.group_id, list);
      }
    }

    return res.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      hostId: row.host_id,
      hostName: row.host_name,
      participantCount: Number(row.participant_count ?? 0),
      members: membersByGroup.get(row.id) ?? [],
      lastMessage: row.last_message == null
        ? null
        : {
            content: row.last_message,
            createdAt: iso(row.last_message_at),
            type: row.last_message_type,
            senderName: row.last_message_sender_name ?? null,
          },
      unreadCount: Number(row.unread_count ?? 0),
      rideStatus: row.ride_status ?? null,
      rideId: row.ride_id ?? null,
      updatedAt: iso(row.updated_at),
    }));
  }

  static async getGroup(groupId: string, userId: string): Promise<GroupDetail> {
    const { group, member } = await this.requireMembership(groupId, userId);
    const [
      hostRes,
      membersRes,
      invitesRes,
      lastMessageRes,
      quoteRes,
      ridesRes,
    ] = await Promise.all([
      pool.query(`SELECT full_name FROM users WHERE id = $1`, [group.host_id]),
      pool.query(
        `SELECT m.*, u.full_name, u.profile_image_url
           FROM ride_group_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.group_id = $1
            AND m.status NOT IN ('INVITED','LEFT','REMOVED')
          ORDER BY CASE WHEN m.role = 'HOST' THEN 0 ELSE 1 END, m.joined_at ASC`,
        [groupId],
      ),
      pool.query(
        `SELECT i.*, u.full_name AS invited_user_name
           FROM ride_group_invitations i
           LEFT JOIN users u ON u.id = i.invited_user_id
          WHERE i.group_id = $1 AND i.status = 'PENDING'
          ORDER BY i.created_at DESC`,
        [groupId],
      ),
      pool.query(
        `SELECT msg.*, u.full_name AS sender_name
           FROM ride_group_messages msg
           LEFT JOIN users u ON u.id = msg.sender_id
          WHERE msg.group_id = $1
          ORDER BY msg.created_at DESC LIMIT 1`,
        [groupId],
      ),
      pool.query(`SELECT * FROM ride_group_quotes WHERE id = $1`, [group.current_quote_id]),
      group.active_ride_id
        ? pool.query(
            `SELECT r.*, u.full_name AS driver_name, u.profile_image_url AS driver_photo_url,
                    u.rating AS driver_rating
               FROM rides r
               LEFT JOIN users u ON u.id = r.driver_id
              WHERE r.id = $1`,
            [group.active_ride_id],
          )
        : Promise.resolve({ rows: [] } as any),
    ]);

    const participants: GroupMemberView[] = membersRes.rows.map((row: any) => ({
      userId: row.user_id,
      fullName: row.full_name,
      profileImageUrl: row.profile_image_url ?? null,
      role: row.role,
      status: row.status,
      pickup: numberOrNull(row.pickup_lat) != null && numberOrNull(row.pickup_lng) != null
        ? {
            lat: Number(row.pickup_lat),
            lng: Number(row.pickup_lng),
            address: row.pickup_address ?? null,
          }
        : null,
      pickupSource: row.pickup_source ?? null,
      paymentStatus: row.payment_status ?? 'NOT_REQUIRED',
      isMe: row.user_id === userId,
      joinedAt: iso(row.joined_at),
    }));

    const unreadRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ride_group_messages
        WHERE group_id = $1
          AND sender_id IS DISTINCT FROM $2::uuid
          AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)`,
      [groupId, userId, member.last_read_at],
    );

    let quote: Record<string, any> | null = null;
    let routePlan: Record<string, any> | null = null;
    let payments: Array<Record<string, any>> = [];
    let myShare: Record<string, any> | null = null;
    if (quoteRes.rows[0]) {
      const q = quoteRes.rows[0];
      const expired = new Date(q.expires_at).getTime() <= Date.now();
      if (q.status === 'ACTIVE' && expired) {
        await pool.query(
          `UPDATE ride_group_quotes SET status = 'EXPIRED' WHERE id = $1 AND status = 'ACTIVE'`,
          [q.id],
        );
        await pool.query(
          `UPDATE ride_groups
              SET status = 'CONFIGURING', current_quote_id = NULL, updated_at = NOW()
            WHERE id = $1 AND status IN ('AWAITING_PAYMENT','READY_TO_REQUEST','CONFIGURING')`,
          [groupId],
        );
        q.status = 'EXPIRED';
        // A confirmed share must never survive the quote it was paid
        // against. Refund it idempotently; the host has to create a fresh
        // quote and everyone confirms the new amount.
        await GroupPaymentsService.refundQuotePayments(q.id, 'quote expired');
      }
      const [planRes, sharesRes, payRes] = await Promise.all([
        pool.query(`SELECT * FROM ride_group_route_plans WHERE id = $1`, [q.route_plan_id]),
        pool.query(
          `SELECT s.*, u.full_name FROM ride_group_quote_shares s
             JOIN users u ON u.id = s.user_id
            WHERE s.quote_id = $1 ORDER BY s.user_id`,
          [q.id],
        ),
        pool.query(`SELECT * FROM ride_group_payments WHERE quote_id = $1`, [q.id]),
      ]);
      const plan = planRes.rows[0];
      const shares = sharesRes.rows;
      payments = payRes.rows.map((row: any) => ({
        id: row.id,
        quoteId: row.quote_id,
        participantId: row.participant_id,
        // Payment amounts are private to the payer (and the host, who owns
        // the booking). Everyone can see whether a share is required and
        // whether it has been confirmed.
        amountCents:
          group.host_id === userId || row.participant_id === userId
            ? Number(row.amount_cents)
            : 0,
        required: Number(row.amount_cents) > 0,
        currency: row.currency,
        status: row.status,
        method: row.method,
        creditCents:
          row.participant_id === userId ? Number(row.credit_cents) : 0,
        cardCents: row.participant_id === userId ? Number(row.card_cents) : 0,
        failureReason: row.participant_id === userId ? row.failure_reason : null,
        succeededAt: iso(row.succeeded_at),
      }));
      myShare = shares.find((s: any) => s.user_id === userId) ?? null;
      quote = {
        id: q.id,
        version: Number(q.version),
        status: q.status,
        splitMethod: q.split_method,
        vehicleCategory: q.vehicle_category,
        currency: q.currency,
        originalFareCents: Number(q.original_fare_cents),
        promoDiscountCents: Number(q.promo_discount_cents),
        discountedTotalCents: Number(q.discounted_total_cents),
        promoCode: q.promo_code,
        expiresAt: iso(q.expires_at),
        createdAt: iso(q.created_at),
        routePlanId: q.route_plan_id,
        shares: shares.map((s: any) => ({
          userId: s.user_id,
          fullName: s.full_name,
          amountCents: Number(s.amount_cents),
          distanceMeters: Number(s.distance_meters),
          weight: Number(s.weight),
          required: s.required,
        })),
        fareComponents: q.fare_components,
      };
      routePlan = plan
        ? {
            id: plan.id,
            version: Number(plan.version),
            phase: plan.phase,
            stops: plan.stops?.stops ?? [],
            geometry: plan.stops?.geometry ?? null,
            totalDistanceMeters: Number(plan.total_distance_meters),
            totalDurationSeconds: Number(plan.total_duration_seconds),
            driverStart: plan.origin_lat != null
              ? { lat: Number(plan.origin_lat), lng: Number(plan.origin_lng) }
              : null,
            createdAt: iso(plan.created_at),
          }
        : null;
    }

    let ride: Record<string, any> | null = null;
    if (ridesRes.rows[0]) {
      const r = ridesRes.rows[0];
      const plan = await GroupRouteService.loadDriverPlanForRide(r.id);
      let groupRideGeometry = plan?.stops?.geometry ?? null;
      let groupRideDistance = Number(plan?.total_distance_meters ?? 0);
      let groupRideDuration = Number(plan?.total_duration_seconds ?? 0);
      if (r.status === 'IN_PROGRESS') {
        try {
          const { NavigationService } = await import('../../services/navigation.service');
          const live = await NavigationService.getCachedRouteLeg(r.id, 'destination');
          if (live && live.geometry.coordinates.length >= 2) {
            groupRideGeometry = live.geometry;
            groupRideDistance = live.distance ?? groupRideDistance;
            groupRideDuration = live.duration ?? groupRideDuration;
          }
        } catch { /* fall back */ }
      }
      let driverLocation: any = null;
      if (r.driver_id) {
        try {
          const { LocationsService } = await import('../location/locations.service');
          driverLocation = await LocationsService.getDriverLocation(r.driver_id);
        } catch { /* optional */ }
      }
      ride = {
        id: r.id,
        status: r.status,
        driverId: r.driver_id ?? null,
        driverName: r.driver_name ?? null,
        driverPhotoUrl: r.driver_photo_url ?? null,
        driverRating: r.driver_rating != null ? Number(r.driver_rating) : null,
        fareAmount: r.fare_amount != null ? Number(r.fare_amount) : null,
        distanceMeters: r.distance_meters != null ? Number(r.distance_meters) : null,
        durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
        pickup: r.pickup_lat != null ? { lat: Number(r.pickup_lat), lng: Number(r.pickup_lng), address: r.pickup_address } : null,
        destination: r.destination_lat != null
          ? { lat: Number(r.destination_lat), lng: Number(r.destination_lng), address: r.destination_address }
          : null,
        driverLocation,
        routePlan: plan
          ? {
              id: plan.id,
              version: Number(plan.version),
              stops: (plan.stops?.stops ?? []).map((stop: any) => {
                const statusById = new Map(
                  participants.map((p) => [p.userId, p.status]),
                );
                const passengers = (stop.passengers ?? []).map((p: any) => ({
                  ...p,
                  status: statusById.get(p.userId) ?? 'JOINED',
                }));
                return {
                  ...stop,
                  passengers,
                  completed:
                    passengers.length > 0 &&
                    passengers.every((p: any) =>
                      ['PICKED_UP', 'COMPLETED', 'NO_SHOW'].includes(p.status),
                    ),
                };
              }),
              geometry: groupRideGeometry,
              totalDistanceMeters: groupRideDistance,
              totalDurationSeconds: groupRideDuration,
            }
          : null,
        acceptedAt: iso(r.accepted_at),
        startedAt: iso(r.started_at),
        completedAt: iso(r.completed_at),
        cancelledAt: iso(r.cancelled_at),
        cancelledBy: r.cancelled_by ?? null,
        cancellationReasonCode: r.cancellation_reason_code ?? null,
      };
    }

    const requiredPayments = payments.filter((p) => p.required === true);
    const allPaid = requiredPayments.length > 0 && requiredPayments.every((p) => p.status === 'SUCCEEDED' || p.status === 'NOT_REQUIRED');
    const noPaymentsRequired = quote != null && requiredPayments.length === 0;
    const canRequest = group.host_id === userId &&
      quote?.status === 'ACTIVE' &&
      (allPaid || noPaymentsRequired) &&
      !group.active_ride_id &&
      ['AWAITING_PAYMENT', 'READY_TO_REQUEST', 'CONFIGURING'].includes(group.status);

    return {
      id: group.id,
      name: group.name,
      status: group.status,
      hostId: group.host_id,
      hostName: hostRes.rows[0]?.full_name ?? 'Host',
      isHost: group.host_id === userId,
      destination: numberOrNull(group.destination_lat) != null
        ? {
            lat: Number(group.destination_lat),
            lng: Number(group.destination_lng),
            address: group.destination_address ?? null,
          }
        : null,
      splitMethod: group.split_method,
      vehicleCategory: group.vehicle_category,
      participants,
      pendingInvitations: invitesRes.rows.map((row: any) => ({
        id: row.id,
        invitedName: row.invited_name ?? row.invited_user_name ?? null,
        // Only the host manages invitations and may see the target phone.
        invitedPhone: group.host_id === userId ? row.invited_phone ?? null : null,
        invitedUserId: group.host_id === userId ? row.invited_user_id ?? null : null,
        status: row.status,
        expiresAt: iso(row.expires_at)!,
        createdAt: iso(row.created_at)!,
      })),
      lastMessage: lastMessageRes.rows[0]
        ? {
            id: lastMessageRes.rows[0].id,
            content: lastMessageRes.rows[0].content,
            type: lastMessageRes.rows[0].message_type,
            senderName: lastMessageRes.rows[0].sender_name ?? null,
            createdAt: iso(lastMessageRes.rows[0].created_at),
          }
        : null,
      unreadCount: Number(unreadRes.rows[0]?.c ?? 0),
      quote,
      routePlan,
      payments,
      myShare: myShare
        ? {
            amountCents: Number(myShare.amount_cents),
            distanceMeters: Number(myShare.distance_meters),
            required: myShare.required,
          }
        : null,
      ride,
      canRequest,
      canConfigure: isConfigurable(group.status as GroupStatus),
      createdAt: iso(group.created_at)!,
      updatedAt: iso(group.updated_at)!,
    };
  }

  // ------------------------------------------------------------------
  // Group management
  // ------------------------------------------------------------------
  static async rename(groupId: string, userId: string, rawName: string): Promise<GroupDetail> {
    const name = normalizeName(rawName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, userId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      await client.query(`UPDATE ride_groups SET name = $2, updated_at = NOW() WHERE id = $1`, [groupId, name]);
      await this.recordSystemMessage(client, groupId, `${name} is the new group name.`);
      await client.query('COMMIT');
      await emitGroupUpdated(groupId);
      return this.getGroup(groupId, userId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async removeMember(groupId: string, hostId: string, targetUserId: string): Promise<GroupDetail> {
    const client = await pool.connect();
    let removedName = '';
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, hostId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      if (targetUserId === hostId) throw new GroupError('CANNOT_REMOVE_HOST', 'Transfer the host role before leaving');
      const memberRes = await client.query(
        `SELECT m.*, u.full_name FROM ride_group_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.group_id = $1 AND m.user_id = $2 AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [groupId, targetUserId],
      );
      const member = memberRes.rows[0];
      if (!member) throw new GroupError('MEMBER_NOT_FOUND', 'That participant is not in the group', 404);
      removedName = member.full_name;
      await client.query(
        `UPDATE ride_group_members SET status = 'REMOVED', left_at = NOW(), updated_at = NOW()
          WHERE group_id = $1 AND user_id = $2`,
        [groupId, targetUserId],
      );
      await client.query(
        `UPDATE ride_groups SET configuration_version = configuration_version + 1, updated_at = NOW()
          WHERE id = $1`,
        [groupId],
      );
      const oldQuote = await this.invalidateActiveQuote(client, groupId, 'participant removed');
      await this.recordSystemMessage(client, groupId, `${removedName} was removed from the group.`, {
        userId: targetUserId,
      }, 'MEMBER');
      await client.query('COMMIT');
      if (oldQuote) await GroupPaymentsService.refundQuotePayments(oldQuote, 'participant removed');
      await this.notifyMember(groupId, targetUserId, 'You were removed from the group', `${group.name}: the host removed you.`);
      await emitGroupUpdated(groupId);
      return this.getGroup(groupId, hostId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async leaveGroup(groupId: string, userId: string): Promise<{ left: boolean; newHostId: string | null; cancelled: boolean }> {
    const client = await pool.connect();
    let oldQuote: string | null = null;
    let newHostId: string | null = null;
    let cancelled = false;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireMembership(groupId, userId, client, { forUpdate: true });
      if (isRideActive(group.status)) {
        throw new GroupError(
          'GROUP_LOCKED',
          'The ride is already booked. The host must cancel the ride before the group can change.',
          409,
        );
      }
      await client.query(
        `UPDATE ride_group_members SET status = 'LEFT', left_at = NOW(), updated_at = NOW()
          WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
      await client.query(
        `UPDATE ride_groups SET configuration_version = configuration_version + 1, updated_at = NOW()
          WHERE id = $1`,
        [groupId],
      );
      const me = await client.query(`SELECT full_name FROM users WHERE id = $1`, [userId]);
      await this.recordSystemMessage(
        client,
        groupId,
        `${me.rows[0]?.full_name ?? 'A member'} left the group.`,
        { userId },
        'MEMBER',
      );
      if (group.host_id === userId) {
        const successor = await client.query(
          `SELECT user_id FROM ride_group_members
            WHERE group_id = $1 AND user_id <> $2
              AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')
            ORDER BY joined_at ASC NULLS LAST, created_at ASC
            LIMIT 1`,
          [groupId, userId],
        );
        if (successor.rows[0]) {
          newHostId = successor.rows[0].user_id;
          await client.query(`UPDATE ride_groups SET host_id = $2, updated_at = NOW() WHERE id = $1`, [groupId, newHostId]);
          await client.query(
            `UPDATE ride_group_members SET role = 'MEMBER', updated_at = NOW() WHERE group_id = $1 AND user_id = $2`,
            [groupId, userId],
          );
          await client.query(
            `UPDATE ride_group_members SET role = 'HOST', updated_at = NOW() WHERE group_id = $1 AND user_id = $2`,
            [groupId, newHostId],
          );
          await this.recordSystemMessage(client, groupId, `${me.rows[0]?.full_name ?? 'The host'} transferred the host role.`, {
            userId: newHostId,
          }, 'MEMBER');
        } else {
          cancelled = true;
          await client.query(
            `UPDATE ride_groups SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
            [groupId],
          );
          await client.query(
            `UPDATE ride_group_invitations SET status = 'REVOKED'
              WHERE group_id = $1 AND status = 'PENDING'`,
            [groupId],
          );
          await this.recordSystemMessage(client, groupId, 'The group was disbanded because the host left.');
        }
      }
      oldQuote = await this.invalidateActiveQuote(client, groupId, 'member left');
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    if (oldQuote) await GroupPaymentsService.refundQuotePayments(oldQuote, 'member left');
    await emitGroupUpdated(groupId, { left: true, newHostId, cancelled });
    try {
      getIo().to(`rider:${userId}`).emit('groupLeft', { groupId });
    } catch { /* optional */ }
    return { left: true, newHostId, cancelled };
  }

  static async setPickup(
    groupId: string,
    userId: string,
    input: { lat?: number; lng?: number; address?: string | null; placeId?: string | null; sameAsHost?: boolean },
  ): Promise<GroupDetail> {
    const client = await pool.connect();
    let oldQuote: string | null = null;
    try {
      await client.query('BEGIN');
      const { group, member } = await this.requireMembership(groupId, userId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      if (!isConfigurable(group.status)) {
        throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      }
      let lat = Number(input.lat);
      let lng = Number(input.lng);
      let address = input.address ?? null;
      let placeId = input.placeId ?? null;
      let source: 'HOST' | 'SELF' = 'SELF';
      if (input.sameAsHost) {
        const hostMember = await client.query(
          `SELECT * FROM ride_group_members WHERE group_id = $1 AND user_id = $2`,
          [groupId, group.host_id],
        );
        const host = hostMember.rows[0];
        if (!host || numberOrNull(host.pickup_lat) == null) {
          throw new GroupError('HOST_PICKUP_MISSING', 'The host has not chosen a pickup yet', 409);
        }
        lat = Number(host.pickup_lat);
        lng = Number(host.pickup_lng);
        address = host.pickup_address;
        placeId = host.pickup_place_id;
        source = 'HOST';
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new GroupError('INVALID_PICKUP', 'Choose a valid pickup location');
      }
      await client.query(
        `UPDATE ride_group_members
            SET pickup_lat = $3, pickup_lng = $4, pickup_address = $5,
                pickup_place_id = $6, pickup_source = $7, pickup_set_at = NOW(),
                updated_at = NOW()
          WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId, lat, lng, address, placeId, source],
      );
      if (userId === group.host_id && !input.sameAsHost) {
        // Friends who explicitly chose "same pickup as host" follow the
        // host's new pickup. This keeps one physical stop instead of stale
        // duplicated coordinates.
        await client.query(
          `UPDATE ride_group_members
              SET pickup_lat = $3, pickup_lng = $4, pickup_address = $5,
                  pickup_place_id = $6, pickup_set_at = NOW(), updated_at = NOW()
            WHERE group_id = $1 AND user_id <> $2 AND pickup_source = 'HOST'`,
          [groupId, group.host_id, lat, lng, address, placeId],
        );
      }
      await client.query(
        `UPDATE ride_groups SET configuration_version = configuration_version + 1, updated_at = NOW()
          WHERE id = $1`,
        [groupId],
      );
      const user = await client.query(`SELECT full_name FROM users WHERE id = $1`, [userId]);
      await this.recordSystemMessage(
        client,
        groupId,
        `${user.rows[0]?.full_name ?? 'A member'} selected ${input.sameAsHost ? 'the host pickup' : 'their pickup location'}.`,
        { userId, lat, lng },
        'PICKUP',
      );
      oldQuote = await this.invalidateActiveQuote(client, groupId, 'pickup changed');
      await client.query('COMMIT');
      if (oldQuote) await GroupPaymentsService.refundQuotePayments(oldQuote, 'pickup changed');
      await emitGroupUpdated(groupId);
      return this.getGroup(groupId, userId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async setDestination(
    groupId: string,
    hostId: string,
    input: { lat: number; lng: number; address: string; placeId?: string | null },
  ): Promise<GroupDetail> {
    const client = await pool.connect();
    let oldQuote: string | null = null;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, hostId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      if (!isConfigurable(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      const lat = Number(input.lat);
      const lng = Number(input.lng);
      const address = String(input.address ?? '').trim().slice(0, 500);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !address) {
        throw new GroupError('INVALID_DESTINATION', 'Choose a valid destination');
      }
      await client.query(
        `UPDATE ride_groups
            SET destination_lat = $2, destination_lng = $3, destination_address = $4,
                destination_place_id = $5, configuration_version = configuration_version + 1,
                status = CASE WHEN status = 'COLLECTING_MEMBERS' THEN 'CONFIGURING' ELSE status END,
                updated_at = NOW()
          WHERE id = $1`,
        [groupId, lat, lng, address, input.placeId ?? null],
      );
      await this.recordSystemMessage(client, groupId, `The destination was updated to ${address}.`, {}, 'ROUTE');
      oldQuote = await this.invalidateActiveQuote(client, groupId, 'destination changed');
      await client.query('COMMIT');
      if (oldQuote) await GroupPaymentsService.refundQuotePayments(oldQuote, 'destination changed');
      await emitGroupUpdated(groupId);
      return this.getGroup(groupId, hostId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Mark the active quote superseded and clear the group's payment gate. */
  static async invalidateActiveQuote(
    client: any,
    groupId: string,
    reason: string,
  ): Promise<string | null> {
    const res = await client.query(
      `SELECT * FROM ride_group_quotes
        WHERE group_id = $1 AND status = 'ACTIVE'
        ORDER BY version DESC LIMIT 1 FOR UPDATE`,
      [groupId],
    );
    const quote = res.rows[0];
    if (!quote) return null;
    await client.query(
      `UPDATE ride_group_quotes SET status = 'SUPERSEDED' WHERE id = $1`,
      [quote.id],
    );
    await client.query(
      `UPDATE ride_group_payments SET status = 'CANCELLED', updated_at = NOW()
        WHERE quote_id = $1 AND status IN ('PENDING','PROCESSING','FAILED')`,
      [quote.id],
    );
    await client.query(
      `UPDATE ride_group_members SET payment_status = 'NOT_REQUIRED', updated_at = NOW()
        WHERE group_id = $1`,
      [groupId],
    );
    await client.query(
      `UPDATE ride_groups
          SET current_quote_id = NULL, status = 'CONFIGURING', updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('RIDE_REQUESTED','DRIVER_MATCHING','DRIVER_ASSIGNED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED')`,
      [groupId],
    );
    await this.recordSystemMessage(
      client,
      groupId,
      `The fare split was invalidated (${reason}). A new quote is required.`,
      { quoteId: quote.id, reason },
      'PAYMENT',
    );
    return quote.id;
  }

  // ------------------------------------------------------------------
  // Invitations
  // ------------------------------------------------------------------
  /** Pending group invitations addressed to the authenticated rider. */
  static async listIncomingInvitations(userId: string): Promise<any[]> {
    const user = await pool.query(
      `SELECT phone_number, phone_verified FROM users WHERE id = $1`,
      [userId],
    );
    const verifiedPhone = user.rows[0]?.phone_verified
      ? normalizePhone(user.rows[0]?.phone_number)
      : null;
    const res = await pool.query(
      `SELECT i.*, g.name AS group_name, g.status AS group_status,
              u.full_name AS inviter_name,
              (SELECT COUNT(*)::int FROM ride_group_members m
                WHERE m.group_id = i.group_id
                  AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')) AS participant_count
         FROM ride_group_invitations i
         JOIN ride_groups g ON g.id = i.group_id
         JOIN users u ON u.id = i.inviter_id
        WHERE i.status = 'PENDING'
          AND i.expires_at > NOW()
          AND g.status NOT IN ('COMPLETED','CANCELLED','EXPIRED')
          AND (
            i.invited_user_id = $1::uuid
            OR (i.invited_user_id IS NULL AND i.invited_phone = $2)
          )
        ORDER BY i.created_at DESC
        LIMIT 50`,
      [userId, verifiedPhone],
    );
    return res.rows.map((row: any) => ({
      id: row.id,
      groupId: row.group_id,
      groupName: row.group_name,
      groupStatus: row.group_status,
      inviterName: row.inviter_name,
      participantCount: Number(row.participant_count ?? 0),
      expiresAt: iso(row.expires_at),
      createdAt: iso(row.created_at),
    }));
  }

  static async inviteFriend(
    groupId: string,
    inviterId: string,
    invitedUserId: string,
  ): Promise<{ invitation: any }> {
    if (!FriendsService.isUuid(invitedUserId)) throw new GroupError('INVALID_FRIEND', 'Invalid friend');
    if (invitedUserId === inviterId) throw new GroupError('INVALID_FRIEND', 'You are already in the group');
    const settings = await getGroupSettings();
    const client = await pool.connect();
    let invitation: any;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, inviterId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      const friend = await client.query(
        `SELECT 1 FROM friendships
          WHERE user_low = LEAST($1::uuid,$2::uuid)
            AND user_high = GREATEST($1::uuid,$2::uuid)
            AND status = 'ACCEPTED'`,
        [inviterId, invitedUserId],
      );
      if (!friend.rows[0]) throw new GroupError('NOT_FRIENDS', 'You can only invite accepted friends', 403);
      const existingMember = await client.query(
        `SELECT 1 FROM ride_group_members
          WHERE group_id = $1 AND user_id = $2
            AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [groupId, invitedUserId],
      );
      if (existingMember.rows[0]) throw new GroupError('ALREADY_MEMBER', 'That friend is already in this group', 409);
      const pendingInvite = await client.query(
        `SELECT 1 FROM ride_group_invitations
          WHERE group_id = $1 AND invited_user_id = $2 AND status = 'PENDING'`,
        [groupId, invitedUserId],
      );
      if (pendingInvite.rows[0]) {
        throw new GroupError('ALREADY_INVITED', 'That friend already has a pending invitation', 409);
      }
      const active = await client.query(
        `SELECT COUNT(*)::int AS c FROM ride_group_members
          WHERE group_id = $1 AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [groupId],
      );
      const pending = await client.query(
        `SELECT COUNT(*)::int AS c FROM ride_group_invitations
          WHERE group_id = $1 AND status = 'PENDING'`,
        [groupId],
      );
      if (Number(active.rows[0].c) + Number(pending.rows[0].c) >= settings.maxParticipants) {
        throw new GroupError('GROUP_FULL', 'This group is full', 409);
      }
      const target = await client.query(`SELECT id, full_name, phone_number FROM users WHERE id = $1`, [invitedUserId]);
      if (!target.rows[0]) throw new GroupError('INVALID_FRIEND', 'That friend is unavailable', 404);
      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + settings.inviteTtlSeconds * 1000);
      const ins = await client.query(
        `INSERT INTO ride_group_invitations
           (group_id, inviter_id, invited_user_id, invited_phone, invited_name, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          groupId,
          inviterId,
          invitedUserId,
          target.rows[0].phone_number ?? null,
          target.rows[0].full_name ?? null,
          hashInviteToken(token),
          expiresAt,
        ],
      );
      invitation = ins.rows[0];
      const inviter = await client.query(`SELECT full_name FROM users WHERE id = $1`, [inviterId]);
      await this.recordSystemMessage(
        client,
        groupId,
        `${inviter.rows[0]?.full_name ?? 'The host'} invited ${target.rows[0].full_name}.`,
        { invitationId: invitation.id, userId: invitedUserId },
        'INVITATION',
      );
      await client.query('COMMIT');

      await notifyUser({
        userId: invitedUserId,
        role: 'rider',
        type: 'group_invitation',
        title: `${inviter.rows[0]?.full_name ?? 'A friend'} invited you to a group ride`,
        body: `Join "${group.name}" to coordinate pickups and split the fare.`,
        data: { groupId, invitationId: invitation.id, route: '/groups' },
        eventId: `group-invite:${invitation.id}`,
      }).catch(() => undefined);
      emitGroupInvitation(invitedUserId, { groupId, invitationId: invitation.id, groupName: group.name });
      await emitGroupUpdated(groupId);
      return {
        invitation: {
          id: invitation.id,
          groupId,
          invitedUserId,
          invitedName: target.rows[0].full_name,
          status: invitation.status,
          expiresAt: iso(invitation.expires_at),
        },
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async inviteContact(
    groupId: string,
    inviterId: string,
    input: { phone: string; name?: string; message?: string },
  ): Promise<{ invitation: any; message: string; inviteUrl: string }> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new GroupError('INVALID_PHONE', 'That phone number is not valid');
    const settings = await getGroupSettings();
    const client = await pool.connect();
    let invitation: any;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, inviterId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      const existing = await client.query(
        `SELECT i.*, u.full_name AS invited_user_name
           FROM ride_group_invitations i
           LEFT JOIN users u ON u.id = i.invited_user_id
          WHERE i.group_id = $1 AND i.status = 'PENDING'
            AND (i.invited_phone = $2 OR i.invited_user_id = (SELECT id FROM users WHERE phone_number = $2 LIMIT 1))
          LIMIT 1`,
        [groupId, phone],
      );
      // Only hashes are stored, so an existing pending invitation cannot
      // return its original link. Re-issue the SAME row with a fresh token
      // (the old link stops working immediately) instead of leaving two
      // pending invites for the same contact.
      const existingInvitation = existing.rows[0] ?? null;
      const active = await client.query(
        `SELECT COUNT(*)::int AS c FROM ride_group_members
          WHERE group_id = $1 AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [groupId],
      );
      const pending = await client.query(
        `SELECT COUNT(*)::int AS c FROM ride_group_invitations
          WHERE group_id = $1 AND status = 'PENDING'
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [groupId, existingInvitation?.id ?? null],
      );
      if (Number(active.rows[0].c) + Number(pending.rows[0].c) >= settings.maxParticipants) {
        throw new GroupError('GROUP_FULL', 'This group is full', 409);
      }
      const registered = await client.query(
        `SELECT id, full_name FROM users
          WHERE phone_number = $1 AND phone_verified = TRUE AND is_active IS NOT FALSE
          LIMIT 1`,
        [phone],
      );
      const invitedUserId = registered.rows[0]?.id ?? null;
      if (invitedUserId) {
        const already = await client.query(
          `SELECT 1 FROM ride_group_members
            WHERE group_id = $1 AND user_id = $2
              AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
          [groupId, invitedUserId],
        );
        if (already.rows[0]) throw new GroupError('ALREADY_MEMBER', 'That contact is already in the group', 409);
      }
      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + settings.inviteTtlSeconds * 1000);
      const invitedName =
        String(input.name ?? '').slice(0, 120) || registered.rows[0]?.full_name || null;
      const tokenHash = hashInviteToken(token);
      if (existingInvitation) {
        const upd = await client.query(
          `UPDATE ride_group_invitations
              SET inviter_id = $2, invited_user_id = $3, invited_phone = $4,
                  invited_name = $5, token_hash = $6, expires_at = $7
            WHERE id = $1 AND status = 'PENDING'
            RETURNING *`,
          [
            existingInvitation.id,
            inviterId,
            invitedUserId,
            phone,
            invitedName,
            tokenHash,
            expiresAt,
          ],
        );
        invitation = upd.rows[0];
        if (!invitation) {
          throw new GroupError('INVITATION_REVOKED', 'That invitation was just cancelled. Try again.', 409);
        }
      } else {
        const ins = await client.query(
          `INSERT INTO ride_group_invitations
             (group_id, inviter_id, invited_user_id, invited_phone, invited_name, token_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [
            groupId,
            inviterId,
            invitedUserId,
            phone,
            invitedName,
            tokenHash,
            expiresAt,
          ],
        );
        invitation = ins.rows[0];
      }
      const inviter = await client.query(`SELECT full_name FROM users WHERE id = $1`, [inviterId]);
      await this.recordSystemMessage(
        client,
        groupId,
        `${inviter.rows[0]?.full_name ?? 'The host'} invited a contact.`,
        { invitationId: invitation.id, phone },
        'INVITATION',
      );
      await client.query('COMMIT');

      const sms = buildGroupInviteSms({
        inviterName: inviter.rows[0]?.full_name ?? 'A friend',
        groupName: group.name,
        token,
      });
      if (invitedUserId) {
        await notifyUser({
          userId: invitedUserId,
          role: 'rider',
          type: 'group_invitation',
          title: `${inviter.rows[0]?.full_name ?? 'A friend'} invited you to a group ride`,
          body: `Join "${group.name}" to coordinate pickups and split the fare.`,
          data: { groupId, invitationId: invitation.id, route: '/groups' },
          eventId: `group-invite:${invitation.id}:${tokenHash.slice(0, 12)}`,
        }).catch(() => undefined);
        emitGroupInvitation(invitedUserId, { groupId, invitationId: invitation.id, groupName: group.name });
      }
      await emitGroupUpdated(groupId);
      const link = buildGroupInviteLink(token);
      return {
        invitation: {
          id: invitation.id,
          groupId,
          invitedPhone: phone,
          invitedName: invitation.invited_name,
          status: invitation.status,
          expiresAt: iso(invitation.expires_at),
        },
        message: input.message?.trim()
          ? `${input.message.trim().slice(0, 300)}\n\n${sms}`
          : sms,
        inviteUrl: link,
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async cancelInvitation(
    groupId: string,
    userId: string,
    invitationId: string,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM ride_group_invitations
          WHERE id = $1 AND group_id = $2 AND status = 'PENDING' FOR UPDATE`,
        [invitationId, groupId],
      );
      const invitation = res.rows[0];
      if (!invitation) throw new GroupError('INVITATION_NOT_FOUND', 'Invitation not found', 404);
      if (invitation.inviter_id !== userId) {
        const ctx = await this.requireHost(groupId, userId, client);
        void ctx;
      }
      await client.query(
        `UPDATE ride_group_invitations SET status = 'REVOKED' WHERE id = $1`,
        [invitationId],
      );
      await this.recordSystemMessage(client, groupId, 'A pending invitation was cancelled.', {
        invitationId,
      }, 'INVITATION');
      await client.query('COMMIT');
      await emitGroupUpdated(groupId);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async invitePreview(token: string): Promise<Record<string, any>> {
    const hash = hashInviteToken(token);
    const res = await pool.query(
      `SELECT i.*, g.name AS group_name, g.status AS group_status,
              u.full_name AS inviter_name,
              (SELECT COUNT(*)::int FROM ride_group_members m
                WHERE m.group_id = i.group_id
                  AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')) AS participant_count
         FROM ride_group_invitations i
         JOIN ride_groups g ON g.id = i.group_id
         JOIN users u ON u.id = i.inviter_id
        WHERE i.token_hash = $1`,
      [hash],
    );
    const row = res.rows[0];
    if (!row) return { valid: false, reason: 'This invitation link is not valid' };
    if (row.status !== 'PENDING') return { valid: false, reason: 'This invitation has already been used or revoked' };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'This invitation has expired' };
    return {
      valid: true,
      groupName: row.group_name,
      groupStatus: row.group_status,
      inviterName: String(row.inviter_name ?? '').split(' ')[0] || 'A friend',
      participantCount: Number(row.participant_count ?? 0),
      expiresAt: iso(row.expires_at),
      requiresVerifiedPhone: !!row.invited_phone,
    };
  }

  static async acceptInvitationById(
    userId: string,
    invitationId: string,
  ): Promise<{ groupId: string }> {
    return this.acceptInvitationInternal(userId, { id: invitationId });
  }

  static async acceptInvitationByToken(
    userId: string,
    token: string,
  ): Promise<{ groupId: string }> {
    return this.acceptInvitationInternal(userId, { tokenHash: hashInviteToken(token) });
  }

  private static async acceptInvitationInternal(
    userId: string,
    key: { id?: string; tokenHash?: string },
  ): Promise<{ groupId: string }> {
    const client = await pool.connect();
    let groupId = '';
    let groupName = '';
    let hostId = '';
    let systemMessage = '';
    let oldQuoteId: string | null = null;
    try {
      await client.query('BEGIN');
      const invRes = await client.query(
        key.id
          ? `SELECT * FROM ride_group_invitations WHERE id = $1::uuid FOR UPDATE`
          : `SELECT * FROM ride_group_invitations WHERE token_hash = $1 FOR UPDATE`,
        [key.id ?? key.tokenHash],
      );
      const invitation = invRes.rows[0];
      if (!invitation) throw new GroupError('INVITATION_NOT_FOUND', 'This invitation is no longer valid', 404);
      if (invitation.status === 'ACCEPTED' && invitation.invited_user_id === userId) {
        await client.query('COMMIT');
        return { groupId: invitation.group_id };
      }
      if (invitation.status !== 'PENDING') {
        throw new GroupError('INVITATION_USED', 'This invitation has already been used or revoked', 410);
      }
      if (new Date(invitation.expires_at).getTime() <= Date.now()) {
        await client.query(
          `UPDATE ride_group_invitations SET status = 'EXPIRED' WHERE id = $1`,
          [invitation.id],
        );
        await client.query('COMMIT');
        throw new GroupError('INVITATION_EXPIRED', 'This invitation has expired. Ask the host for a new one.', 410);
      }
      if (invitation.invited_user_id && invitation.invited_user_id !== userId) {
        throw new GroupError('INVITATION_NOT_YOURS', 'This invitation was issued to a different account', 403);
      }
      if (!invitation.invited_user_id && invitation.invited_phone) {
        const user = await client.query(
          `SELECT phone_number, phone_verified FROM users WHERE id = $1`,
          [userId],
        );
        const phone = normalizePhone(user.rows[0]?.phone_number);
        if (!user.rows[0]?.phone_verified || phone !== invitation.invited_phone) {
          throw new GroupError(
            'INVITATION_NOT_YOURS',
            'This invitation was issued to a different phone number. Verify that number to join.',
            403,
          );
        }
      }
      const groupRes = await client.query(
        `SELECT * FROM ride_groups WHERE id = $1 FOR UPDATE`,
        [invitation.group_id],
      );
      const group = groupRes.rows[0];
      if (!group) throw new GroupError('GROUP_NOT_FOUND', 'Group not found', 404);
      if (['CANCELLED', 'COMPLETED', 'EXPIRED'].includes(group.status)) {
        throw new GroupError('GROUP_CLOSED', 'This group is no longer accepting members', 409);
      }
      if (['RIDE_REQUESTED', 'DRIVER_MATCHING', 'DRIVER_ASSIGNED', 'IN_PROGRESS'].includes(group.status)) {
        throw new GroupError(
          'GROUP_LOCKED',
          'This group ride has already been booked and cannot accept new members.',
          409,
        );
      }
      groupId = group.id;
      groupName = group.name;
      hostId = group.host_id;
      const active = await client.query(
        `SELECT COUNT(*)::int AS c FROM ride_group_members
          WHERE group_id = $1 AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')`,
        [groupId],
      );
      const settings = await getGroupSettings();
      if (Number(active.rows[0].c) >= settings.maxParticipants) {
        throw new GroupError('GROUP_FULL', 'This group is full', 409);
      }
      const existing = await client.query(
        `SELECT * FROM ride_group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId],
      );
      if (existing.rows[0]?.status === 'REMOVED') {
        throw new GroupError('REMOVED', 'You were removed from this group by the host', 403);
      }
      if (existing.rows[0]) {
        await client.query(
          `UPDATE ride_group_members
              SET status = 'JOINED', joined_at = COALESCE(joined_at, NOW()),
                  left_at = NULL, updated_at = NOW()
            WHERE group_id = $1 AND user_id = $2`,
          [groupId, userId],
        );
      } else {
        await client.query(
          `INSERT INTO ride_group_members (group_id, user_id, role, status, joined_at)
           VALUES ($1, $2, 'MEMBER', 'JOINED', NOW())`,
          [groupId, userId],
        );
      }
      await client.query(
        `UPDATE ride_group_invitations
            SET status = 'ACCEPTED', accepted_at = NOW(), invited_user_id = COALESCE(invited_user_id, $2)
          WHERE id = $1`,
        [invitation.id, userId],
      );
      await client.query(
        `UPDATE ride_groups SET configuration_version = configuration_version + 1, updated_at = NOW()
          WHERE id = $1`,
        [groupId],
      );
      await FriendsService.ensureAcceptedPair(client, hostId, userId);
      const user = await client.query(`SELECT full_name FROM users WHERE id = $1`, [userId]);
      systemMessage = `${user.rows[0]?.full_name ?? 'A friend'} joined the group.`;
      await this.recordSystemMessage(client, groupId, systemMessage, { userId }, 'MEMBER');
      // A new participant changes the route/fare. Never let an existing
      // quote keep charging the old membership set.
      oldQuoteId = await this.invalidateActiveQuote(client, groupId, 'member joined');
      if (group.status === 'COLLECTING_MEMBERS' || group.status === 'DRAFT') {
        await client.query(
          `UPDATE ride_groups SET status = 'CONFIGURING', updated_at = NOW() WHERE id = $1`,
          [groupId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }

    if (oldQuoteId) {
      await GroupPaymentsService.refundQuotePayments(oldQuoteId, 'member joined');
    }
    await emitGroupUpdated(groupId);
    await notifyUser({
      userId: hostId,
      role: 'rider',
      type: 'group_member_joined',
      title: 'Someone joined your group',
      body: `${groupName}: ${systemMessage}`,
      data: { groupId, route: '/groups' },
      eventId: `group-joined:${groupId}:${userId}`,
    }).catch(() => undefined);
    return { groupId };
  }

  static async declineInvitation(userId: string, invitationId: string): Promise<void> {
    const res = await pool.query(
      `SELECT * FROM ride_group_invitations
        WHERE id = $1::uuid AND status = 'PENDING'
          AND (invited_user_id = $2::uuid OR invited_user_id IS NULL)`,
      [invitationId, userId],
    );
    const invitation = res.rows[0];
    if (!invitation) return;
    await pool.query(
      `UPDATE ride_group_invitations SET status = 'DECLINED' WHERE id = $1`,
      [invitationId],
    );
    await emitGroupUpdated(invitation.group_id);
  }

  // ------------------------------------------------------------------
  // Quotes
  // ------------------------------------------------------------------
  /**
   * Read-only route/fare preview used by the host's vehicle card and custom
   * split editor. It NEVER persists a quote and never invalidates payments;
   * the authoritative quote is still created by createQuote.
   */
  static async previewQuote(
    groupId: string,
    hostId: string,
    input: { promoCode?: string | null },
  ): Promise<Record<string, any>> {
    const context = await this.loadQuoteContext(groupId, hostId);
    const route = await GroupRouteService.plan({
      start: context.hostPickup,
      pickups: context.pickups,
      destination: context.destination,
    });
    const fare = computeEstimate({
      distanceMeters: route.totalDistanceMeters,
      durationSeconds: route.totalDurationSeconds,
    });
    const originalFareCents = Math.round(fare.totalFare * 100);
    let promoDiscountCents = 0;
    let promoCode: string | null = null;
    let promoReason: string | null = null;
    const code = String(input.promoCode ?? '').trim().toUpperCase();
    if (code) {
      const validation = await validatePromo(hostId, code, originalFareCents);
      if (validation.valid) {
        promoDiscountCents = validation.discountCents;
        promoCode = validation.promo.code;
      } else {
        promoReason = validation.reason;
      }
    }
    const distanceByUser = new Map<string, number>();
    for (const stop of route.stops) {
      for (const userId of stop.passengerIds) {
        distanceByUser.set(userId, stop.distanceToDestinationMeters);
      }
    }
    return {
      preview: true,
      // Before driver assignment the only honest origin is the host's
      // pickup. Quotes record this explicitly instead of pretending the
      // future driver's starting location is known.
      estimationOrigin: 'HOST_PICKUP',
      configurationVersion: context.configurationVersion,
      originalFareCents,
      promoDiscountCents,
      discountedTotalCents: Math.max(0, originalFareCents - promoDiscountCents),
      promoCode,
      promoReason,
      currency: 'USD',
      fare,
      route: {
        stops: route.stops,
        geometry: route.geometry,
        totalDistanceMeters: route.totalDistanceMeters,
        totalDurationSeconds: route.totalDurationSeconds,
        engine: route.engine,
      },
      members: context.participants.map((p) => ({
        userId: p.userId,
        distanceMeters: distanceByUser.get(p.userId) ?? 0,
      })),
    };
  }

  static async createQuote(
    groupId: string,
    hostId: string,
    input: {
      splitMethod: GroupSplitMethod;
      promoCode?: string | null;
      customShares?: Record<string, number> | null;
      vehicleCategory?: string;
    },
  ): Promise<GroupDetail> {
    if (!['HOST_PAYS', 'EQUAL', 'DISTANCE', 'CUSTOM'].includes(input.splitMethod)) {
      throw new GroupError('INVALID_SPLIT_METHOD', 'Choose a valid fare split method');
    }
    const vehicleCategory = String(input.vehicleCategory ?? 'CORE').toUpperCase();
    if (!['CORE', 'PREMIUM'].includes(vehicleCategory)) {
      throw new GroupError('INVALID_VEHICLE', 'Choose a valid vehicle');
    }

    // Build the optimized route BEFORE opening the transaction (external
    // routing calls must not hold group row locks).
    const context = await this.loadQuoteContext(groupId, hostId);
    const route = await GroupRouteService.plan({
      start: context.hostPickup,
      pickups: context.pickups,
      destination: context.destination,
    });
    const fare: FareBreakdown = computeEstimate({
      distanceMeters: route.totalDistanceMeters,
      durationSeconds: route.totalDurationSeconds,
    });
    const originalFareCents = Math.round(fare.totalFare * 100);

    let promo: { id: string; code: string; discountCents: number } | null = null;
    const promoCode = String(input.promoCode ?? '').trim().toUpperCase();
    if (promoCode) {
      const validation = await validatePromo(hostId, promoCode, originalFareCents);
      if (!validation.valid) {
        throw new GroupError('PROMO_INVALID', validation.reason, 400);
      }
      promo = {
        id: validation.promo.id,
        code: validation.promo.code,
        discountCents: validation.discountCents,
      };
    }
    const discountedTotalCents = Math.max(0, originalFareCents - (promo?.discountCents ?? 0));

    const distanceByUser = new Map<string, number>();
    for (const stop of route.stops) {
      for (const userId of stop.passengerIds) {
        distanceByUser.set(userId, stop.distanceToDestinationMeters);
      }
    }
    const shareParticipants = context.participants.map((p) => ({
      userId: p.userId,
      distanceMeters: distanceByUser.get(p.userId) ?? 0,
    }));
    const allocation = computeGroupShares({
      totalCents: discountedTotalCents,
      method: input.splitMethod,
      hostId,
      participants: shareParticipants,
      customShares: input.customShares ?? undefined,
    });
    if (!allocation.ok) {
      throw new GroupError(allocation.code, allocation.error, 400);
    }
    const shares = allocation.shares;
    if (sumShares(shares) !== discountedTotalCents) {
      throw new GroupError('ALLOCATION_MISMATCH', 'Fare split did not reconcile with the group total', 500);
    }

    const settings = await getGroupSettings();
    const expiresAt = new Date(Date.now() + settings.quoteTtlSeconds * 1000);
    const client = await pool.connect();
    let oldQuoteId: string | null = null;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, hostId, client, { forUpdate: true });
      if (isRideActive(group.status)) throw new GroupError('GROUP_LOCKED', GROUP_CONFIGURABLE_ERROR, 409);
      if (Number(group.configuration_version ?? 0) !== context.configurationVersion) {
        throw new GroupError(
          'GROUP_CHANGED',
          'The group configuration changed while the fare was being calculated. Try again.',
          409,
        );
      }

      oldQuoteId = await this.invalidateActiveQuote(client, groupId, 'new quote');
      const plan = await GroupRouteService.persist(client, {
        groupId,
        phase: 'ESTIMATE',
        plan: route,
      });
      const versionRes = await client.query(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM ride_group_quotes WHERE group_id = $1`,
        [groupId],
      );
      const version = Number(versionRes.rows[0]?.version ?? 1);
      const quoteRes = await client.query(
        `INSERT INTO ride_group_quotes (
           group_id, version, status, route_plan_id, split_method, vehicle_category,
           currency, original_fare_cents, promo_discount_cents, discounted_total_cents,
           promo_id, promo_code, pickup_snapshot, fare_components, route_snapshot,
           expires_at, created_by
         ) VALUES (
           $1,$2,'ACTIVE',$3,$4,$5,'USD',$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15
         ) RETURNING *`,
        [
          groupId,
          version,
          plan.id,
          input.splitMethod,
          vehicleCategory,
          originalFareCents,
          promo?.discountCents ?? 0,
          discountedTotalCents,
          promo?.id ?? null,
          promo?.code ?? null,
          JSON.stringify(context.participants.map((p) => {
            const pickup = context.pickups.find((x) => x.userId === p.userId);
            return {
              userId: p.userId,
              lat: pickup?.lat ?? null,
              lng: pickup?.lng ?? null,
              address: pickup?.address ?? null,
            };
          })),
          JSON.stringify({
            fare: {
              distanceMiles: fare.distanceMiles,
              durationMinutes: fare.durationMinutes,
              baseFare: fare.baseFare,
              distanceFare: fare.distanceFare,
              timeFare: fare.timeFare,
              bookingFee: fare.bookingFee,
              surgeMultiplier: fare.surgeMultiplier,
              serviceFee: fare.serviceFee,
              taxes: fare.taxes,
              totalFare: fare.totalFare,
              currency: fare.currency,
              multiplierBreakdown: fare.multiplierBreakdown,
            },
            originalFareCents,
            promoDiscountCents: promo?.discountCents ?? 0,
            discountedTotalCents,
            vehicleCategory,
            splitMethod: input.splitMethod,
          }),
          JSON.stringify({
            planId: plan.id,
            version: plan.version,
            distanceMeters: route.totalDistanceMeters,
            durationSeconds: route.totalDurationSeconds,
            stops: route.stops,
            geometry: route.geometry,
            engine: route.engine,
            estimationOrigin: 'HOST_PICKUP',
          }),
          expiresAt,
          hostId,
        ],
      );
      const quote = quoteRes.rows[0];
      for (const share of shares) {
        await client.query(
          `INSERT INTO ride_group_quote_shares
             (quote_id, user_id, amount_cents, distance_meters, weight, required)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            quote.id,
            share.userId,
            share.amountCents,
            share.distanceMeters,
            share.weight,
            share.required,
          ],
        );
        await client.query(
          `INSERT INTO ride_group_payments
             (group_id, quote_id, participant_id, amount_cents, currency, status, method)
           VALUES ($1,$2,$3,$4,'USD',$5,'NONE')`,
          [
            groupId,
            quote.id,
            share.userId,
            share.amountCents,
            share.amountCents > 0 ? 'PENDING' : 'NOT_REQUIRED',
          ],
        );
      }
      const allFree = shares.every((s) => s.amountCents === 0);
      await client.query(
        `UPDATE ride_groups
            SET current_quote_id = $2, split_method = $3, vehicle_category = $4,
                status = $5, configuration_version = configuration_version + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [groupId, quote.id, input.splitMethod, vehicleCategory, allFree ? 'READY_TO_REQUEST' : 'AWAITING_PAYMENT'],
      );
      await client.query(
        `UPDATE ride_group_members SET payment_status = 'PENDING', updated_at = NOW()
          WHERE group_id = $1 AND user_id = ANY($2::uuid[])`,
        [groupId, shares.filter((s) => s.amountCents > 0).map((s) => s.userId)],
      );
      await this.recordSystemMessage(
        client,
        groupId,
        `The fare split was updated (${input.splitMethod.replace('_', ' ').toLowerCase()}).`,
        { quoteId: quote.id, version, totalCents: discountedTotalCents },
        'PAYMENT',
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }

    if (oldQuoteId) {
      await GroupPaymentsService.refundQuotePayments(oldQuoteId, 'quote replaced');
    }
    const detail = await this.getGroup(groupId, hostId);
    await emitGroupUpdated(groupId, { quoteVersion: detail.quote?.version ?? null });
    await emitGroupPaymentUpdated(groupId, { quoteId: detail.quote?.id ?? null, ready: false });
    for (const userId of context.participants.map((p) => p.userId)) {
      if (userId === hostId) continue;
      await notifyUser({
        userId,
        role: 'rider',
        type: 'group_payment',
        title: 'Your group fare share is ready',
        body: `${detail.name}: review and confirm your $${fmtMoney(detail.myShare?.amountCents ?? 0)} share.`,
        data: { groupId, route: '/groups' },
        eventId: `group-payment:${detail.quote?.id}:${userId}`,
      }).catch(() => undefined);
    }
    return detail;
  }

  private static async loadQuoteContext(groupId: string, hostId: string): Promise<{
    group: any;
    configurationVersion: number;
    participants: Array<{ userId: string; name: string }>;
    pickups: GroupPickupPoint[];
    hostPickup: { lat: number; lng: number };
    destination: { lat: number; lng: number; address: string };
  }> {
    const { group } = await this.requireHost(groupId, hostId);
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(group.status)) {
      throw new GroupError('GROUP_CLOSED', 'This group is closed.', 409);
    }
    if (numberOrNull(group.destination_lat) == null || numberOrNull(group.destination_lng) == null) {
      throw new GroupError('NO_DESTINATION', 'Choose the shared destination first', 409);
    }
    const members = await pool.query(
      `SELECT m.user_id, m.pickup_lat, m.pickup_lng, m.pickup_address, m.pickup_place_id,
              u.full_name
         FROM ride_group_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1
          AND m.status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')
        ORDER BY CASE WHEN m.user_id = $2::uuid THEN 0 ELSE 1 END, m.joined_at ASC`,
      [groupId, hostId],
    );
    if (members.rows.length === 0) throw new GroupError('NO_PARTICIPANTS', 'The group has no participants');
    const missing = members.rows.filter((r: any) => numberOrNull(r.pickup_lat) == null || numberOrNull(r.pickup_lng) == null);
    if (missing.length > 0) {
      throw new GroupError(
        'PICKUP_PENDING',
        `Waiting for ${missing.map((m: any) => m.full_name).join(', ')} to choose a pickup location`,
        409,
      );
    }
    const host = members.rows.find((r: any) => r.user_id === hostId);
    return {
      group,
      configurationVersion: Number(group.configuration_version ?? 0),
      participants: members.rows.map((r: any) => ({ userId: r.user_id, name: r.full_name })),
      pickups: members.rows.map((r: any) => ({
        userId: r.user_id,
        name: r.full_name,
        lat: Number(r.pickup_lat),
        lng: Number(r.pickup_lng),
        address: r.pickup_address ?? '',
        placeId: r.pickup_place_id ?? null,
      })),
      hostPickup: { lat: Number(host.pickup_lat), lng: Number(host.pickup_lng) },
      destination: {
        lat: Number(group.destination_lat),
        lng: Number(group.destination_lng),
        address: group.destination_address ?? '',
      },
    };
  }

  static async cancelGroup(groupId: string, userId: string): Promise<void> {
    const client = await pool.connect();
    let rideId: string | null = null;
    try {
      await client.query('BEGIN');
      const { group } = await this.requireHost(groupId, userId, client, { forUpdate: true });
      if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(group.status)) {
        await client.query('COMMIT');
        return;
      }
      rideId = group.active_ride_id ?? null;
      await client.query(
        `UPDATE ride_groups SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1`,
        [groupId],
      );
      await client.query(
        `UPDATE ride_group_invitations SET status = 'REVOKED'
          WHERE group_id = $1 AND status = 'PENDING'`,
        [groupId],
      );
      await this.recordSystemMessage(client, groupId, 'The host cancelled the group.');
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    if (rideId) {
      const { RideService } = await import('../ride/ride.service');
      const trip = await pool.query(`SELECT status FROM rides WHERE id = $1`, [rideId]);
      if (trip.rows[0] && !['COMPLETED', 'CANCELLED'].includes(trip.rows[0].status)) {
        await RideService.cancelTrip(rideId, userId, {
          reasonCode: 'host_cancelled_group',
          reasonText: 'The host cancelled the group ride.',
          bypassOwnership: true,
        }).catch(() => undefined);
      }
    } else {
      const quotes = await pool.query(
        `SELECT id FROM ride_group_quotes
          WHERE group_id = $1 AND status IN ('ACTIVE','SUPERSEDED','EXPIRED','CONSUMED')`,
        [groupId],
      );
      for (const q of quotes.rows) {
        await GroupPaymentsService.refundQuotePayments(q.id, 'group cancelled');
      }
    }
    await emitGroupUpdated(groupId, { cancelled: true });
  }

  static async notifyMember(
    groupId: string,
    userId: string,
    title: string,
    body: string,
  ): Promise<void> {
    await notifyUser({
      userId,
      role: 'rider',
      type: 'group_ride',
      title,
      body,
      data: { groupId, route: '/groups' },
      eventId: null,
    }).catch(() => undefined);
  }

  /** Called from ride lifecycle hooks (completion / cancellation). */
  static async broadcastGroupRide(groupId: string, payload: Record<string, unknown>): Promise<void> {
    const { emitGroupRideUpdated } = await import('./group-events');
    await emitGroupRideUpdated(groupId, payload);
    try {
      const ids = await groupMemberIds(groupId);
      for (const id of ids) {
        getIo().to(`rider:${id}`).emit('groupRideUpdated', { groupId, ...payload });
      }
      const ride = await pool.query(
        `SELECT driver_id FROM rides WHERE group_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [groupId],
      );
      const driverId = ride.rows[0]?.driver_id;
      if (driverId) {
        getIo().to(`driver:${driverId}`).emit('groupRideUpdated', { groupId, ...payload });
      }
    } catch {
      /* optional */
    }
  }

  /** Utility used by the rider app's "I have no balance" UI. */
  static async creditBalance(userId: string): Promise<number> {
    const account = await CreditsService.getAccount(userId);
    return account.balance_cents;
  }

}
