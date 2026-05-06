"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserService = void 0;
// backend/src/modules/user/user.service.ts
const user_repository_1 = require("./user.repository");
const email_service_1 = require("../../services/email.service");
class UserService {
    static async getProfile(id) {
        return user_repository_1.UserRepository.findById(id);
    }
    static async updateProfile(id, data) {
        return user_repository_1.UserRepository.update(id, data);
    }
    static async requestVerification(userId, idFrontUrl, idBackUrl, dob) {
        // 1. Update DOB and reset verification status in DB
        const updateData = { is_verified: false };
        if (dob)
            updateData.date_of_birth = dob;
        await user_repository_1.UserRepository.update(userId, updateData);
        const user = await this.getProfile(userId);
        if (!user)
            throw new Error('User not found');
        await email_service_1.EmailService.sendRiderVerificationNotice(user, idFrontUrl, idBackUrl);
    }
}
exports.UserService = UserService;
//# sourceMappingURL=user.service.js.map