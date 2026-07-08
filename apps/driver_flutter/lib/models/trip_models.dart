enum DriverStatus { offline, online, onTrip }
import '../utils/test_user.dart';

enum TripStatus {
  REQUESTED,
  ACCEPTED,
  DRIVER_ARRIVING,
  IN_PROGRESS,
  COMPLETED,
  CANCELLED
}

enum VehicleClass {
  CORE,
  ELITE,
  PRESTIGE
}

class Location {
  final double lat;
  final double lng;
  final String? address;

  Location({required this.lat, required this.lng, this.address});

  factory Location.fromJson(Map<String, dynamic> json) {
    return Location(
      lat: (json['lat'] as num).toDouble(),
      lng: (json['lng'] as num).toDouble(),
      address: json['address'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'lat': lat,
      'lng': lng,
      if (address != null) 'address': address,
    };
  }
}

class RiderInfo {
  final String name;
  final String? email;
  final double rating;
  final int totalRides;

  RiderInfo({
    required this.name,
    this.email,
    this.rating = 5.0,
    this.totalRides = 0,
  });

  factory RiderInfo.fromJson(Map<String, dynamic> json) {
    return RiderInfo(
      name: json['name'] ?? 'Rider',
      email: json['email'],
      rating: (json['rating'] as num?)?.toDouble() ?? 5.0,
      totalRides: json['total_rides'] as int? ?? 0,
    );
  }
}

class DriverInfo {
  final String name;
  final String? email;
  final double rating;
  final int totalRides;

  DriverInfo({
    required this.name,
    this.email,
    this.rating = 5.0,
    this.totalRides = 0,
  });

  factory DriverInfo.fromJson(Map<String, dynamic> json) {
    return DriverInfo(
      name: json['name'] ?? 'Driver',
      email: json['email'],
      rating: (json['rating'] as num?)?.toDouble() ?? 5.0,
      totalRides: json['total_rides'] as int? ?? 0,
    );
  }
}

class Trip {
  final String id;
  final String riderId;
  final String? driverId;
  final TripStatus status;
  final Location pickup;
  final Location destination;
  final double? fareAmount;
  final double? initialMaxFare;
  final int? savingLikelihood;
  final RiderInfo? riderInfo;
  final DriverInfo? driverInfo;
  
  // Custom fields for driver request screen
  final double? calculatedPrice;
  final double? tripDistanceMeters;
  final double? tripDurationSeconds;
  final Map<String, dynamic>? routeGeometry;
  final double? driverToPickupEta;
  final double? driverToPickupDistance;
  final double? driverPricePerMile;

  Trip({
    required this.id,
    required this.riderId,
    this.driverId,
    required this.status,
    required this.pickup,
    required this.destination,
    this.fareAmount,
    this.initialMaxFare,
    this.savingLikelihood,
    this.riderInfo,
    this.driverInfo,
    this.calculatedPrice,
    this.tripDistanceMeters,
    this.tripDurationSeconds,
    this.routeGeometry,
    this.driverToPickupEta,
    this.driverToPickupDistance,
    this.driverPricePerMile,
  });

  bool get isTestTrip => isTestTripFor(riderInfo?.email, driverInfo?.email);

  factory Trip.fromJson(Map<String, dynamic> json) {
    return Trip(
      id: json['id'],
      riderId: json['rider_id'],
      driverId: json['driver_id'],
      status: TripStatus.values.firstWhere(
        (e) => e.toString().split('.').last == json['status'],
        orElse: () => TripStatus.REQUESTED,
      ),
      pickup: Location.fromJson(json['pickup']),
      destination: Location.fromJson(json['destination']),
      fareAmount: (json['fare_amount'] as num?)?.toDouble(),
      initialMaxFare: (json['initial_max_fare'] as num?)?.toDouble(),
      savingLikelihood: (json['saving_likelihood'] as num?)?.toInt(),
      riderInfo: json['rider_info'] != null ? RiderInfo.fromJson(json['rider_info']) : null,
      driverInfo: json['driver_info'] != null ? DriverInfo.fromJson(json['driver_info']) : null,
      calculatedPrice: (json['calculated_price'] as num?)?.toDouble(),
      tripDistanceMeters: (json['trip_distance_meters'] as num?)?.toDouble(),
      tripDurationSeconds: (json['trip_duration_seconds'] as num?)?.toDouble(),
      routeGeometry: json['route_geometry'] != null ? Map<String, dynamic>.from(json['route_geometry']) : null,
      driverToPickupEta: (json['driver_to_pickup_eta'] as num?)?.toDouble(),
      driverToPickupDistance: (json['driver_to_pickup_distance'] as num?)?.toDouble(),
      driverPricePerMile: (json['driver_price_per_mile'] as num?)?.toDouble(),
    );
  }
}

class ChatMessage {
  final String senderId;
  final String role;
  final String message;
  final DateTime timestamp;

  ChatMessage({
    required this.senderId,
    required this.role,
    required this.message,
    required this.timestamp,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    return ChatMessage(
      senderId: json['senderId'],
      role: json['role'],
      message: json['message'],
      timestamp: DateTime.parse(json['timestamp']),
    );
  }
}
