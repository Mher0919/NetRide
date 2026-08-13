// backend/src/modules/notifications/notifications.routes.ts
//
// IN-APP NOTIFICATION HISTORY — the persisted counterpart of every real
// push notification (ride accepted / driver arrived / trip started / ride
// completed / ride cancelled / credits earned / referral rewards).
//
//   GET  /api/notifications?limit=50     → history (newest first)
//   POST /api/notifications/read         → mark one or many as read
//   GET  /api/notifications/unread-count → badge for the app icon/header
//
// Auth: any authenticated user; role is resolved from the JWT the same way
// the rest of the API resolves it (rider/driver history is per-role).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from '../../services/notification.service';
import { NotificationRole } from '../../services/notification.service';

const router = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const readBodySchema = z.object({
  id: z.string().uuid().optional(),
  ids: z.array(z.string().uuid()).min(1).max(100).optional(),
}).refine((v) => !!v.id || !!v.ids, { message: 'Provide id or ids' });

function roleFromUser(role: string): NotificationRole {
  return role === 'DRIVER' ? 'driver' : 'rider';
}

router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  try {
    const items = await listNotifications(req.user!.id, roleFromUser(req.user!.role), limit);
    return res.json({ notifications: items });
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Failed to list:', err.message);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.post('/read', authMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = readBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', details: parsed.error.format() });
  }
  const ids = parsed.data.id ? [parsed.data.id] : (parsed.data.ids as string[]);
  try {
    const updated = await markNotificationsRead(req.user!.id, ids);
    return res.json({ updated });
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Failed to mark read:', err.message);
    return res.status(500).json({ error: 'Failed to update notifications' });
  }
});

router.get('/unread-count', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const count = await unreadNotificationCount(req.user!.id, roleFromUser(req.user!.role));
    return res.json({ count });
  } catch (err: any) {
    console.error('[NOTIFICATIONS] Failed to count unread:', err.message);
    return res.status(500).json({ error: 'Failed to count notifications' });
  }
});

export default router;