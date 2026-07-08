// backend/src/modules/ride/ride_messages.repository.ts
//
// Thin data layer for the `ride_messages` table (see migration
// 20260628_add_ride_messages.sql). Keeps the SQL in one place so the
// socket gateway and the HTTP controller share the same query patterns.
import { pool } from '../../config/database';

export interface RideMessageRow {
  id: string;
  trip_id: string;
  sender_id: string;
  sender_role: 'rider' | 'driver';
  body: string;
  created_at: Date;
}

export class RideMessagesRepository {
  /**
   * Insert a chat message and return the persisted row. The CHECK
   * constraint on `body` (1–1000 chars) and `sender_role` is the final
   * line of defence against malformed payloads — the socket gateway
   * already pre-validates, but a misbehaving controller should still
   * get a SQL error rather than a silent write.
   */
  static async insert(data: {
    trip_id: string;
    sender_id: string;
    sender_role: 'rider' | 'driver';
    body: string;
  }): Promise<RideMessageRow> {
    const res = await pool.query(
      `INSERT INTO ride_messages (trip_id, sender_id, sender_role, body)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [data.trip_id, data.sender_id, data.sender_role, data.body],
    );
    return res.rows[0];
  }

  /**
   * Fetch the chat history for a trip, oldest-first. Optional `since`
   * lets the chat sheet append only new rows on reconnect instead of
   * re-downloading the full thread.
   */
  static async listByTrip(
    tripId: string,
    opts: { since?: Date; limit?: number } = {},
  ): Promise<RideMessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    if (opts.since) {
      const res = await pool.query(
        `SELECT * FROM ride_messages
          WHERE trip_id = $1 AND created_at > $2
          ORDER BY created_at ASC
          LIMIT $3`,
        [tripId, opts.since, limit],
      );
      return res.rows;
    }
    const res = await pool.query(
      `SELECT * FROM ride_messages
        WHERE trip_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [tripId, limit],
    );
    return res.rows;
  }
}