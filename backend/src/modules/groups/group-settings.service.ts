import { pool } from '../../config/database';

export interface GroupSettings {
  maxParticipants: number;
  quoteTtlSeconds: number;
  inviteTtlSeconds: number;
  routePlanTtlSeconds: number;
}

const FALLBACK: GroupSettings = {
  maxParticipants: 5,
  quoteTtlSeconds: 1200,
  inviteTtlSeconds: 604800,
  routePlanTtlSeconds: 1800,
};

let cache: { value: GroupSettings; at: number } | null = null;
const TTL_MS = 60_000;

export async function getGroupSettings(force = false): Promise<GroupSettings> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const res = await pool.query(
      `SELECT max_participants, quote_ttl_seconds, invite_ttl_seconds,
              route_plan_ttl_seconds
         FROM ride_group_settings WHERE id = 1`,
    );
    const row = res.rows[0];
    const value: GroupSettings = row
      ? {
          maxParticipants: Math.min(5, Math.max(2, Number(row.max_participants))),
          quoteTtlSeconds: Math.max(60, Number(row.quote_ttl_seconds)),
          inviteTtlSeconds: Math.max(300, Number(row.invite_ttl_seconds)),
          routePlanTtlSeconds: Math.max(60, Number(row.route_plan_ttl_seconds)),
        }
      : FALLBACK;
    cache = { value, at: Date.now() };
    return value;
  } catch {
    return FALLBACK;
  }
}

export function invalidateGroupSettingsCache(): void {
  cache = null;
}
