import 'dart:io';
import 'package:flutter/material.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../models/trip_models.dart';

class DriverProvider with ChangeNotifier {
  DriverStatus _status = DriverStatus.offline;
  Trip? _currentTrip;
  Trip? _incomingRequest;
  IO.Socket? _socket;
  bool _isConnected = false;
  Location? _lastLocation;
  double _heading = 0;
  Location? _riderLocation;
  List<ChatMessage> _messages = [];

  DriverStatus get status => _status;
  Trip? get currentTrip => _currentTrip;
  Trip? get incomingRequest => _incomingRequest;
  bool get isConnected => _isConnected;
  Location? get lastLocation => _lastLocation;
  double get heading => _heading;
  Location? get riderLocation => _riderLocation;
  List<ChatMessage> get messages => _messages;

  void initSocket(String token) {
    // 10.0.2.2 is the special alias to your host loopback interface (127.0.0.1 on your development machine)
    final url = Platform.isAndroid ? 'http://10.0.2.2:3000' : 'http://127.0.0.1:3000';
    print('--- DRIVER SOCKET INIT ---');
    print('URL: $url');
    print('Token: $token');
    print('--------------------------');

    _socket = IO.io(url, IO.OptionBuilder()
      .setTransports(['websocket']) // Force websocket
      .enableForceNew()
      .enableReconnection()
      .setAuth({
        'token': token,
        'role': 'driver'
      })
      .build());

    _socket!.onConnect((_) {
      print('Driver connected to socket');
      _isConnected = true;
      notifyListeners();
    });

    _socket!.onDisconnect((_) {
      print('Driver disconnected from socket');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.onConnectError((err) {
      print('Driver Connect Error: $err');
      _isConnected = false;
      notifyListeners();
    });

    _socket!.on('newTripRequest', (data) {
      _incomingRequest = Trip.fromJson(data);
      notifyListeners();
    });

    _socket!.on('tripUpdate', (data) {
      final trip = Trip.fromJson(data);
      if (trip.status == TripStatus.ACCEPTED || trip.status == TripStatus.IN_PROGRESS) {
        _currentTrip = trip;
        _incomingRequest = null;
        _status = DriverStatus.onTrip;
        notifyListeners();
      } else if (trip.status == TripStatus.COMPLETED || trip.status == TripStatus.CANCELLED) {
        _currentTrip = null;
        _status = DriverStatus.online;
        notifyListeners();
      }
    });

    _socket!.on('messageReceived', (data) {
      final msg = ChatMessage.fromJson(data);
      _messages.add(msg);
      notifyListeners();
    });

    _socket!.on('riderLocationUpdate', (data) {
      _riderLocation = Location.fromJson(data);
      notifyListeners();
    });

    _socket!.on('error', (data) => print('Socket Error: $data'));
  }

  void sendMessage(String tripId, String message) {
    _socket?.emit('sendMessage', {'tripId': tripId, 'message': message});
    _messages.add(ChatMessage(
      senderId: 'me', 
      role: 'driver',
      message: message,
      timestamp: DateTime.now(),
    ));
    notifyListeners();
  }

  void clearMessages() {
    _messages = [];
    notifyListeners();
  }

  void setOnline({double? lat, double? lng}) {
    _status = DriverStatus.online;
    if (lat != null && lng != null) {
      _socket?.emit('goOnline', {'lat': lat, 'lng': lng});
    } else {
      _socket?.emit('goOnline');
    }
    notifyListeners();
  }

  void setOffline() {
    _status = DriverStatus.offline;
    _socket?.emit('goOffline');
    _currentTrip = null;
    _incomingRequest = null;
    notifyListeners();
  }

  void acceptTrip(String tripId) {
    _socket?.emit('acceptTrip', tripId);
  }

  void pickUpRider(String tripId) {
    _socket?.emit('pickUpRider', tripId);
  }

  void completeTrip(String tripId) {
    _socket?.emit('completeTrip', tripId);
  }

  void updateLocation(double lat, double lng, {double heading = 0}) {
    _lastLocation = Location(lat: lat, lng: lng);
    _heading = heading;
    _socket?.emit('updateLocation', {'lat': lat, 'lng': lng, 'heading': heading});
    notifyListeners();
  }

  void setIncomingRequest(Trip? request) {
    _incomingRequest = request;
    notifyListeners();
  }

  @override
  void dispose() {
    _socket?.disconnect();
    super.dispose();
  }
}
