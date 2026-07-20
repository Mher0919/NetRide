import 'dart:io';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart';
import '../services/api_service.dart';
import '../services/sound_service.dart';

class RideProvider with ChangeNotifier {
  TripStatus _status = TripStatus.IDLE;
  String? _tripId;
  DriverInfo? _driver;
  double? _estimatedFare;
  IO.Socket? _socket;
  bool _isConnected = false;
  Trip? _currentTrip;
  List<ChatMessage> _messages = [];
  final Map<String, Location> _nearbyDrivers = {};

  TripStatus get status => _status;
  String? get tripId => _tripId;
  DriverInfo? get driver => _driver;
  double? get estimatedFare => _estimatedFare;
  bool get isConnected => _isConnected;
  Trip? get currentTrip => _currentTrip;
  List<ChatMessage> get messages => _messages;
  Map<String, Location> get nearbyDrivers => _nearbyDrivers;

  /// Exposed so the CommunicationService can hook into the same socket
  /// the rest of the ride flow uses. Returns null if the socket hasn't
  /// been initialised yet (e.g. user is still on the splash screen).
  IO.Socket? get socket => _socket;

  void subscribeToNearbyDrivers(Location loc) {
    _socket?.emit('subscribeToNearbyDrivers', loc.toJson());
  }

  void initSocket(String token) {
    final url = 'https://netride.onrender.com';
    print('--- SOCKET INIT ---');
    print('URL: $url');
    print('Token: $token');
    print('-------------------');

    _socket = IO.io(url, <String, dynamic>{
      'transports': ['websocket'], // Force websocket
      'forceNew': true, // Ensure fresh connection
      'reconnection': true,
      'reconnectionAttempts': double.infinity,
      'reconnectionDelay': 1000,
      'reconnectionDelayMax': 15000,
      'randomizationFactor': 0.5,
      'auth': {'token': token, 'role': 'RIDER'},
    });

    _socket!.onConnect((_) {
      print('Rider connected to socket');
      _isConnected = true;
      notifyListeners();
    });

    _socket!.onDisconnect((_) {
      print('Rider disconnected from socket');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      final errStr = err.toString();
      if (errStr.contains('Failed host lookup') || errStr.contains('No address associated')) {
        print('Rider Connect Error — DNS resolution failed for netride.onrender.com. Retrying...');
      } else {
        print('Rider Connect Error: $err');
      }
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      final oldStatus = _status;
      final trip = Trip.fromJson(data);
      _currentTrip = trip;
      _status = trip.status;
      _tripId = trip.id;
      
      if (oldStatus == TripStatus.REQUESTED && trip.status == TripStatus.ACCEPTED) {
        SoundService.instance.play(SoundEffect.orderAccepted);
      }
      if (oldStatus != TripStatus.CANCELLED && trip.status == TripStatus.CANCELLED) {
        SoundService.instance.play(SoundEffect.orderCancelled);
      }
      if (oldStatus != TripStatus.COMPLETED && trip.status == TripStatus.COMPLETED) {
        SoundService.instance.play(SoundEffect.tripCompleted);
      }
      
      if (trip.status == TripStatus.ACCEPTED || trip.status == TripStatus.IN_PROGRESS) {
        Location? initialLoc;
        if (data['driver_location'] != null) {
          initialLoc = Location.fromJson(data['driver_location']);
        }

        if (_driver == null) {
          _driver = DriverInfo(
            id: trip.driverId ?? '',
            name: 'Driver',
            vehicle: 'Sedan',
            plate: 'ABC-123',
            location: initialLoc,
          );
        } else if (initialLoc != null) {
          _driver = DriverInfo(
            id: _driver!.id,
            name: _driver!.name,
            vehicle: _driver!.vehicle,
            plate: _driver!.plate,
            location: initialLoc,
          );
        }
      }
      notifyListeners();
    });

    _socket!.on('driverLocationUpdate', (data) {
      final driverId = data['driverId'];
      final loc = Location.fromJson(data);

      if (_driver != null && _driver!.id == driverId) {
        _driver = DriverInfo(
          id: _driver!.id,
          name: _driver!.name,
          vehicle: _driver!.vehicle,
          plate: _driver!.plate,
          location: loc,
        );
      } else {
        // It's a nearby available driver
        _nearbyDrivers[driverId!] = loc;
      }
      notifyListeners();
    });

    _socket!.on('messageReceived', (data) {
      final msg = ChatMessage.fromJson(data);
      _messages.add(msg);
      notifyListeners();
    });

    _socket!.on('tipReceived', (data) {
      try {
        SoundService.instance.play(SoundEffect.tipReceived);
      } catch (e) {
        print('Error playing tip sound: $e');
      }
    });

    _socket!.on('error', (data) => print('Socket Error: $data'));
  }

  void sendMessage(String tripId, String message) {
    _socket?.emit('sendMessage', {'tripId': tripId, 'message': message});
    _messages.add(ChatMessage(
      senderId: 'me',
      role: 'rider',
      message: message,
      timestamp: DateTime.now(),
    ));
    notifyListeners();
  }

  void clearMessages() {
    _messages = [];
    notifyListeners();
  }

  void requestRide(Location pickup, Location destination, {
    VehicleClass requestedClass = VehicleClass.CORE,
    bool isScheduled = false,
    DateTime? scheduledAt,
    bool favoritePriority = false
  }) {
    _socket?.emit('requestRide', {
      'pickup': pickup.toJson(),
      'destination': destination.toJson(),
      'requestedClass': requestedClass.toString().split('.').last,
      'isScheduled': isScheduled,
      'scheduledAt': scheduledAt?.toIso8601String(),
      'favoritePriority': favoritePriority
    });
    
    if (!isScheduled) {
      _status = TripStatus.REQUESTED;
    }
    notifyListeners();
  }

  void setEstimatedFare(double fare) {
    _estimatedFare = fare;
    notifyListeners();
  }

  void cancelRide() {
    if (_tripId != null) {
      _socket?.emit('cancelTrip', _tripId);
    }
    reset();
  }

  void reset() {
    _status = TripStatus.IDLE;
    _tripId = null;
    _driver = null;
    _estimatedFare = null;
    notifyListeners();
  }

  void updateLocation(double lat, double lng) {
    _socket?.emit('updateLocation', {'lat': lat, 'lng': lng});
  }

  Future<void> rateRide(String rideId, int rating, String reviewText, {bool favorite = false}) async {
    await ApiService.rateRide(
      rideId: rideId,
      rating: rating,
      reviewText: reviewText,
      favorite: favorite
    );
  }

  Future<void> submitTip(String rideId, double amount) async {
    await ApiService.dio.post('/ride/$rideId/tip', data: {'amount': amount});
  }

  Future<void> onAppForegrounded() async {
    if (_socket == null || !_socket!.connected) {
      debugPrint('[RIDE] Socket disconnected on foreground — reinitializing');
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token != null) {
        initSocket(token);
      }
    }
  }

  @override
  void dispose() {
    _socket?.disconnect();
    super.dispose();
  }
}
