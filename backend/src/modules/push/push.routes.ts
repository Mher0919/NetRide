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
});

// Register / update FCM token
router.post('/register-token', authMiddleware, async (req: AuthRequest, res: Response) => {
  const parsed = registerTokenSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid token payload', details: parsed.error.format() });
  }

  const { token, role } = parsed.data;
  const userRole = role || (req.user?.role === 'DRIVER' ? 'driver' : 'rider');

  try {
    await storeFcmToken(req.user!.id, userRole as 'rider' | 'driver', token);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[PUSH] Failed to register token:', err.message);
    return res.status(500).json({ error: 'Failed to register push token' });
  }
});

// Clear FCM token (on logout)
router.delete('/token', authMiddleware, async (req: AuthRequest, res: Response) => {
  const role = req.user?.role === 'DRIVER' ? 'driver' : 'rider';
  try {
    await clearFcmToken(req.user!.id, role as 'rider' | 'driver');
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[PUSH] Failed to clear token:', err.message);
    return res.status(500).json({ error: 'Failed to clear push token' });
  }
});

export default router;
