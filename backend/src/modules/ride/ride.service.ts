// backend/src/modules/ride/ride.service.ts
import { RideRepository } from './ride.repository';
import { LocationsService } from '../location/locations.service';
import { GeospatialService } from '../geospatial/geospatial.service';
import { Trip, Location, UserRole } from '../../types';
import { env } from '../../config/env';
import { io } from '../../app';
import { pool } from '../../config/database';

export class RideService {
  static async rateRide(data: {
    ride_id: string;
    rater_id: string;
    rating: number;
    review_text?: string;
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Check Ride
      const rideRes = await client.query('SELECT * FROM rides WHERE id = $1', [data.ride_id]);
      const ride = rideRes.rows[0];

      if (!ride) throw new Error('Ride not found');
      if (ride.status !== 'COMPLETED') throw new Error('Ride is not completed');

      // Determine roles
      let target_id: string;
      let target_role: string;

      if (ride.rider_id === data.rater_id) {
        // Rider is rating Driver
        if (!ride.driver_id) throw new Error('No driver assigned to this ride');
        target_id = ride.driver_id;
        target_role = 'DRIVER';
      } else if (ride.driver_id === data.rater_id) {
        // Driver is rating Rider
        target_id = ride.rider_id;
        target_role = 'RIDER';
      } else {
        throw new Error('Unauthorized');
      }

      // 2. Check if already rated by this person for this ride
      const existingRating = await client.query(
        'SELECT id FROM ratings WHERE ride_id = $1 AND rater_id = $2',
        [data.ride_id, data.rater_id]
      );
      if (existingRating.rows.length > 0) throw new Error('You have already rated this ride');

      // 3. Create Rating
      const ratingRes = await client.query(
        `INSERT INTO ratings (ride_id, rater_id, target_id, target_role, rating, review_text)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [data.ride_id, data.rater_id, target_id, target_role, data.rating, data.review_text]
      );

      // 4. Update Target Rating (Moving Average of last 100)
      const lastRatings = await client.query(
        `SELECT rating FROM ratings WHERE target_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [target_id]
      );

      const totalRatingsCount = parseInt((await client.query(
        'SELECT COUNT(*) FROM ratings WHERE target_id = $1',
        [target_id]
      )).rows[0].count);

      let newRating = 5.0;
      if (totalRatingsCount >= 100) {
        const sum = lastRatings.rows.reduce((acc: number, curr: any) => acc + curr.rating, 0);
        newRating = parseFloat((sum / lastRatings.rows.length).toFixed(1));
      }

      // Update User table rating for everyone
      await client.query(
        'UPDATE users SET rating = $1, rating_count = $2 WHERE id = $3',
        [newRating, totalRatingsCount, target_id]
      );

      // If target is a driver, also update drivers table for redundancy/legacy compatibility
      if (target_role === 'DRIVER') {
        await client.query(
          'UPDATE drivers SET rating = $1, total_rides = total_rides + 1 WHERE user_id = $2',
          [newRating, target_id]
        );
      }

      await client.query('COMMIT');
      return ratingRes.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async requestRide(riderId: string, pickup: Location & { address: string }, destination: Location & { address: string }): Promise<Trip> {
    console.log(`[RIDE] New request from rider ${riderId}. Pickup: ${pickup.lat}, ${pickup.lng}`);
    await RideRepository.create({
      rider_id: riderId,
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      pickup_address: pickup.address,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      destination_address: destination.address,
    });

    const trip = await RideRepository.findCurrentByRiderId(riderId);
    if (!trip) throw new Error('Failed to create trip');

    // ... rest of method remains same as before Prisma refactor
    const route = await GeospatialService.getRoute(
      [pickup.lat, pickup.lng],
      [destination.lat, destination.lng]
    ).catch(() => null);

    if (route) {
      (trip as any).route_geometry = route.geometry;
      (trip as any).distance_meters = route.distance;
      (trip as any).eta_seconds = route.eta;
    }

    let nearbyDrivers = await LocationsService.findNearbyDrivers(pickup, env.DRIVER_MATCH_RADIUS_KM || 50);
    
    nearbyDrivers.forEach(d => {
      io.to(`driver:${d.id}`).emit('newTripRequest', trip);
    });

    return trip;
  }

  static async acceptTrip(tripId: string, driverId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');
    if (trip.status !== 'REQUESTED') throw new Error('Trip already taken or cancelled');

    const updatedTrip = await RideRepository.updateStatus(tripId, 'ACCEPTED' as any, {
      driver_id: driverId,
      accepted_at: new Date()
    });

    const driverLoc = await LocationsService.getDriverLocation(driverId);
    (updatedTrip as any).driver_location = driverLoc;

    io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);

    return updatedTrip;
  }

  static async updateTripStatus(tripId: string, status: any): Promise<Trip> {
    const extra: any = {};
    if (status === 'IN_PROGRESS') extra.started_at = new Date();
    if (status === 'COMPLETED') extra.completed_at = new Date();

    const updatedTrip = await RideRepository.updateStatus(tripId, status, extra);
    
    if (updatedTrip.driver_id) {
      const driverLoc = await LocationsService.getDriverLocation(updatedTrip.driver_id);
      (updatedTrip as any).driver_location = driverLoc;
    }

    io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (updatedTrip.driver_id) {
      io.to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
    }

    return updatedTrip;
  }

  static async cancelTrip(tripId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');
    const updatedTrip = await RideRepository.updateStatus(tripId, 'CANCELLED' as any);
    io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (trip.driver_id) {
      io.to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
    }
    return updatedTrip;
  }

  static async getHistory(userId: string, role: string): Promise<Trip[]> {
    if (role === 'driver') {
      return RideRepository.findByDriverId(userId);
    }
    return RideRepository.findByRiderId(userId);
  }

  static async getCurrentRide(userId: string, role: string): Promise<Trip | null> {
    if (role === 'driver') {
      return RideRepository.findCurrentByDriverId(userId);
    }
    return RideRepository.findCurrentByRiderId(userId);
  }

  static async deleteHistory(rideId: string, userId: string): Promise<boolean> {
    return RideRepository.delete(rideId, userId);
  }
}
