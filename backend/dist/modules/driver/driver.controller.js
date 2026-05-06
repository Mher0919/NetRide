"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverController = void 0;
const driver_service_1 = require("./driver.service");
const zod_1 = require("zod");
const OnboardSchema = zod_1.z.object({
    personalInfo: zod_1.z.object({
        phone_number: zod_1.z.string(),
        date_of_birth: zod_1.z.string(),
        profile_image_url: zod_1.z.string().url(),
    }),
    identity: zod_1.z.object({
        license_number: zod_1.z.string(),
        license_expiry_date: zod_1.z.string(),
        license_photo_url: zod_1.z.string().url(),
        license_photo_back_url: zod_1.z.string().url(),
        insurance_photo_url: zod_1.z.string().url(),
        registration_photo_url: zod_1.z.string().url(),
    }),
    vehicle: zod_1.z.object({
        vehicle_id: zod_1.z.string().uuid(),
        license_plate_number: zod_1.z.string(),
        license_plate_photo_url: zod_1.z.string().url(),
        car_photo_urls: zod_1.z.array(zod_1.z.string().url()).min(2).max(4),
        color: zod_1.z.string().optional(),
        interior_color: zod_1.z.string().optional(),
    }),
});
const UpdateProfileSchema = zod_1.z.object({
    full_name: zod_1.z.string().optional(),
    phone_number: zod_1.z.string().optional(),
    date_of_birth: zod_1.z.string().optional(),
    profile_image_url: zod_1.z.string().url().optional(),
    license_number: zod_1.z.string().optional(),
    license_expiry_date: zod_1.z.string().optional(),
    vehicle_id: zod_1.z.string().uuid().optional(),
    license_plate_number: zod_1.z.string().optional(),
});
const VerifyIdentitySchema = zod_1.z.object({
    license_photo_url: zod_1.z.string().url(),
    license_photo_back_url: zod_1.z.string().url(),
    date_of_birth: zod_1.z.string().optional(),
    license_number: zod_1.z.string().optional(),
});
class DriverController {
    static async getProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const profile = await driver_service_1.DriverService.getProfile(userId);
            res.json(profile);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
    static async updateProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = UpdateProfileSchema.parse(req.body);
            const result = await driver_service_1.DriverService.updateProfile(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async verifyIdentity(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = VerifyIdentitySchema.parse(req.body);
            const result = await driver_service_1.DriverService.requestVerification(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async onboard(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ error: 'Unauthorized' });
            const validatedData = OnboardSchema.parse(req.body);
            const result = await driver_service_1.DriverService.onboard(userId, validatedData);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async getVehicles(req, res) {
        try {
            const vehicles = await driver_service_1.DriverService.getVehicles();
            res.json(vehicles);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}
exports.DriverController = DriverController;
//# sourceMappingURL=driver.controller.js.map