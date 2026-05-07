// backend/src/modules/user/user.controller.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import { UserService } from './user.service';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';

export const updateProfileSchema = z.object({
  body: z.object({
    phone_number: z.string().optional(),
    full_name: z.string().optional(),
    profile_image_url: z.string().optional(),
    date_of_birth: z.string().optional(),
  }),
});

export const verifyIdentitySchema = z.object({
  body: z.object({
    id_photo_front_url: z.string().url(),
    id_photo_back_url: z.string().url(),
    date_of_birth: z.string().optional(),
  }),
});

const RequestEmailChangeSchema = z.object({
  newEmail: z.string().email(),
});

export class UserController {
  static async getProfile(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        console.warn('[USER] ❌ No userId in request user object');
        return res.status(401).json({ message: 'Unauthorized' });
      }

      console.log(`[USER] 👤 Fetching profile for ID: ${userId}`);
      const user = await UserService.getProfile(userId);
      if (!user) {
        console.warn(`[USER] ❌ User not found in DB for ID: ${userId}`);
        return res.status(404).json({ message: 'User not found' });
      }

      res.json(user);
    } catch (error: any) {
      console.error(`[USER] ❌ Error in getProfile: ${error.message}`);
      res.status(500).json({ message: error.message });
    }
  }

  static async updateProfile(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });

      const user = await UserService.updateProfile(userId, req.body);
      if (!user) return res.status(404).json({ message: 'User not found' });

      res.json(user);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  static async verifyIdentity(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });

      const { id_photo_front_url, id_photo_back_url, date_of_birth } = req.body;
      
      if (!id_photo_front_url || !id_photo_back_url) {
        return res.status(400).json({ message: 'Both front and back ID photos are required' });
      }

      await UserService.requestVerification(userId, id_photo_front_url, id_photo_back_url, date_of_birth);

      res.json({ message: 'Verification request sent to admin' });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  }

  static async requestEmailChange(req: AuthRequest, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: 'Unauthorized' });

      const { newEmail } = RequestEmailChangeSchema.parse(req.body);
      const result = await AuthService.requestEmailChange(userId, newEmail);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async verifyEmailChange(req: Request, res: Response) {
    try {
      const { token } = req.params;
      const result = await AuthService.verifyEmailChange(token);
      res.send(`
        <div style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Email Updated Successfully!</h1>
          <p>Your email has been verified and updated.</p>
        </div>
      `);
    } catch (error: any) {
      res.status(400).send(`<h1>Error verifying email: ${error.message}</h1>`);
    }
  }
}
