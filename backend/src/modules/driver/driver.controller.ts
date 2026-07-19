// backend/src/modules/driver/driver.controller.ts
import { Response } from 'express';
import { DriverService } from './driver.service';
import { z } from 'zod';
import { VehicleDataService } from '../../services/vehicleData.service';
import { pool } from '../../config/database';

// Accepts either a full URL or a relative /api/files/{id} path.
const fileUrlSchema = () => z.string().refine(
  v => v.startsWith('/api/files/') || z.string().url().safeParse(v).success,
  { message: 'Must be a valid URL or /api/files/{id} path' }
);

const OnboardSchema = z.object({
  personalInfo: z.object({
    full_name: z.string().optional(),
    phone_number: z.string(),
    date_of_birth: z.string(),
    profile_image_url: fileUrlSchema(),
  }),
  identity: z.object({
    license_photo_url: fileUrlSchema(),
    license_photo_back_url: fileUrlSchema(),
    insurance_photo_url: fileUrlSchema(),
    registration_photo_url: fileUrlSchema(),
  }),
  vehicle: z.object({
    license_plate_number: z.string(),
    license_plate_state: z.string().optional(),
    zip_code: z.string().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    year: z.number().optional(),
    color: z.string().optional(),
    interior_color: z.string().optional(),
  }),
});

const UpdateProfileSchema = z.object({
  full_name: z.string().optional(),
  phone_number: z.string().optional(),
  date_of_birth: z.string().optional(),
  profile_image_url: fileUrlSchema().optional(),
  license_number: z.string().optional(),
  license_expiry_date: z.string().optional(),
  vehicle_id: z.string().uuid().optional(),
  license_plate_number: z.string().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.number().optional(),
  color: z.string().optional(),
  interior_color: z.string().optional(),
});

const VerifyIdentitySchema = z.object({
  license_photo_url: fileUrlSchema(),
  license_photo_back_url: fileUrlSchema(),
  date_of_birth: z.string().optional(),
  license_number: z.string().optional(),
});

const ProfileChangeChangesSchema = z.object({
  full_name: z.string().min(2).max(80).optional(),
  phone_number: z.string().regex(/^\+?[0-9 ()\-]{7,20}$/).optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  profile_image_url: fileUrlSchema().optional(),
  license_number: z.string().min(3).max(40).optional(),
  license_plate_number: z.string().min(1).max(15).optional(),
  license_plate_photo_url: fileUrlSchema().optional(),
  inspection_photo_url: fileUrlSchema().optional(),
  car_photo_urls: z.array(fileUrlSchema()).max(4).optional(),
  make: z.string().min(1).max(40).optional(),
  model: z.string().min(1).max(40).optional(),
  year: z.number().int().min(2011).max(new Date().getFullYear() + 1).optional(),
  color: z.string().min(1).max(40).optional(),
  interior_color: z.string().min(1).max(40).optional(),
  payout_card: z.object({
    card_number: z.string().min(13).max(19),
    exp_month: z.number().int().min(1).max(12),
    exp_year: z.number().int().min(2024).max(2099),
    cvc: z.string().regex(/^\d{3,4}$/),
    cardholder_name: z.string().min(2).max(80),
    zip: z.string().min(3).max(12),
  }).optional(),
}).refine(c => Object.keys(c).length > 0, 'At least one field must be provided');

const ProfileChangeRequestSchema = z.object({
  changes: ProfileChangeChangesSchema,
  reason: z.string().min(1).max(500).optional(),
});

const PayoutCardSchema = z.object({
  card_number: z.string().min(13).max(19),
  exp_month: z.number().int().min(1).max(12),
  exp_year: z.number().int().min(2024).max(2099),
  cvc: z.string().regex(/^\d{3,4}$/),
  cardholder_name: z.string().min(2).max(80),
  zip: z.string().min(3).max(12),
});

const PayoutRequestSchema = z.object({
  amount_cents: z.number().int().positive().max(100_000_00),
});

const SubmitNewVehicleSchema = z.object({
  make: z.string().min(1, 'Vehicle make is required'),
  model: z.string().min(1, 'Vehicle model is required'),
  year: z.number().int().min(2011, 'Vehicle must be 2011 or newer'),
  color: z.string().min(1, 'Color is required'),
  interior_color: z.string().optional(),
  // Verified classification inputs used by the eligibility engine.
  seats: z.number().int().min(1).max(15).optional(),
  is_luxury: z.boolean().optional(),
  license_plate_number: z.string().min(1, 'License plate is required'),
  license_plate_state: z.string().min(1, 'License plate state is required'),
  zip_code: z.string().min(1, 'ZIP code is required'),
  registration_photo_url: z.string().url('Valid registration photo URL is required'),
  insurance_photo_url: z.string().url('Valid insurance photo URL is required'),
  inspection_photo_url: z.string().url('Valid inspection photo URL is required'),
});

export class DriverController {
  static async getOnboardingProgress(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Please log in to view your onboarding progress.' });

      const progress = await DriverService.getOnboardingProgress(userId);
      res.json(progress);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Onboarding progress error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load onboarding progress.' });
    }
  }

  static async saveOnboardingStep(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { step, data } = req.body;
      if (typeof step !== 'number' || step < 0 || step > 5) {
        return res.status(400).json({ error: 'Invalid onboarding step.' });
      }
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Step data is required.' });
      }

      const result = await DriverService.saveOnboardingStep(userId, step, data);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Save step error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to save onboarding step.' });
    }
  }

  static async completeOnboarding(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.completeOnboarding(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Complete onboarding error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to complete onboarding. Please ensure all steps are finished.' });
    }
  }

  static async getProfile(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Please log in to view your profile.' });

      const profile = await DriverService.getProfile(userId);
      res.json(profile);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Profile fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve profile information.' });
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
      console.error(`[DRIVER] ❌ Profile update error: ${error.message}`);
      res.status(400).json({ error: error.message.includes('not found') ? 'Profile not found.' : 'Failed to update profile. Please check your information.' });
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
      console.error(`[DRIVER] ❌ Identity verification error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to submit identity verification.' });
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
      console.error(`[DRIVER] ❌ Onboarding error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Onboarding failed. Please ensure all required documents are uploaded.' });
    }
  }

  static async getVehicles(req: any, res: Response) {
    try {
      const vehicles = await DriverService.getVehicles();
      res.json(vehicles);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Vehicles fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve available vehicles.' });
    }
  }

  static async searchVehicleModels(req: any, res: Response) {
    try {
      const query = req.query.q as string;
      const results = await VehicleDataService.searchVehicles(query);
      res.json(results);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Model search error: ${error.message}`);
      res.status(500).json({ error: 'Failed to search for vehicle models.' });
    }
  }

  static async getVehicleYears(req: any, res: Response) {
    try {
      // Returns years from 2011 to current year + 1
      const currentYear = new Date().getFullYear();
      const years = [];
      for (let y = currentYear + 1; y >= 2011; y--) {
        years.push(y);
      }
      res.json(years);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Years fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve vehicle years.' });
    }
  }

  static async getVehicleMakes(req: any, res: Response) {
    try {
      const makes = await VehicleDataService.getMakes();
      res.json(makes);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Makes fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve vehicle makes.' });
    }
  }

  static async getVehicleModelsByMake(req: any, res: Response) {
    try {
      const make = req.query.make as string;
      if (!make) return res.status(400).json({ error: 'Make is required to find models.' });
      const models = await VehicleDataService.getModels(make);
      res.json(models);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Models fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve vehicle models.' });
    }
  }

  static async updateOperatingClass(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const { activeClass } = req.body;

      if (!['CORE', 'ELITE', 'PRESTIGE'].includes(activeClass)) {
        return res.status(400).json({ error: 'Invalid vehicle class selected.' });
      }

      const result = await DriverService.updateOperatingClass(userId, activeClass);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Class update error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to update operating class.' });
    }
  }

  static async getRidePreferences(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Please log in to view ride preferences.' });
      const result = await DriverService.getRidePreferences(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Get ride preferences error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load ride preferences.' });
    }
  }

  static async setRidePreferences(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Please log in to save ride preferences.' });

      const { enabled } = req.body;
      if (!Array.isArray(enabled)) {
        return res.status(400).json({ error: 'enabled must be an array of ride types.' });
      }
      const result = await DriverService.setRidePreferences(userId, enabled);
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Set ride preferences error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to save ride preferences.' });
    }
  }

  static async getRecommendations(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      const recommendations = await DriverService.getRecommendations(userId);
      res.json(recommendations);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Recommendations fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve recommendations.' });
    }
  }

  static async getPricing(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const pricing = await DriverService.getPricing(userId);
      res.json(pricing);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Pricing fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve pricing information.' });
    }
  }

  static async updatePrice(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { pricePerMile } = req.body;
      if (pricePerMile === undefined || isNaN(parseFloat(pricePerMile))) {
        return res.status(400).json({ error: 'A valid price per mile is required.' });
      }

      const result = await DriverService.updatePrice(userId, parseFloat(pricePerMile));
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Price update error: ${error.message}`);
      // Surface cooldown rejections with a structured code + remaining ms
      // so the client can display an accurate countdown.
      if (error?.code === 'COOLDOWN_ACTIVE') {
        return res.status(429).json({
          error: error.message,
          code: 'COOLDOWN_ACTIVE',
          remainingMs: error.remainingMs,
        });
      }
      res.status(400).json({ error: error.message || 'Failed to update pricing.' });
    }
  }

  static async submitProfileChange(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validated = ProfileChangeRequestSchema.parse(req.body);
      const result = await DriverService.submitProfileChange(userId, validated.changes, validated.reason);
      res.json(result);
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ error: 'Invalid request payload.', details: error.errors });
      }
      const msg = error?.message ?? 'Failed to submit profile change.';
      const code = msg.includes('PROFILE_CHANGE_PENDING') ? 409
        : msg.includes('RATE_LIMITED') ? 429
        : msg.includes('PHONE_NOT_VERIFIED') ? 400
        : 400;
      console.error(`[DRIVER] ❌ Submit profile change error: ${msg}`);
      res.status(code).json({ error: msg });
    }
  }

  static async getCurrentProfileChange(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.getCurrentProfileChange(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Current profile change error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve current profile change.' });
    }
  }

  static async addPayoutCard(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validated = PayoutCardSchema.parse(req.body);
      const result = await DriverService.addPayoutCard(userId, validated);
      res.json(result);
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ error: 'Invalid card details.', details: error.errors });
      }
      const msg = error?.message ?? 'Failed to submit payout card.';
      const code = msg.includes('INVALID_CARD') ? 400 : 400;
      console.error(`[DRIVER] ❌ Add payout card error: ${msg}`);
      res.status(code).json({ error: msg });
    }
  }

  static async getWallet(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.getWallet(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Wallet fetch error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve wallet.' });
    }
  }

  static async requestOnDemandPayout(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validated = PayoutRequestSchema.parse(req.body);
      const result = await DriverService.requestOnDemandPayout(userId, validated.amount_cents);
      res.json(result);
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ error: 'Invalid payout request.' });
      }
      const msg = error?.message ?? 'Failed to request payout.';
      const code = msg.includes('NO_PAYOUT_CARD') ? 403
        : msg.includes('INSUFFICIENT_BALANCE') ? 400
        : msg.includes('MIN_PAYOUT') ? 400
        : 400;
      console.error(`[DRIVER] ❌ Request payout error: ${msg}`);
      res.status(code).json({ error: msg });
    }
  }

  static async listMyPayouts(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
      const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const result = await DriverService.listMyPayouts(userId, limit, offset);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ List payouts error: ${error.message}`);
      res.status(500).json({ error: 'Failed to list payouts.' });
    }
  }

  static async getDocumentRequirements(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.getDocumentRequirements(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Document requirements error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve document requirements.' });
    }
  }

  static async resubmitDocument(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { requirementId, newDocumentUrl, newDocumentUrls } = req.body;
      const urls: string[] = newDocumentUrls ?? (newDocumentUrl ? [newDocumentUrl] : []);
      if (!requirementId || urls.length === 0) {
        return res.status(400).json({ error: 'Requirement ID and at least one document URL are required.' });
      }

      const result = await DriverService.resubmitDocument(userId, requirementId, urls);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Document resubmission error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to resubmit document.' });
    }
  }

  static async batchResubmitDocuments(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const { submissions } = req.body;
      if (!Array.isArray(submissions) || submissions.length === 0) {
        return res.status(400).json({ error: 'At least one document submission is required.' });
      }

      const result = await DriverService.batchResubmitDocuments(userId, submissions);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Batch document resubmission error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to resubmit documents.' });
    }
  }

  static async submitNewVehicle(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validated = SubmitNewVehicleSchema.parse(req.body);
      const result = await DriverService.submitNewVehicle(userId, validated);
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ error: 'Invalid vehicle data.', details: error.errors });
      }
      console.error(`[DRIVER] ❌ Submit new vehicle error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to submit new vehicle.' });
    }
  }

  static async getPendingVehicleSubmissions(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.getPendingVehicleSubmissions(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Pending vehicle error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve pending vehicle submissions.' });
    }
  }

  static async getVehicleResubmissionRequirements(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const result = await DriverService.getVehicleResubmissionRequirements(userId);
      res.json(result);
    } catch (error: any) {
      console.error(`[DRIVER] ❌ Vehicle resubmission requirements error: ${error.message}`);
      res.status(500).json({ error: 'Failed to retrieve vehicle resubmission requirements.' });
    }
  }

  static async submitVehicleResubmission(req: any, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      const validated = SubmitNewVehicleSchema.parse(req.body);
      const { resubmissionRequestId } = req.body;
      const result = await DriverService.submitVehicleResubmission(userId, validated, resubmissionRequestId);
      res.status(201).json(result);
    } catch (error: any) {
      if (error?.name === 'ZodError') {
        return res.status(400).json({ error: 'Invalid vehicle data.', details: error.errors });
      }
      console.error(`[DRIVER] ❌ Submit vehicle resubmission error: ${error.message}`);
      res.status(400).json({ error: error.message || 'Failed to submit vehicle resubmission.' });
    }
  }
}
