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
    const res = await pool.query('SELECT * FROM rides WHERE id = $1', [id]);
    return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
  }

  static async updateStatus(id: string, status: TripStatus, extra: any = {}): Promise<Trip> {
    const fields = ['status = $1'];
    const values: any[] = [status, id];
    
    if (extra.driver_id) {
      fields.push(`driver_id = $${values.length + 1}`);
      values.push(extra.driver_id);
    }

    const res = await pool.query(
      `UPDATE rides SET ${fields.join(', ')} WHERE id = $2 RETURNING *`,
      values
    );
    return this.mapToTrip(res.rows[0]);
  }

  static async findByRiderId(riderId: string): Promise<Trip[]> {
    const res = await pool.query(
      'SELECT * FROM rides WHERE rider_id = $1 ORDER BY created_at DESC',
      [riderId]
    );
    return res.rows.map(row => this.mapToTrip(row));
  }

  static async findByDriverId(driverId: string): Promise<Trip[]> {
    const res = await pool.query(
      'SELECT * FROM rides WHERE driver_id = $1 ORDER BY created_at DESC',
      [driverId]
    );
    return res.rows.map(row => this.mapToTrip(row));
  }

  static async findCurrentByRiderId(riderId: string): Promise<Trip | null> {
    const res = await pool.query(
      'SELECT * FROM rides WHERE rider_id = $1 AND status NOT IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
      [riderId, TripStatus.COMPLETED, TripStatus.CANCELLED]
    );
    return res.rows[0] ? this.mapToTrip(res.rows[0]) : null;
  }

  static async findCurrentByDriverId(driverId: string): Promise<Trip | null> {
    const res = await pool.query(
      'SELECT * FROM rides WHERE driver_id = $1 AND status NOT IN ($2, $3) ORDER BY created_at DESC LIMIT 1',
      [driverId, TripStatus.COMPLETED, TripStatus.CANCELLED]
    );
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
