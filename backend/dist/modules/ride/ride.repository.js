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
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
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
        if (extra.cancelled_by) {
            fields.push(`cancelled_by = $${values.length + 1}`);
            values.push(extra.cancelled_by);
        }
        if (extra.cancellation_reason_code !== undefined && extra.cancellation_reason_code !== null) {
            fields.push(`cancellation_reason_code = $${values.length + 1}`);
            values.push(extra.cancellation_reason_code);
        }
        if (extra.cancellation_reason_text !== undefined && extra.cancellation_reason_text !== null) {
            fields.push(`cancellation_reason_text = $${values.length + 1}`);
            values.push(extra.cancellation_reason_text);
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
        let where = 'WHERE id = $2';
        if (status === types_1.TripStatus.COMPLETED) {
            where += ` AND status IN ('ACCEPTED', 'DRIVER_ARRIVING', 'IN_PROGRESS')`;
        }
        const updateRes = await database_1.pool.query(`UPDATE rides SET ${fields.join(', ')} ${where}`, values);
        if (status === types_1.TripStatus.COMPLETED && updateRes.rowCount === 0) {
            throw new Error('Ride cannot be completed from its current state');
        }
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
      WHERE r.id = $1
    `, [id]);
        return this.mapToTrip(res.rows[0]);
    }
    static async findByRiderId(riderId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
      WHERE r.rider_id = $1 
      ORDER BY r.created_at DESC
    `, [riderId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findByDriverId(driverId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
      WHERE r.driver_id = $1 AND r.status IN ('COMPLETED', 'ACCEPTED', 'DRIVER_ARRIVING', 'IN_PROGRESS', 'CANCELLED')
      ORDER BY r.created_at DESC
    `, [driverId]);
        return res.rows.map(row => this.mapToTrip(row));
    }
    static async findCurrentByRiderId(riderId) {
        const res = await database_1.pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.email as rider_email, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
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
             d.full_name as driver_name, d.email as driver_email, d.rating as driver_rating, d.rating_count as driver_rides,
             dv.make as driver_vehicle_make, dv.model as driver_vehicle_model,
             dv.license_plate_number as driver_vehicle_plate
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      ${RideRepository.DRIVER_VEHICLE_JOIN}
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
            cancelled_by: row.cancelled_by,
            cancellation_reason_code: row.cancellation_reason_code,
            cancellation_reason_text: row.cancellation_reason_text,
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
                name: row.driver_name || '',
                email: row.driver_email,
                rating: row.driver_rating !== null ? parseFloat(row.driver_rating) : 5.0,
                total_rides: row.driver_rides !== null ? parseInt(row.driver_rides) : 0,
                // Real vehicle identity from the driver's vehicle record — never
                // fabricated. `vehicle` and `plate` are omitted when the driver has
                // no vehicle row, and the client hides those fields instead of
                // inventing "Sedan"/"ABC-123".
                vehicle: row.driver_vehicle_make || row.driver_vehicle_model
                    ? [row.driver_vehicle_make, row.driver_vehicle_model].filter(Boolean).join(' ') || undefined
                    : undefined,
                plate: row.driver_vehicle_plate || undefined,
            } : undefined,
        };
    }
}
exports.RideRepository = RideRepository;
RideRepository.DRIVER_VEHICLE_JOIN = `
      LEFT JOIN LATERAL (
        SELECT make, model, license_plate_number
        FROM driver_vehicles
        WHERE driver_id = d.id AND make IS NOT NULL
        ORDER BY id LIMIT 1
      ) dv ON true
  `;
//# sourceMappingURL=ride.repository.js.map