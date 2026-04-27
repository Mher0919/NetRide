// backend/src/gateway/socket.gateway.ts
import { Server, Socket } from 'socket.io';
import { LocationsService } from '../modules/location/locations.service';
import { RideService } from '../modules/ride/ride.service';
import { UserRole, Location, TripStatus } from '../types';

export function setupSocketGateway(io: Server) {
  io.on('connection', (socket: Socket) => {
    // Authentication context from middleware
    const { id, role } = (socket as any).user || {};
    
    console.log(`[SOCKET] ✅ Connected: ${id} as ${role} (SocketID: ${socket.id})`);

    (socket as any).isOnline = false;

    // Join specialized rooms
    socket.join(`${role}:${id}`);
    console.log(`[SOCKET] 🏠 ${id} joined room: ${role}:${id}`);

    /**
     * DRIVER INITIAL CLEANUP
     */
    if (role === UserRole.DRIVER) {
      LocationsService.removeDriverLocation(id).catch(() => {});
    }

    /**
     * DRIVER EVENTS
     */
    if (role === UserRole.DRIVER) {
      socket.on('goOnline', async (loc?: Location) => {
        console.log(`[SOCKET] 🟢 Driver ${id} is now ONLINE`);
        (socket as any).isOnline = true;
        if (loc) {
          await LocationsService.updateDriverLocation(id, loc);
        }
      });

      socket.on('goOffline', async () => {
        console.log(`[SOCKET] 🔴 Driver ${id} is now OFFLINE`);
        (socket as any).isOnline = false;
        await LocationsService.removeDriverLocation(id);
      });

      socket.on('updateLocation', async (loc: Location) => {
        try {
          if ((socket as any).isOnline) {
            console.log(`[SOCKET] 📍 Location from driver ${id}: lat=${loc.lat}, lng=${loc.lng}`);
            await LocationsService.updateDriverLocation(id, loc);
          }
        } catch (err) {
          // Redis down, skip silently
        }

        // Broadcast to specific rider if driver is on a trip
        const currentTrip = await RideService.getCurrentRide(id, UserRole.DRIVER);
        if (currentTrip && currentTrip.status !== TripStatus.COMPLETED) {
          console.log(`[SOCKET] 📡 Broadcasting driver loc to rider:${currentTrip.rider_id}`);
          io.to(`rider:${currentTrip.rider_id}`).emit('driverLocationUpdate', loc);
        }
      });

      socket.on('acceptTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🤝 Driver ${id} accepts trip: ${tripId}`);
        try {
          await RideService.acceptTrip(tripId, id);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Accept trip failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('pickUpRider', async (tripId: string) => {
        console.log(`[SOCKET] 🚕 Driver ${id} picked up rider for trip: ${tripId}`);
        try {
          await RideService.updateTripStatus(tripId, TripStatus.IN_PROGRESS);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Pick up rider failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('completeTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🏁 Driver ${id} completed trip: ${tripId}`);
        try {
          await RideService.updateTripStatus(tripId, TripStatus.COMPLETED);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Complete trip failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        console.log(`[SOCKET] 💬 Message from Driver ${id} for Trip ${data.tripId}: ${data.message}`);
        const trip = await RideService.getCurrentRide(id, UserRole.DRIVER);
        if (trip && trip.id === data.tripId) {
          io.to(`rider:${trip.rider_id}`).emit('messageReceived', {
            senderId: id,
            role: 'driver',
            message: data.message,
            timestamp: new Date()
          });
        }
      });

      socket.on('disconnect', async () => {
        console.log(`[SOCKET] ❌ Driver ${id} disconnected`);
        try {
          await LocationsService.removeDriverLocation(id);
        } catch (err) {}
      });
    }

    /**
     * RIDER EVENTS
     */
    if (role === UserRole.RIDER) {
      socket.on('updateLocation', async (loc: Location) => {
        try {
          console.log(`[SOCKET] 📍 Location from rider ${id}: lat=${loc.lat}, lng=${loc.lng}`);
          // Broadcast to specific driver if rider is on a trip
          const currentTrip = await RideService.getCurrentRide(id, UserRole.RIDER);
          if (currentTrip && currentTrip.driver_id && currentTrip.status !== TripStatus.COMPLETED) {
            console.log(`[SOCKET] 📡 Broadcasting rider loc to driver:${currentTrip.driver_id}`);
            io.to(`driver:${currentTrip.driver_id}`).emit('riderLocationUpdate', loc);
          }
        } catch (err) {}
      });

      socket.on('requestRide', async (data: { pickup: Location & { address: string }; destination: Location & { address: string } }) => {
        console.log(`[SOCKET] 🚕 Ride request from rider ${id}: From ${data.pickup?.address} to ${data.destination?.address}`);
        try {
          const trip = await RideService.requestRide(id, data.pickup, data.destination);
          socket.emit('tripUpdate', trip);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Request ride failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('cancelTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🚫 Trip cancellation from rider ${id} for trip: ${tripId}`);
        try {
          await RideService.cancelTrip(tripId);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Cancel trip failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        console.log(`[SOCKET] 💬 Message from Rider ${id} for Trip ${data.tripId}: ${data.message}`);
        const trip = await RideService.getCurrentRide(id, UserRole.RIDER);
        if (trip && trip.id === data.tripId && trip.driver_id) {
          io.to(`driver:${trip.driver_id}`).emit('messageReceived', {
            senderId: id,
            role: 'rider',
            message: data.message,
            timestamp: new Date()
          });
        }
      });
    }

    socket.on('error', (err) => {
      console.error('[SOCKET] 💥 Error:', err);
    });
  });
}
