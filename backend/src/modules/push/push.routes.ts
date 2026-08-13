// backend/src/modules/push/push.routes.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../../middleware/auth.middleware';
import { storeFcmToken, clearFcmToken } from '../../services/push-notification.service';

const router = Router();

const registerTokenSchema = z.object({
  token: z.string().min(10).max(4096),
  // 'rider' or 'driver' — defaults to user's JWT role
  role: z.enum(['rider', 'driver']).optional(),
  // Device metadata (multi-device registry since 040)
  platform: z.string().max(64).optional(),
  appVersion: z.string().max(64).optional(),
});

// Register / update FCM token (multi-device: one row per device token)
router.post('/register-token', authMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = registerTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid token payload', details: parsed.error.format() });
  }

  const { token, role, platform, appVersion } = parsed.data;
  const userRole = role || (req.user?.role === 'DRIVER' ? 'driver' : 'rider');

  try {
    await storeFcmToken(req.user!.id, userRole as 'rider' | 'driver', token, {
      platform,
      appVersion,
    });
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[PUSH] Failed to register token:', err.message);
    return res.status(500).json({ error: 'Failed to register push token' });
  }
});

// Clear FCM token(s).
// - No body: clears every token for the user (full logout).
// - { token }: clears only that device's token (partial logout).
router.delete('/token', authMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ token: z.string().min(10).max(4096).optional() }).safeParse(req.body);
  const token = parsed.success ? parsed.data.token : undefined;
  const role = req.user?.role === 'DRIVER' ? 'driver' : 'rider';
  try {
    await clearFcmToken(req.user!.id, role as 'rider' | 'driver', token);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[PUSH] Failed to clear token:', err.message);
    return res.status(500).json({ error: 'Failed to clear push token' });
  }
});

export default router;