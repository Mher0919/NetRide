"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketGateway = setupSocketGateway;
const locations_service_1 = require("../modules/location/locations.service");
const ride_service_1 = require("../modules/ride/ride.service");
const types_1 = require("../types");
function setupSocketGateway(io) {
    io.on('connection', (socket) => {
        // Authentication context from middleware
        const { id, role } = socket.user || {};
        console.log(`[SOCKET] ✅ Connected: ${id} as ${role} (SocketID: ${socket.id})`);
        socket.isOnline = false;
        // Join specialized rooms
        socket.join(`${role}:${id}`);
        console.log(`[SOCKET] 🏠 ${id} joined room: ${role}:${id}`);
        /**
         * DRIVER INITIAL CLEANUP
         */
        if (role === types_1.UserRole.DRIVER) {
            locations_service_1.LocationsService.removeDriverLocation(id).catch(() => { });
        }
        /**
         * DRIVER EVENTS
         */
        if (role === types_1.UserRole.DRIVER) {
            socket.on('goOnline', async (loc) => {
                console.log(`[SOCKET] 🟢 Driver ${id} is now ONLINE`);
                socket.isOnline = true;
                if (loc) {
                    await locations_service_1.LocationsService.updateDriverLocation(id, loc);
                }
            });
            socket.on('goOffline', async () => {
                console.log(`[SOCKET] 🔴 Driver ${id} is now OFFLINE`);
                socket.isOnline = false;
                await locations_service_1.LocationsService.removeDriverLocation(id);
            });
            socket.on('updateLocation', async (loc) => {
                try {
                    if (socket.isOnline) {
                        console.log(`[SOCKET] 📍 Location from driver ${id}: lat=${loc.lat}, lng=${loc.lng}`);
                        await locations_service_1.LocationsService.updateDriverLocation(id, loc);
                    }
                }
                catch (err) {
                    // Redis down, skip silently
                }
                // Broadcast to specific rider if driver is on a trip
                const currentTrip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
                if (currentTrip && currentTrip.status !== types_1.TripStatus.COMPLETED) {
                    console.log(`[SOCKET] 📡 Broadcasting driver loc to rider:${currentTrip.rider_id}`);
                    io.to(`rider:${currentTrip.rider_id}`).emit('driverLocationUpdate', loc);
                }
            });
            socket.on('acceptTrip', async (tripId) => {
                console.log(`[SOCKET] 🤝 Driver ${id} accepts trip: ${tripId}`);
                try {
                    await ride_service_1.RideService.acceptTrip(tripId, id);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Accept trip failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('pickUpRider', async (tripId) => {
                console.log(`[SOCKET] 🚕 Driver ${id} picked up rider for trip: ${tripId}`);
                try {
                    await ride_service_1.RideService.updateTripStatus(tripId, types_1.TripStatus.IN_PROGRESS);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Pick up rider failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('completeTrip', async (tripId) => {
                console.log(`[SOCKET] 🏁 Driver ${id} completed trip: ${tripId}`);
                try {
                    await ride_service_1.RideService.updateTripStatus(tripId, types_1.TripStatus.COMPLETED);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Complete trip failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('sendMessage', async (data) => {
                console.log(`[SOCKET] 💬 Message from Driver ${id} for Trip ${data.tripId}: ${data.message}`);
                const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
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
                    await locations_service_1.LocationsService.removeDriverLocation(id);
                }
                catch (err) { }
            });
        }
        /**
         * RIDER EVENTS
         */
        if (role === types_1.UserRole.RIDER) {
            socket.on('updateLocation', async (loc) => {
                try {
                    console.log(`[SOCKET] 📍 Location from rider ${id}: lat=${loc.lat}, lng=${loc.lng}`);
                    // Broadcast to specific driver if rider is on a trip
                    const currentTrip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.RIDER);
                    if (currentTrip && currentTrip.driver_id && currentTrip.status !== types_1.TripStatus.COMPLETED) {
                        console.log(`[SOCKET] 📡 Broadcasting rider loc to driver:${currentTrip.driver_id}`);
                        io.to(`driver:${currentTrip.driver_id}`).emit('riderLocationUpdate', loc);
                    }
                }
                catch (err) { }
            });
            socket.on('requestRide', async (data) => {
                console.log(`[SOCKET] 🚕 Ride request from rider ${id}: From ${data.pickup?.address} to ${data.destination?.address}`);
                try {
                    const trip = await ride_service_1.RideService.requestRide(id, data.pickup, data.destination);
                    socket.emit('tripUpdate', trip);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Request ride failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('cancelTrip', async (tripId) => {
                console.log(`[SOCKET] 🚫 Trip cancellation from rider ${id} for trip: ${tripId}`);
                try {
                    await ride_service_1.RideService.cancelTrip(tripId);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Cancel trip failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('sendMessage', async (data) => {
                console.log(`[SOCKET] 💬 Message from Rider ${id} for Trip ${data.tripId}: ${data.message}`);
                const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.RIDER);
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
//# sourceMappingURL=socket.gateway.js.map