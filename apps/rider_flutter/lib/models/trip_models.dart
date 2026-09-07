import '../utils/test_user.dart';

enum TripStatus {
  REQUESTED,
  ACCEPTED,
  DRIVER_ARRIVING,
  IN_PROGRESS,
  COMPLETED,
  CANCELLED,
  IDLE // Added for UI state
}

enum VehicleClass {
  CORE,
  ELITE,
  PRESTIGE
}

class Location {
  final double lat;
  final double lng;
  final double? heading;
  final String? address;

  Location({required this.lat, required this.lng, this.heading, this.address});

  factory Location.fromJson(Map<String, dynamic> json) {
    return Location(
      lat: (json['lat'] as num).toDouble(),
      lng: (json['lng'] as num).toDouble(),
      heading: json['heading'] is num ? (json['heading'] as num).toDouble() : null,
      address: json['address'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'lat': lat,
      'lng': lng,
      if (heading != null) 'heading': heading,
      if (address != null) 'address': address,
    };
  }
}

class DriverInfo {
  final String id;
  final String name;
  final String? email;
  final String? vehicle;
  final String? plate;
  final double rating;
  final int totalRides;
  final Location? location;

  DriverInfo({
    required this.id,
    required this.name,
    this.email,
    this.vehicle,
    this.plate,
    this.rating = 5.0,
    this.totalRides = 0,
    this.location,
  });

  /// No fabricated vehicle/plate — those are only ever set from real
  /// backend driver records (or null, and the UI hides the fields).
  factory DriverInfo.fromJson(Map<String, dynamic> json) {
    return DriverInfo(
      id: json['id'] ?? '',
      name: json['name'] ?? '',
      email: json['email'],
      vehicle: json['vehicle']?.toString(),
      plate: json['plate']?.toString(),
      rating: (json['rating'] as num?)?.toDouble() ?? 5.0,
      totalRides: json['totalRides'] as int? ?? 0,
      location: json['location'] != null ? Location.fromJson(json['location']) : null,
    );
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

  /// Cancellation audit trail (042): who ended the ride and why.
  final String? cancelledBy;
  final String? cancellationReasonCode;
  final String? cancellationReasonText;

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
    this.cancelledBy,
    this.cancellationReasonCode,
    this.cancellationReasonText,
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
      cancelledBy: json['cancelled_by']?.toString(),
      cancellationReasonCode: json['cancellation_reason_code']?.toString(),
      cancellationReasonText: json['cancellation_reason_text']?.toString(),
    );
  }
}
