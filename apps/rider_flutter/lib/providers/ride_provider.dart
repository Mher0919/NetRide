import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:uuid/uuid.dart';
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
    // Socket base URL is derived once in ApiService so HTTP and WebSocket
    // gateways can never drift. Tokens are intentionally NOT logged (OWASP:
    // a JWT prefix leaks the signing algorithm header).
    final socketUrl = ApiService.socketBaseUrl;
    debugPrint('--- SOCKET INIT --- URL=$socketUrl token=<redacted>');

    _socket = IO.io(socketUrl, <String, dynamic>{
      // Negotiation order: WebSocket first (low-latency), then polling as
      // fallback (works through HTTP proxies that block ws upgrades). This
      // mirrors socket.io-client defaults and avoids the Android-emulator
      // "Failed host lookup" that the previous forced-websocket transport
      // masked.
      'transports': ['websocket', 'polling'],
      'forceNew': true, // Ensure fresh connection
      'reconnection': true,
      'reconnectionAttempts': double.infinity,
      'reconnectionDelay': 1000,
      'reconnectionDelayMax': 15000,
      'randomizationFactor': 0.5,
      'auth': {'token': token, 'role': 'RIDER'},
    });

    _socket!.onConnect((_) {
      debugPrint('[SOCKET] Rider connected URL=$socketUrl transport=${_socket?.io.engine?.transport?.name ?? '?'}');
      _isConnected = true;
      notifyListeners();
    });

    _socket!.onDisconnect((reason) {
      debugPrint('[SOCKET] Rider disconnected URL=$socketUrl reason=$reason');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      // Log the actual URL and the raw error — the previous version hardcoded
      // a misleading "DNS resolution failed for netride.onrender.com" message
      // regardless of the real cause, which made it impossible to tell a DNS
      // failure from a blocked WebSocket upgrade or a wrong path.
      debugPrint('[SOCKET] Rider connect error URL=$socketUrl raw=$err');
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
    bool favoritePriority = false,
    String? idempotencyKey,
  }) {
    debugPrint('[RIDE] requestRide called | socket=${_socket != null} connected=${_socket?.connected} pickup=${pickup.lat},${pickup.lng} dest=${destination.lat},${destination.lng}');
    if (_socket == null) {
      debugPrint('[RIDE] ❌ Socket is NULL — request will be silently dropped!');
    } else if (!_socket!.connected) {
      debugPrint('[RIDE] ⚠️ Socket exists but NOT connected — attempting emit anyway');
    }
    
    // Generate idempotency key if not provided (for retries)
    final key = idempotencyKey ?? const Uuid().v4();
    
    _socket?.emit('requestRide', {
      'pickup': pickup.toJson(),
      'destination': destination.toJson(),
      'requestedClass': requestedClass.toString().split('.').last,
      'isScheduled': isScheduled,
      'scheduledAt': scheduledAt?.toIso8601String(),
      'favoritePriority': favoritePriority,
      'idempotencyKey': key,
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
