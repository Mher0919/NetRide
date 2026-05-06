import { User } from '../../types';
export declare class UserService {
    static getProfile(id: string): Promise<User | null>;
    static updateProfile(id: string, data: Partial<{
        phone_number: string;
        full_name: string;
        profile_image_url: string;
        date_of_birth: string;
    }>): Promise<User | null>;
    static requestVerification(userId: string, idFrontUrl: string, idBackUrl: string, dob?: string): Promise<void>;
}
