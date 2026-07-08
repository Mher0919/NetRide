// apps/driver_flutter/lib/services/communication_service.dart
//
// Owns the in-trip communication surface (chat thread + masked call state)
// for the driver app. Symmetric to the rider app's equivalent — both
// services share the same wire protocol and HTTP endpoints.
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_service.dart';

enum CallPhase { idle, ringing, connecting, connected, ended, failed }

class ChatMessage {
  final String? id;
  final String senderId;
  final String role; // 'rider' | 'driver'
  final String message;
  final DateTime timestamp;
  final bool pending;

  const ChatMessage({
    this.id,
    required this.senderId,
    required this.role,
    required this.message,
    required this.timestamp,
    this.pending = false,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final ts = json['timestamp'];
    return ChatMessage(
      id: json['id']?.toString(),
      senderId: json['senderId']?.toString() ?? json['sender_id']?.toString() ?? '',
      role: json['role']?.toString() ?? 'rider',
      message: json['message']?.toString() ?? '',
      timestamp: ts is DateTime
          ? ts
          : DateTime.parse(ts.toString()).toLocal(),
      pending: false,
    );
  }

  ChatMessage copyWith({String? id, bool? pending}) => ChatMessage(
        id: id ?? this.id,
        senderId: senderId,
        role: role,
        message: message,
        timestamp: timestamp,
        pending: pending ?? this.pending,
      );
}

class CommunicationService extends ChangeNotifier {
  io.Socket? _socket;
  String? _driverId;
  String? _currentTripId;
  String? _peerName;

  final List<ChatMessage> _messages = [];
  bool _loadingHistory = false;
  String? _lastError;

  CallPhase _callPhase = CallPhase.idle;
  String? _callToken;
  String? _conferenceName;
  DateTime? _tokenExpiresAt;
  bool _muted = false;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get loadingHistory => _loadingHistory;
  String? get lastError => _lastError;
  CallPhase get callPhase => _callPhase;
  String? get callToken => _callToken;
  String? get conferenceName => _conferenceName;
  DateTime? get tokenExpiresAt => _tokenExpiresAt;
  bool get muted => _muted;
  String? get peerName => _peerName;

  void attach(io.Socket? socket, {required String driverId, required String tripId, String? peerName}) {
    detach();
    _socket = socket;
    _driverId = driverId;
    _currentTripId = tripId;
    _peerName = peerName;

    if (_socket != null) {
      _socket!.on('messageReceived', _onIncomingMessage);
      _socket!.on('messageDelivered', _onMessageDelivered);
      _socket!.on('error', _onSocketError);
      _socket!.on('callEnded', (_) => _resetCall());
    }
  }

  /// Convenience for the trip screen. Stores the socket + userId,
  /// attaches listeners, and seeds chat history from the backend.
  Future<void> attachAndLoad({
    required io.Socket? socket,
    required String? userId,
    required String tripId,
    String? peerName,
  }) async {
    attach(
      socket,
      driverId: userId ?? '',
      tripId: tripId,
      peerName: peerName,
    );
    await loadHistory();
  }

  void detach() {
    final socket = _socket;
    if (socket != null) {
      socket.off('messageReceived', _onIncomingMessage);
      socket.off('messageDelivered', _onMessageDelivered);
      socket.off('error', _onSocketError);
      socket.off('callEnded');
    }
    _socket = null;
    _currentTripId = null;
    _peerName = null;
    _messages.clear();
    _resetCall();
    notifyListeners();
  }

  Future<void> loadHistory() async {
    final tripId = _currentTripId;
    if (tripId == null) return;
    _loadingHistory = true;
    notifyListeners();
    try {
      final response = await ApiService.dio.get('/ride/$tripId/messages');
      final list = (response.data['messages'] as List?) ?? const [];
      _messages
        ..clear()
        ..addAll(list.map((j) => ChatMessage.fromJson(Map<String, dynamic>.from(j as Map))));
    } catch (e) {
      debugPrint('[CommunicationService] loadHistory failed: $e');
      _lastError = 'Could not load chat history.';
    } finally {
      _loadingHistory = false;
      notifyListeners();
    }
  }

  void sendMessage(String text) {
    final tripId = _currentTripId;
    final driverId = _driverId;
    final socket = _socket;
    if (tripId == null || driverId == null) {
      _lastError = 'No active trip to chat in.';
      notifyListeners();
      return;
    }
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    if (trimmed.length > 1000) {
      _lastError = 'Message too long (1000 character max).';
      notifyListeners();
      return;
    }

    final optimistic = ChatMessage(
      senderId: driverId,
      role: 'driver',
      message: trimmed,
      timestamp: DateTime.now(),
      pending: true,
    );
    _messages.add(optimistic);
    notifyListeners();

    if (socket == null || !socket.connected) {
      _lastError = 'You appear to be offline. Message will retry when reconnected.';
      notifyListeners();
      return;
    }

    socket.emit('sendMessage', {'tripId': tripId, 'message': trimmed});
  }

  void _onIncomingMessage(dynamic data) {
    try {
      final json = Map<String, dynamic>.from(data as Map);
      final incomingTrip = json['tripId']?.toString();
      if (incomingTrip != null && incomingTrip != _currentTripId) return;
      _messages.add(ChatMessage.fromJson(json));
      notifyListeners();
    } catch (e) {
      debugPrint('[CommunicationService] bad messageReceived: $e');
    }
  }

  void _onMessageDelivered(dynamic data) {
    try {
      final json = Map<String, dynamic>.from(data as Map);
      final id = json['id']?.toString();
      if (id == null) return;
      final idx = _messages.lastIndexWhere((m) => m.pending);
      if (idx != -1) {
        _messages[idx] = _messages[idx].copyWith(id: id, pending: false);
        notifyListeners();
      }
    } catch (e) {
      debugPrint('[CommunicationService] bad messageDelivered: $e');
    }
  }

  void _onSocketError(dynamic data) {
    final msg = data is String ? data : data?.toString() ?? 'Unknown error';
    _lastError = msg;
    if (msg.toLowerCase().contains('too quickly') ||
        msg.toLowerCase().contains('only available') ||
        msg.toLowerCase().contains('not part')) {
      _markPendingFailed();
    }
    notifyListeners();
  }

  void _markPendingFailed() {
    for (var i = 0; i < _messages.length; i++) {
      if (_messages[i].pending && _messages[i].role == 'driver') {
        _messages[i] = _messages[i].copyWith(pending: false);
      }
    }
  }

  void clearError() {
    _lastError = null;
    notifyListeners();
  }

  // ---- Call surface -------------------------------------------------------

  Future<bool> startCall() async {
    final tripId = _currentTripId;
    if (tripId == null) {
      _lastError = 'No active trip to call.';
      notifyListeners();
      return false;
    }
    _callPhase = CallPhase.connecting;
    _lastError = null;
    notifyListeners();
    try {
      final response = await ApiService.dio.post('/ride/$tripId/call-token');
      _callToken = response.data['token']?.toString();
      _conferenceName = response.data['conferenceName']?.toString();
      final exp = response.data['expiresAt'];
      _tokenExpiresAt = exp is num
          ? DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000)
          : DateTime.now().add(const Duration(minutes: 5));
      _callPhase = CallPhase.ringing;
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('[CommunicationService] startCall failed: $e');
      _callPhase = CallPhase.failed;
      _lastError = 'Unable to start the call. Please try again.';
      notifyListeners();
      return false;
    }
  }

  void markCallConnected() {
    _callPhase = CallPhase.connected;
    notifyListeners();
  }

  void endCall() {
    _callPhase = CallPhase.ended;
    _resetCall();
    notifyListeners();
  }

  void toggleMute() {
    _muted = !_muted;
    notifyListeners();
  }

  void _resetCall() {
    _callPhase = CallPhase.idle;
    _callToken = null;
    _conferenceName = null;
    _tokenExpiresAt = null;
    _muted = false;
  }
}