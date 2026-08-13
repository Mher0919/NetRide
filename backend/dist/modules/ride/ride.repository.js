"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideRepository = void 0;
// backend/src/modules/ride/ride.repository.ts
console.log('[REPO_INIT] ride.repository.ts loaded from', __filename);
const database_1 = require("../../config/database");
const types_1 = require("../../types");
class RideRepository {
    static async create(data) {
        const res = await database_1.pool.query(`INSERT INTO rides (
        rider_id, status, pickup_lat, pickup_lng, pickup_address,
        destination_lat, destination_lng, destination_address,
        requested_class, snapshot_rider_rating
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`, [
            data.rider_id,
            types_1.TripStatus.REQUESTED,
            data.pickup_lat,
            data.pickup_lng,
            data.pickup_address,
            data.destination_lat,
            data.destination_lng,
            data.destination_address,
            data.requested_class || 'CORE',
            data.snapshot_rider_rating || 5.0
        ]);
        return this.mapToTrip(res.rows[0]);
    }
    static async findById(id) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.id = $1
    `, [id]);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async updateStatus(id, status, extra = {}) {
        const fields = ['status = $1'];
        const values = [status, id];
        if (extra.driver_id) {
            fields.push(`driver_id = $${values.length + 1}`);
            values.push(extra.driver_id);
        }
        if (extra.accepted_at) {
            fields.push(`accepted_at = $${values.length + 1}`);
            values.push(extra.accepted_at);
        }
        if (extra.started_at) {
            fields.push(`started_at = $${values.length + 1}`);
            values.push(extra.started_at);
        }
        if (extra.completed_at) {
            fields.push(`completed_at = $${values.length + 1}`);
            values.push(extra.completed_at);
        }
        if (extra.cancelled_at) {
            fields.push(`cancelled_at = $${values.length + 1}`);
            values.push(extra.cancelled_at);
        }
        if (extra.trajectory) {
            fields.push(`trajectory = $${values.length + 1}`);
            values.push(extra.trajectory);
        }
        if (extra.distance_meters) {
            fields.push(`distance_meters = $${values.length + 1}`);
            values.push(extra.distance_meters);
        }
        if (extra.fare_amount) {
            fields.push(`fare_amount = $${values.length + 1}`);
            values.push(extra.fare_amount);
        }
        if (extra.initial_max_fare) {
            fields.push(`initial_max_fare = $${values.length + 1}`);
            values.push(extra.initial_max_fare);
        }
        if (extra.saving_likelihood) {
            fields.push(`saving_likelihood = $${values.length + 1}`);
            values.push(extra.saving_likelihood);
        }
        if (extra.compliance_snapshot) {
            fields.push(`compliance_snapshot = $${values.length + 1}`);
            values.push(extra.compliance_snapshot);
        }
        await database_1.pool.query(`UPDATE rides SET ${fields.join(', ')} WHERE id = $2`, values);
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.id = $1
    `, [id]);
        return this.mapToTrip(res.rows[0]);
    }
    static async findByRiderId(riderId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.rider_id = $1 
      ORDER BY r.created_at DESC
    `, [riderId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findByDriverId(driverId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.driver_id = $1 AND r.status IN ('COMPLETED', 'ACCEPTED', 'DRIVER_ARRIVING', 'IN_PROGRESS')
      ORDER BY r.created_at DESC
    `, [driverId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findCurrentByRiderId(riderId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.rider_id = $1 AND r.status NOT IN ($2, $3) 
      ORDER BY r.created_at DESC LIMIT 1
    `, [riderId, types_1.TripStatus.COMPLETED, types_1.TripStatus.CANCELLED]);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async findCurrentByDriverId(driverId) {
        console.log('[REPO_TEST_HELLO] findCurrentByDriverId called', driverId);
        const res = await database_1.pool.query(`
      SELECT r.*,
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.driver_id = $1 AND r.status NOT IN ($2, $3)
      ORDER BY r.created_at DESC LIMIT 1
    `, [driverId, types_1.TripStatus.COMPLETED, types_1.TripStatus.CANCELLED]);
        console.log(`[REPO] findCurrentByDriverId rowCount=${res.rowCount} keys=${Object.keys(res.rows[0] || {}).slice(0, 5).join(',')} id=${res.rows[0]?.id} status=${res.rows[0]?.status}`);
        return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
    }
    static async delete(id, userId) {
        const res = await database_1.pool.query('DELETE FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)', [id, userId]);
        return (res.rowCount ?? 0) > 0;
    }
    static mapToTrip(row) {
        if (!row)
            return null;
        return {
            id: row.id,
            rider_id: row.rider_id,
            driver_id: row.driver_id,
            status: row.status,
            requested_class: row.requested_class,
            snapshot_rider_rating: row.snapshot_rider_rating ? parseFloat(row.snapshot_rider_rating) : undefined,
            pickup: {
                lat: parseFloat(row.pickup_lat || '0'),
                lng: parseFloat(row.pickup_lng || '0'),
                address: row.pickup_address
            },
            destination: {
                lat: parseFloat(row.destination_lat || '0'),
                lng: parseFloat(row.destination_lng || '0'),
                address: row.destination_address
            },
            requested_at: row.created_at,
            accepted_at: row.accepted_at,
            started_at: row.started_at,
            completed_at: row.completed_at,
            cancelled_at: row.cancelled_at,
            distance_km: row.distance_meters ? row.distance_meters / 1000 : undefined,
            fare_amount: row.fare_amount ? parseFloat(row.fare_amount) : undefined,
            tip_amount: row.tip_amount ? parseFloat(row.tip_amount) : undefined,
            initial_max_fare: row.initial_max_fare ? parseFloat(row.initial_max_fare) : undefined,
            saving_likelihood: row.saving_likelihood !== null ? parseInt(row.saving_likelihood) : undefined,
            trajectory: row.trajectory,
            rider_info: {
                name: row.rider_name || 'Rider',
                email: row.rider_email,
                rating: row.rider_rating !== null ? parseFloat(row.rider_rating) : 5.0,
                total_rides: row.rider_rides !== null ? parseInt(row.rider_rides) : 0,
            },
            driver_info: row.driver_id ? {
                name: row.driver_name || 'Driver',
                email: row.driver_email,
                rating: row.driver_rating !== null ? parseFloat(row.driver_rating) : 5.0,
                total_rides: row.driver_rides !== null ? parseInt(row.driver_rides) : 0,
            } : undefined,
        };
    }
}
exports.RideRepository = RideRepository;
//# sourceMappingURL=ride.repository.js.map