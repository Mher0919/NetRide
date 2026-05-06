"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideRepository = void 0;
// backend/src/modules/ride/ride.repository.ts
const database_1 = require("../../config/database");
const types_1 = require("../../types");
class RideRepository {
    static async create(data) {
        const res = await database_1.pool.query(`INSERT INTO rides (
        rider_id, status, pickup_lat, pickup_lng, pickup_address,
        destination_lat, destination_lng, destination_address
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`, [
            data.rider_id,
            types_1.TripStatus.REQUESTED,
            data.pickup_lat,
            data.pickup_lng,
            data.pickup_address,
            data.destination_lat,
            data.destination_lng,
            data.destination_address
        ]);
        return this.mapToTrip(res.rows[0]);
    }
    static async findById(id) {
        const res = await database_1.pool.query('SELECT * FROM rides WHERE id = $1', [id]);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async updateStatus(id, status, extra = {}) {
        const fields = ['status = $1'];
        const values = [status, id];
        if (extra.driver_id) {
            fields.push(`driver_id = $${values.length + 1}`);
            values.push(extra.driver_id);
        }
        const res = await database_1.pool.query(`UPDATE rides SET ${fields.join(', ')} WHERE id = $2 RETURNING *`, values);
        return this.mapToTrip(res.rows[0]);
    }
    static async findByRiderId(riderId) {
        const res = await database_1.pool.query('SELECT * FROM rides WHERE rider_id = $1 ORDER BY created_at DESC', [riderId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findByDriverId(driverId) {
        const res = await database_1.pool.query('SELECT * FROM rides WHERE driver_id = $1 ORDER BY created_at DESC', [driverId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findCurrentByRiderId(riderId) {
        const res = await database_1.pool.query('SELECT * FROM rides WHERE rider_id = $1 AND status NOT IN ($2, $3) ORDER BY created_at DESC LIMIT 1', [riderId, types_1.TripStatus.COMPLETED, types_1.TripStatus.CANCELLED]);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async findCurrentByDriverId(driverId) {
        const res = await database_1.pool.query('SELECT * FROM rides WHERE driver_id = $1 AND status NOT IN ($2, $3) ORDER BY created_at DESC LIMIT 1', [driverId, types_1.TripStatus.COMPLETED, types_1.TripStatus.CANCELLED]);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async delete(id, userId) {
        const res = await database_1.pool.query('DELETE FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)', [id, userId]);
        return (res.rowCount ?? 0) > 0;
    }
    static mapToTrip(row) {
        return {
            id: row.id,
            rider_id: row.rider_id,
            driver_id: row.driver_id,
            status: row.status,
            pickup: {
                lat: parseFloat(row.pickup_lat),
                lng: parseFloat(row.pickup_lng),
                address: row.pickup_address
            },
            destination: {
                lat: parseFloat(row.destination_lat),
                lng: parseFloat(row.destination_lng),
                address: row.destination_address
            },
            requested_at: row.created_at,
        };
    }
}
exports.RideRepository = RideRepository;
//# sourceMappingURL=ride.repository.js.map