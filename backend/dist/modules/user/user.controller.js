"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserController = exports.verifyIdentitySchema = exports.updateProfileSchema = void 0;
const user_service_1 = require("./user.service");
const zod_1 = require("zod");
const auth_service_1 = require("../auth/auth.service");
exports.updateProfileSchema = zod_1.z.object({
    body: zod_1.z.object({
        phone_number: zod_1.z.string().min(10).optional(),
        full_name: zod_1.z.string().min(2).optional(),
        profile_image_url: zod_1.z.string().url().optional(),
        date_of_birth: zod_1.z.string().optional(),
    }),
});
exports.verifyIdentitySchema = zod_1.z.object({
    body: zod_1.z.object({
        id_photo_front_url: zod_1.z.string().url(),
        id_photo_back_url: zod_1.z.string().url(),
        date_of_birth: zod_1.z.string().optional(),
    }),
});
const RequestEmailChangeSchema = zod_1.z.object({
    newEmail: zod_1.z.string().email(),
});
class UserController {
    static async getProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId) {
                console.warn('[USER] ❌ No userId in request user object');
                return res.status(401).json({ message: 'Unauthorized' });
            }
            console.log(`[USER] 👤 Fetching profile for ID: ${userId}`);
            const user = await user_service_1.UserService.getProfile(userId);
            if (!user) {
                console.warn(`[USER] ❌ User not found in DB for ID: ${userId}`);
                return res.status(404).json({ message: 'User not found' });
            }
            res.json(user);
        }
        catch (error) {
            console.error(`[USER] ❌ Error in getProfile: ${error.message}`);
            res.status(500).json({ message: error.message });
        }
    }
    static async updateProfile(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ message: 'Unauthorized' });
            const user = await user_service_1.UserService.updateProfile(userId, req.body);
            if (!user)
                return res.status(404).json({ message: 'User not found' });
            res.json(user);
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
    static async verifyIdentity(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ message: 'Unauthorized' });
            const { id_photo_front_url, id_photo_back_url, date_of_birth } = req.body;
            if (!id_photo_front_url || !id_photo_back_url) {
                return res.status(400).json({ message: 'Both front and back ID photos are required' });
            }
            await user_service_1.UserService.requestVerification(userId, id_photo_front_url, id_photo_back_url, date_of_birth);
            res.json({ message: 'Verification request sent to admin' });
        }
        catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
    static async requestEmailChange(req, res) {
        try {
            const userId = req.user?.id;
            if (!userId)
                return res.status(401).json({ message: 'Unauthorized' });
            const { newEmail } = RequestEmailChangeSchema.parse(req.body);
            const result = await auth_service_1.AuthService.requestEmailChange(userId, newEmail);
            res.json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    static async verifyEmailChange(req, res) {
        try {
            const { token } = req.params;
            const result = await auth_service_1.AuthService.verifyEmailChange(token);
            res.send(`
        <div style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Email Updated Successfully!</h1>
          <p>Your email has been verified and updated.</p>
        </div>
      `);
        }
        catch (error) {
            res.status(400).send(`<h1>Error verifying email: ${error.message}</h1>`);
        }
    }
}
exports.UserController = UserController;
//# sourceMappingURL=user.controller.js.map