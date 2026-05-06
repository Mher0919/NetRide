"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserRepository = void 0;
// backend/src/modules/user/user.repository.ts
const database_1 = require("../../config/database");
class UserRepository {
    static async findByEmail(email) {
        const res = await database_1.pool.query('SELECT * FROM users WHERE email = $1', [email]);
        return res.rows[0] || null;
    }
    static async findById(id) {
        const res = await database_1.pool.query('SELECT id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at FROM users WHERE id = $1', [id]);
        return res.rows[0] || null;
    }
    static async create(data) {
        const res = await database_1.pool.query(`INSERT INTO users (email, phone_number, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at`, [data.email, data.phone_number, data.password_hash, data.full_name, data.role]);
        return res.rows[0];
    }
    static async update(id, data) {
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
        if (fields.length === 0)
            return this.findById(id);
        values.push(id);
        const res = await database_1.pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id, email, phone_number, full_name, role, is_verified, profile_image_url, date_of_birth, created_at`, values);
        return res.rows[0] || null;
    }
}
exports.UserRepository = UserRepository;
//# sourceMappingURL=user.repository.js.map