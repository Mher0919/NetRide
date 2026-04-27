// backend/src/modules/driver/driver.repository.ts
import { pool } from '../../config/database';
import { DriverProfile, VehicleCategory } from '../../types';

export class DriverRepository {
  static async findByUserId(userId: string): Promise<DriverProfile | null> {
    const res = await pool.query(
      'SELECT * FROM driver_profiles WHERE user_id = $1',
      [userId]
    );
    return res.rows[0] || null;
  }

  static async create(data: {
    user_id: string;
    vehicle_make: string;
    vehicle_model: string;
    vehicle_year: number;
    vehicle_plate: string;
    vehicle_type: VehicleCategory;
  }): Promise<DriverProfile> {
    const res = await pool.query(
      `INSERT INTO driver_profiles (user_id, vehicle_make, vehicle_model, vehicle_year, vehicle_plate, vehicle_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [data.user_id, data.vehicle_make, data.vehicle_model, data.vehicle_year, data.vehicle_plate, data.vehicle_type]
    );
    return res.rows[0];
  }

  static async updateOnlineStatus(userId: string, isOnline: boolean): Promise<void> {
    await pool.query(
      'UPDATE driver_profiles SET is_online = $1 WHERE user_id = $2',
      [isOnline, userId]
    );
  }
}