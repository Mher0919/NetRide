// backend/src/services/audit-events.service.ts
//
// Generic admin audit trail for non-user entities (partners, promos,
// credits, referrals). The legacy `audit_logs` table stays for user-targeted
// events; `audit_events` covers everything else with a JSONB details blob.

import { pool } from '../config/database';

export interface AuditEventInput {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export class AuditEventsService {
  static async record(input: AuditEventInput): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO audit_events (actor_id, actor_role, action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          input.actorId ?? null,
          input.actorRole ?? null,
          input.action,
          input.entityType,
          input.entityId ?? null,
          JSON.stringify(input.details ?? {}),
        ],
      );
    } catch (err: any) {
      console.error(`[AUDIT] ⚠️ audit event not recorded (${input.action}): ${err.message}`);
    }
  }
}
