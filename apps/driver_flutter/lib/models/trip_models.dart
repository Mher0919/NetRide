enum DriverStatus { offline, online, onTrip }

enum TripStatus {
  REQUESTED,
  ACCEPTED,
  DRIVER_ARRIVING,
  IN_PROGRESS,
  COMPLETED,
  CANCELLED
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

class Trip {
  final String id;
  final String riderId;
  final String? driverId;
  final TripStatus status;
  final Location pickup;
  final Location destination;
  final double? fareAmount;

  Trip({
    required this.id,
    required this.riderId,
    this.driverId,
    required this.status,
    required this.pickup,
    required this.destination,
    this.fareAmount,
  });

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
