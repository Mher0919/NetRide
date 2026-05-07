// backend/src/modules/ride/ride.repository.ts
import { pool } from '../../config/database';
import { Trip, TripStatus } from '../../types';

export class RideRepository {
  static async create(data: {
    rider_id: string;
    pickup_lat: number;
    pickup_lng: number;
    pickup_address: string;
    destination_lat: number;
    destination_lng: number;
    destination_address: string;
  }): Promise<Trip> {
    const res = await pool.query(
      `INSERT INTO rides (
        rider_id, status, pickup_lat, pickup_lng, pickup_address,
        destination_lat, destination_lng, destination_address
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.rider_id,
        TripStatus.REQUESTED,
        data.pickup_lat,
        data.pickup_lng,
        data.pickup_address,
        data.destination_lat,
        data.destination_lng,
        data.destination_address
      ]
    );
    return this.mapToTrip(res.rows[0]);
  }

  static async findById(id: string): Promise<Trip | null> {
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.id = $1
    `, [id]);
    return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
  }

  static async updateStatus(id: string, status: TripStatus, extra: any = {}): Promise<Trip> {
    const fields = ['status = $1'];
    const values: any[] = [status, id];
    
    if (extra.driver_id) {
      fields.push(`driver_id = $${values.length + 1}`);
      values.push(extra.driver_id);
    }

    await pool.query(
      `UPDATE rides SET ${fields.join(', ')} WHERE id = $2`,
      values
    );

    // Fetch with joined info
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.id = $1
    `, [id]);
    
    return this.mapToTrip(res.rows[0]);
  }

  static async findByRiderId(riderId: string): Promise<Trip[]> {
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.rider_id = $1 
      ORDER BY r.created_at DESC
    `, [riderId]);
    return res.rows.map(row => this.mapToTrip(row));
  }

  static async findByDriverId(driverId: string): Promise<Trip[]> {
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.driver_id = $1 
      ORDER BY r.created_at DESC
    `, [driverId]);
    return res.rows.map(row => this.mapToTrip(row));
  }

  static async findCurrentByRiderId(riderId: string): Promise<Trip | null> {
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.rider_id = $1 AND r.status NOT IN ($2, $3) 
      ORDER BY r.created_at DESC LIMIT 1
    `, [riderId, TripStatus.COMPLETED, TripStatus.CANCELLED]);
    return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
  }

  static async findCurrentByDriverId(driverId: string): Promise<Trip | null> {
    const res = await pool.query(`
      SELECT r.*, 
             u.full_name as rider_name, u.rating as rider_rating, u.rating_count as rider_rides,
             d.full_name as driver_name, d.rating as driver_rating, d.rating_count as driver_rides
      FROM rides r
      LEFT JOIN users u ON r.rider_id = u.id
      LEFT JOIN users d ON r.driver_id = d.id
      WHERE r.driver_id = $1 AND r.status NOT IN ($2, $3) 
      ORDER BY r.created_at DESC LIMIT 1
    `, [driverId, TripStatus.COMPLETED, TripStatus.CANCELLED]);
    return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
  }

  static async delete(id: string, userId: string): Promise<boolean> {
    const res = await pool.query(
      'DELETE FROM rides WHERE id = $1 AND (rider_id = $2 OR driver_id = $2)',
      [id, userId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  private static mapToTrip(row: any): Trip {
    return {
      id: row.id,
      rider_id: row.rider_id,
      driver_id: row.driver_id,
      status: row.status as TripStatus,
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
      rider_info: {
        name: row.rider_name || 'Rider',
        rating: row.rider_rating !== null ? parseFloat(row.rider_rating) : 5.0,
        total_rides: row.rider_rides !== null ? parseInt(row.rider_rides) : 0,
      },
      driver_info: row.driver_id ? {
        name: row.driver_name || 'Driver',
        rating: row.driver_rating !== null ? parseFloat(row.driver_rating) : 5.0,
        total_rides: row.driver_rides !== null ? parseInt(row.driver_rides) : 0,
      } : undefined,
    };
  }
}
