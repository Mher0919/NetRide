// backend/src/modules/user/user.repository.ts
import { pool } from '../../config/database';
import { User, UserRole } from '../../types';

export class UserRepository {
  static async findByEmail(email: string): Promise<(User & { password_hash?: string }) | null> {
    const res = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return res.rows[0] || null;
  }

  static async findById(id: string): Promise<User | null> {
    const res = await pool.query(
      'SELECT id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at FROM users WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  static async create(data: {
    email: string;
    phone_number?: string;
    password_hash?: string;
    full_name: string;
    role: UserRole;
  }): Promise<User> {
    const res = await pool.query(
      `INSERT INTO users (email, phone_number, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at`,
      [data.email, data.phone_number, data.password_hash, data.full_name, data.role]
    );
    return res.rows[0];
  }

  static async update(id: string, data: Partial<{ phone_number: string; full_name: string; is_verified: boolean; profile_image_url: string; date_of_birth: string }>): Promise<User | null> {
    const fields = [];
    const values = [];
    let i = 1;

    if (data.phone_number) {
      fields.push(`phone_number = $${i++}`);
      values.push(data.phone_number);
    }
    if (data.full_name) {
      fields.push(`full_name = $${i++}`);
      values.push(data.full_name);
    }
    if (data.is_verified !== undefined) {
      fields.push(`is_verified = $${i++}`);
      values.push(data.is_verified);
    }
    if (data.profile_image_url) {
      fields.push(`profile_image_url = $${i++}`);
      values.push(data.profile_image_url);
    }
    if (data.date_of_birth) {
      fields.push(`date_of_birth = $${i++}`);
      values.push(data.date_of_birth);
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    const res = await pool.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at`,
      values
    );
    return res.rows[0] || null;
  }
}
