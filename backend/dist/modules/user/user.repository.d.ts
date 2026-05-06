import { User, UserRole } from '../../types';
export declare class UserRepository {
    static findByEmail(email: string): Promise<(User & {
        password_hash?: string;
    }) | null>;
    static findById(id: string): Promise<User | null>;
    static create(data: {
        email: string;
        phone_number?: string;
        password_hash?: string;
        full_name: string;
        role: UserRole;
    }): Promise<User>;
    static update(id: string, data: Partial<{
        phone_number: string;
        full_name: string;
        is_verified: boolean;
        profile_image_url: string;
        date_of_birth: string;
    }>): Promise<User | null>;
}
