"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverRepository = void 0;
// backend/src/modules/driver/driver.repository.ts
const database_1 = require("../../config/database");
class DriverRepository {
    static async findByUserId(userId) {
        const res = await database_1.pool.query('SELECT * FROM driver_profiles WHERE user_id = $1', [userId]);
        return res.rows[0] || null;
    }
    static async create(data) {
        const res = await database_1.pool.query(`INSERT INTO driver_profiles (user_id, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`, [data.user_id, data.vehicle_make, data.vehicle_model, data.vehicle_year, data.vehicle_plate, data.vehicle_type]);
        return res.rows[0];
    }
    static async updateOnlineStatus(userId, isOnline) {
        await database_1.pool.query('UPDATE driver_profiles SET is_online = $1 WHERE user_id = $2', [isOnline, userId]);
    }
}
exports.DriverRepository = DriverRepository;
//# sourceMappingURL=driver.repository.js.map