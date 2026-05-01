// backend/src/modules/driver/driver.controller.ts
import { Response } from 'express';
import { DriverService } from './driver.service';
import { z } from 'zod';

const OnboardSchema = z.object({
  personalInfo: z.object({
    phone_number: z.string(),
    date_of_birth: z.string(),
    profile_image_url: z.string().url(),
  }),
  identity: z.object({
    license_number: z.string(),
    license_expiry_date: z.string(),
    license_photo_url: z.string().url(),
    license_photo_back_url: z.string().url(),
    insurance_photo_url: z.string().url(),
    registration_photo_url: z.string().url(),
  }),
  vehicle: z.object({
    vehicle_id: z.string().uuid(),
    license_plate_number: z.string(),
    license_plate_photo_url: z.string().url(),
    car_photo_urls: z.array(z.string().url()).min(2).max(4),
    color: z.string().optional(),
    interior_color: z.string().optional(),
  }),
});

const UpdateProfileSchema = z.object({
  full_name: z.string().optional(),
  phone_number: z.string().optional(),
  date_of_birth: z.string().optional(),
  profile_image_url: z.string().url().optional(),
  license_number: z.string().optional(),
  license_expiry_date: z.string().optional(),
  vehicle_id: z.string().uuid().optional(),
  license_plate_number: z.string().optional(),
});

const VerifyIdentitySchema = z.object({
  license_photo_url: z.string().url(),
  license_photo_back_url: z.string().url(),
  date_of_birth: z.string().optional(),
  license_number: z.string().optional(),
});

export class DriverController {
  static async getProfile(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const profile = await DriverService.getProfile(userId);
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateProfile(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = UpdateProfileSchema.parse(req.body);
      const result = await DriverService.updateProfile(userId, validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async verifyIdentity(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = VerifyIdentitySchema.parse(req.body);
      const result = await DriverService.requestVerification(userId, validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async onboard(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validatedData = OnboardSchema.parse(req.body);
      const result = await DriverService.onboard(userId, validatedData);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getVehicles(req: any, res: Response) {
    try {
      const vehicles = await DriverService.getVehicles();
      res.json(vehicles);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
