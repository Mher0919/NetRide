// backend/src/modules/user/user.service.ts
import { UserRepository } from './user.repository';
import { User } from '../../types';
import { EmailService } from '../../services/email.service';

export class UserService {
  static async getProfile(id: string): Promise<User | null> {
    return UserRepository.findById(id);
  }

  static async updateProfile(id: string, data: Partial<{ phone_number: string; full_name: string; profile_image_url: string; date_of_birth: string }>): Promise<User | null> {
    return UserRepository.update(id, data);
  }

  static async requestVerification(userId: string, idFrontUrl: string, idBackUrl: string, dob?: string) {
    // 1. Update DOB and reset verification status in DB
    const updateData: any = { is_verified: false };
    if (dob) updateData.date_of_birth = dob;
    
    await UserRepository.update(userId, updateData);

    const user = await this.getProfile(userId);
    if (!user) throw new Error('User not found');

    await EmailService.sendRiderVerificationNotice(user, idFrontUrl, idBackUrl);
  }
}