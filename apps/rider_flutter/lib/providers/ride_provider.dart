import 'dart:io';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart';
import '../services/api_service.dart';

class RideProvider with ChangeNotifier {
  TripStatus _status = TripStatus.IDLE;
  String? _tripId;
  DriverInfo? _driver;
  double? _estimatedFare;
  IO.Socket? _socket;
  bool _isConnected = false;
  Trip? _currentTrip;
  List<ChatMessage> _messages = [];

  TripStatus get status => _status;
  String? get tripId => _tripId;
  DriverInfo? get driver => _driver;
  double? get estimatedFare => _estimatedFare;
  bool get isConnected => _isConnected;
  Trip? get currentTrip => _currentTrip;
  List<ChatMessage> get messages => _messages;

  void initSocket(String token) {
    // 10.0.2.2 is the special alias to your host loopback interface (127.0.0.1 on your development machine)
    final url = Platform.isAndroid ? 'http://10.0.2.2:3000' : 'http://127.0.0.1:3000';
    print('--- SOCKET INIT ---');
    print('URL: $url');
    print('Token: $token');
    print('-------------------');

    _socket = IO.io(url, IO.OptionBuilder()
      .setTransports(['websocket']) // Force websocket
      .enableForceNew() // Ensure fresh connection
      .enableReconnection()
      .setAuth({
        'token': token,
        'role': 'rider'
      })
      .build());

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
      print('Rider Connect Error: $err');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      final trip = Trip.fromJson(data);
      _currentTrip = trip;
      _status = trip.status;
      _tripId = trip.id;
      
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
      if (_driver != null) {
        _driver = DriverInfo(
          id: _driver!.id,
          name: _driver!.name,
          vehicle: _driver!.vehicle,
          plate: _driver!.plate,
          location: Location.fromJson(data),
        );
        notifyListeners();
      }
    });

    _socket!.on('messageReceived', (data) {
      final msg = ChatMessage.fromJson(data);
      _messages.add(msg);
      notifyListeners();
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

  void requestRide(Location pickup, Location destination) {
    _socket?.emit('requestRide', {
      'pickup': pickup.toJson(),
      'destination': destination.toJson(),
    });
    _status = TripStatus.REQUESTED;
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

  Future<void> rateRide(String rideId, int rating, String reviewText) async {
    await ApiService.rateRide(
      rideId: rideId,
      rating: rating,
      reviewText: reviewText,
    );
  }

  @override
  void dispose() {
    _socket?.disconnect();
    super.dispose();
  }
}
