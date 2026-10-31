// backend/src/modules/groups/friends.service.ts
//
// Friends are NetRide accounts with an accepted, canonical friendship row.
// There is intentionally NO public user search: an account can only be
// discovered from a phone number the caller already selected in the native
// contact picker, and only when that number belongs to a VERIFIED NetRide
// account.

import { pool } from '../../config/database';
import { getIo } from '../../gateway/io-handle';
import { notifyUser } from '../../services/notification.service';
import { normalizePhone } from './group-invite.util';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FriendCandidate {
  userId: string;
  fullName: string;
  profileImageUrl: string | null;
  phone: string | null;
  matchedPhone: string;
}

export interface FriendEntry {
  friendshipId: string;
  userId: string;
  fullName: string;
  profileImageUrl: string | null;
  phone: string | null;
  status: 'ACCEPTED';
  since: string | null;
}

export class FriendsService {
  static isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
  }

  /** Canonical pair helpers keep one row per unordered pair. */
  static pairSql(): string {
    return `LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid)`;
  }

  static async list(userId: string): Promise<{
    friends: FriendEntry[];
    incoming: FriendEntry[];
    outgoing: FriendEntry[];
  }> {
    const res = await pool.query(
      `SELECT f.id, f.status, f.requested_by, f.created_at, f.updated_at,
              CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END AS other_id,
              u.full_name, u.profile_image_url, u.phone_number
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_low = $1::uuid THEN f.user_high ELSE f.user_low END
        WHERE (f.user_low = $1::uuid OR f.user_high = $1::uuid)
          AND f.status IN ('PENDING', 'ACCEPTED')
          AND u.is_active IS NOT FALSE
        ORDER BY f.updated_at DESC`,
      [userId],
    );
    const friends: FriendEntry[] = [];
    const incoming: FriendEntry[] = [];
    const outgoing: FriendEntry[] = [];
    for (const row of res.rows) {
      const entry: FriendEntry = {
        friendshipId: row.id,
        userId: row.other_id,
        fullName: row.full_name,
        profileImageUrl: row.profile_image_url ?? null,
        phone: row.phone_number ?? null,
        status: 'ACCEPTED',
        since: row.status === 'ACCEPTED' ? row.updated_at : null,
      };
      if (row.status === 'ACCEPTED') friends.push(entry);
      else if (row.requested_by === userId) outgoing.push(entry);
      else incoming.push(entry);
    }
    return { friends, incoming, outgoing };
  }

  /**
   * Match ONLY the phone numbers explicitly supplied by the caller. This is
   * the contact-invite entry point — never a directory search.
   */
  static async matchSelectedContacts(
    userId: string,
    contacts: Array<{ phone: string; name?: string }>,
  ): Promise<FriendCandidate[]> {
    const normalized = new Map<string, string>();
    for (const contact of contacts) {
      const phone = normalizePhone(contact.phone);
      if (phone) normalized.set(phone, String(contact.name ?? '').slice(0, 120));
    }
    if (normalized.size === 0) return [];
    if (normalized.size > 50) {
      throw new Error('Select at most 50 contacts at a time');
    }
    const phones = Array.from(normalized.keys());
    const res = await pool.query(
      `SELECT id, full_name, profile_image_url, phone_number
         FROM users
        WHERE phone_number = ANY($1::text[])
          AND phone_verified = TRUE
          AND id <> $2::uuid
          AND is_active IS NOT FALSE
        LIMIT 50`,
      [phones, userId],
    );
    return res.rows.map((row: any) => ({
      userId: row.id,
      fullName: row.full_name,
      profileImageUrl: row.profile_image_url ?? null,
      phone: row.phone_number,
      matchedPhone: row.phone_number,
    }));
  }

  static async requestByPhone(userId: string, phone: string): Promise<{ userId: string; status: string }> {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new Error('That phone number is not valid');
    const res = await pool.query(
      `SELECT id FROM users
        WHERE phone_number = $1 AND phone_verified = TRUE
          AND is_active IS NOT FALSE AND id <> $2::uuid
        LIMIT 1`,
      [normalized, userId],
    );
    const target = res.rows[0]?.id;
    if (!target) throw new Error('That contact is not on NetRide yet');
    return this.requestByUserId(userId, target);
  }

  static async requestByUserId(userId: string, targetId: string): Promise<{ userId: string; status: string }> {
    if (!this.isUuid(targetId)) throw new Error('A valid friend is required');
    if (targetId === userId) throw new Error('You cannot add yourself as a friend');
    const target = await pool.query(
      `SELECT id, full_name, is_active FROM users WHERE id = $1::uuid`,
      [targetId],
    );
    if (!target.rows[0] || target.rows[0].is_active === false) {
      throw new Error('That NetRide account is unavailable');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the unordered pair by locking both user rows in a stable
      // order, then use an UPSERT on the canonical unique pair.
      const lowFirst = userId < targetId;
      await client.query(
        `SELECT id FROM users WHERE id IN ($1::uuid, $2::uuid) ORDER BY id FOR UPDATE`,
        [lowFirst ? userId : targetId, lowFirst ? targetId : userId],
      );
      const existing = await client.query(
        `SELECT id, status, requested_by FROM friendships
          WHERE user_low = LEAST($1::uuid, $2::uuid)
            AND user_high = GREATEST($1::uuid, $2::uuid)
          FOR UPDATE`,
        [userId, targetId],
      );
      const row = existing.rows[0];
      if (row?.status === 'ACCEPTED') {
        await client.query('COMMIT');
        return { userId: targetId, status: 'ACCEPTED' };
      }
      if (row?.status === 'BLOCKED') {
        throw new Error('This account cannot be added');
      }
      if (row?.status === 'PENDING') {
        if (row.requested_by === userId) {
          await client.query('COMMIT');
          return { userId: targetId, status: 'PENDING' };
        }
        // They already asked us: accepting is the natural idempotent result.
        await client.query(
          `UPDATE friendships SET status = 'ACCEPTED', updated_at = NOW() WHERE id = $1`,
          [row.id],
        );
        await client.query('COMMIT');
        await this.notifyAccepted(userId, targetId);
        return { userId: targetId, status: 'ACCEPTED' };
      }

      let friendshipId: string;
      if (row) {
        const upd = await client.query(
          `UPDATE friendships
              SET status = 'PENDING', requested_by = $2::uuid, updated_at = NOW()
            WHERE id = $1 RETURNING id`,
          [row.id, userId],
        );
        friendshipId = upd.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO friendships (user_low, user_high, requested_by, status)
           VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $1::uuid, 'PENDING')
           RETURNING id`,
          [userId, targetId],
        );
        friendshipId = ins.rows[0].id;
      }
      await client.query('COMMIT');

      const me = await pool.query(`SELECT full_name FROM users WHERE id = $1::uuid`, [userId]);
      const myName = me.rows[0]?.full_name ?? 'A NetRide rider';
      await notifyUser({
        userId: targetId,
        role: 'rider',
        type: 'friend_request',
        title: 'New friend request',
        body: `${myName} wants to connect on NetRide.`,
        data: { friendshipId, requesterId: userId, route: '/groups' },
        eventId: `friend-request:${friendshipId}`,
      }).catch(() => undefined);
      try {
        getIo().to(`rider:${targetId}`).emit('friendRequestReceived', { friendshipId, requesterId: userId });
      } catch {
        /* socket optional */
      }
      return { userId: targetId, status: 'PENDING' };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async respond(userId: string, friendshipId: string, accept: boolean): Promise<{ status: string }> {
    if (!this.isUuid(friendshipId)) throw new Error('Invalid friend request');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM friendships
          WHERE id = $1::uuid AND status = 'PENDING'
            AND (user_low = $2::uuid OR user_high = $2::uuid)
            AND requested_by <> $2::uuid
          FOR UPDATE`,
        [friendshipId, userId],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 'ALREADY_RESOLVED' };
      }
      const status = accept ? 'ACCEPTED' : 'DECLINED';
      await client.query(
        `UPDATE friendships SET status = $2, updated_at = NOW() WHERE id = $1`,
        [friendshipId, status],
      );
      await client.query('COMMIT');
      const other = row.user_low === userId ? row.user_high : row.user_low;
      if (accept) await this.notifyAccepted(userId, other);
      return { status };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async remove(userId: string, targetId: string): Promise<void> {
    if (!this.isUuid(targetId)) throw new Error('Invalid friend');
    await pool.query(
      `DELETE FROM friendships
        WHERE user_low = LEAST($1::uuid, $2::uuid)
          AND user_high = GREATEST($1::uuid, $2::uuid)
          AND status = 'ACCEPTED'`,
      [userId, targetId],
    );
  }

  /** Accepting a group invitation also establishes the friend relationship. */
  static async ensureAcceptedPair(
    client: any,
    a: string,
    b: string,
  ): Promise<void> {
    if (a === b) return;
    await client.query(
      `INSERT INTO friendships (user_low, user_high, requested_by, status)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), $1::uuid, 'ACCEPTED')
       ON CONFLICT (user_low, user_high) DO UPDATE
         SET status = 'ACCEPTED', updated_at = NOW()
         WHERE friendships.status IN ('PENDING', 'DECLINED')`,
      [a, b],
    );
  }

  /** Best-effort in-app notification that a friendship was accepted. */
  private static async notifyAccepted(accepterId: string, requesterId: string): Promise<void> {
    try {
      const me = await pool.query(`SELECT full_name FROM users WHERE id = $1::uuid`, [accepterId]);
      const name = me.rows[0]?.full_name ?? 'Your friend';
      await notifyUser({
        userId: requesterId,
        role: 'rider',
        type: 'friend_accepted',
        title: 'Friend request accepted',
        body: `${name} is now your NetRide friend.`,
        data: { friendId: accepterId, route: '/groups' },
        eventId: `friend-accepted:${[accepterId, requesterId].sort().join(':')}`,
      });
    } catch {
      /* notifications are non-fatal */
    }
  }
}
