import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/group_models.dart';
import '../services/group_service.dart';
import 'ride_provider.dart';

/// Rider-side group state. Owns the group inbox, open conversation,
/// current quote/payment dashboard, friends and live socket updates.
///
/// Every mutation still goes through the backend; this provider never
/// computes prices, payment status or permissions optimistically.
class GroupProvider extends ChangeNotifier {
  GroupProvider({RideProvider? ride}) {
    _ride = ride;
    _sub = ride?.groupEvents.listen(_onEvent);
    ride?.addListener(_onRideConnectionChanged);
  }

  RideProvider? _ride;
  StreamSubscription<Map<String, dynamic>>? _sub;

  List<GroupSummary> _groups = [];
  List<GroupSummary> get groups => _groups;

  List<NetRideFriend> _friends = [];
  List<NetRideFriend> get friends => _friends;
  List<NetRideFriend> _incomingRequests = [];
  List<NetRideFriend> get incomingRequests => _incomingRequests;
  List<NetRideFriend> _outgoingRequests = [];
  List<NetRideFriend> get outgoingRequests => _outgoingRequests;

  List<Map<String, dynamic>> _incomingInvitations = [];
  List<Map<String, dynamic>> get incomingInvitations => _incomingInvitations;

  GroupDetail? _current;
  GroupDetail? get current => _current;

  List<GroupMessage> _messages = [];
  List<GroupMessage> get messages => _messages;

  GroupPickup? _driverLocation;
  GroupPickup? get driverLocation => _driverLocation;

  bool _loadingGroups = false;
  bool get loadingGroups => _loadingGroups;
  bool _loadingDetail = false;
  bool get loadingDetail => _loadingDetail;
  bool _busy = false;
  bool get busy => _busy;
  String? _error;
  String? get error => _error;

  String? _currentGroupId;
  String? get currentGroupId => _currentGroupId;

  Timer? _detailDebounce;
  Timer? _listDebounce;
  bool _lastConnected = false;

  int get unreadTotal =>
      _groups.fold<int>(0, (sum, g) => sum + g.unreadCount);

  Future<void> refreshGroups({bool silent = false}) async {
    if (!silent) {
      _loadingGroups = true;
      _error = null;
      notifyListeners();
    }
    try {
      final results = await Future.wait([
        GroupService.instance.listGroups(),
        GroupService.instance.incomingInvitations(),
      ]);
      _groups = results[0] as List<GroupSummary>;
      _incomingInvitations = results[1] as List<Map<String, dynamic>>;
      _loadingGroups = false;
      notifyListeners();
      if (_currentGroupId != null) {
        _ride?.subscribeGroup(_currentGroupId!);
      }
    } catch (e) {
      _loadingGroups = false;
      _error = 'We couldn\'t load your groups. Pull to refresh.';
      notifyListeners();
    }
  }

  Future<GroupDetail> openGroup(String groupId) async {
    if (_currentGroupId != null && _currentGroupId != groupId) {
      _ride?.unsubscribeGroup(_currentGroupId!);
    }
    _currentGroupId = groupId;
    _loadingDetail = true;
    _error = null;
    _driverLocation = null;
    _quotePreview = null;
    notifyListeners();
    _ride?.subscribeGroup(groupId);
    try {
      final results = await Future.wait([
        GroupService.instance.getGroup(groupId),
        GroupService.instance.messages(groupId),
      ]);
      _current = results[0] as GroupDetail;
      _messages = results[1] as List<GroupMessage>;
      _driverLocation = _current?.ride?.driverLocation;
      _loadingDetail = false;
      notifyListeners();
      _debouncedRefreshList();
      return _current!;
    } catch (e) {
      _loadingDetail = false;
      _error = 'We couldn\'t open this group.';
      notifyListeners();
      rethrow;
    }
  }

  void closeGroup() {
    final id = _currentGroupId;
    if (id != null) _ride?.unsubscribeGroup(id);
    _currentGroupId = null;
    _current = null;
    _messages = [];
    _driverLocation = null;
    _quotePreview = null;
    _detailDebounce?.cancel();
    notifyListeners();
  }

  Future<void> refreshCurrent({bool silent = false}) async {
    final id = _currentGroupId;
    if (id == null) return;
    if (!silent) {
      _loadingDetail = true;
      notifyListeners();
    }
    try {
      final results = await Future.wait([
        GroupService.instance.getGroup(id),
        GroupService.instance.messages(id),
      ]);
      _current = results[0] as GroupDetail;
      _messages = results[1] as List<GroupMessage>;
      _driverLocation = _current?.ride?.driverLocation ?? _driverLocation;
      _loadingDetail = false;
      notifyListeners();
      _debouncedRefreshList();
    } catch (_) {
      _loadingDetail = false;
      notifyListeners();
    }
  }

  Future<GroupDetail> createGroup({
    required String name,
    List<String> memberIds = const [],
  }) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final detail = await GroupService.instance.createGroup(
        name: name,
        memberIds: memberIds,
      );
      _busy = false;
      _currentGroupId = detail.id;
      _current = detail;
      _messages = await GroupService.instance.messages(detail.id);
      _ride?.subscribeGroup(detail.id);
      notifyListeners();
      await refreshGroups(silent: true);
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<GroupDetail> rename(String name) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.rename(id, name);
      _current = detail;
      _busy = false;
      notifyListeners();
      _debouncedRefreshList();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<GroupDetail> removeMember(String userId) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.removeMember(id, userId);
      _current = detail;
      _busy = false;
      notifyListeners();
      _debouncedRefreshList();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> leaveGroup() async {
    final id = _currentGroupId;
    if (id == null) return;
    _busy = true;
    notifyListeners();
    try {
      await GroupService.instance.leaveGroup(id);
      closeGroup();
      await refreshGroups(silent: true);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> cancelGroup() async {
    final id = _currentGroupId;
    if (id == null) return;
    _busy = true;
    notifyListeners();
    try {
      await GroupService.instance.cancelGroup(id);
      await refreshCurrent(silent: true);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<GroupDetail> setPickup({
    double? lat,
    double? lng,
    String? address,
    String? placeId,
    bool sameAsHost = false,
  }) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.setPickup(
        id,
        lat: lat,
        lng: lng,
        address: address,
        placeId: placeId,
        sameAsHost: sameAsHost,
      );
      _current = detail;
      _quotePreview = null;
      _busy = false;
      notifyListeners();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<GroupDetail> setDestination({
    required double lat,
    required double lng,
    required String address,
    String? placeId,
  }) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.setDestination(
        id,
        lat: lat,
        lng: lng,
        address: address,
        placeId: placeId,
      );
      _current = detail;
      _quotePreview = null;
      _busy = false;
      notifyListeners();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Map<String, dynamic>? _quotePreview;
  Map<String, dynamic>? get quotePreview => _quotePreview;

  Future<Map<String, dynamic>?> loadQuotePreview({String? promoCode}) async {
    final id = _currentGroupId;
    if (id == null) return null;
    try {
      _quotePreview = await GroupService.instance.previewQuote(id, promoCode: promoCode);
      notifyListeners();
      return _quotePreview;
    } catch (_) {
      _quotePreview = null;
      notifyListeners();
      return null;
    }
  }

  void clearQuotePreview() {
    _quotePreview = null;
    notifyListeners();
  }

  Future<GroupDetail> createQuote({
    required String splitMethod,
    String? promoCode,
    String vehicleCategory = 'CORE',
    Map<String, int>? customShares,
  }) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.createQuote(
        id,
        splitMethod: splitMethod,
        promoCode: promoCode,
        vehicleCategory: vehicleCategory,
        customShares: customShares,
      );
      _current = detail;
      _quotePreview = null;
      _busy = false;
      notifyListeners();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<GroupDetail> confirmPayment({bool useCredits = false}) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final detail = await GroupService.instance.confirmPayment(
        id,
        useCredits: useCredits,
      );
      _current = detail;
      _busy = false;
      notifyListeners();
      return detail;
    } catch (e) {
      _busy = false;
      notifyListeners();
      rethrow;
    }
  }

  Future<Map<String, dynamic>> requestRide() async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    _busy = true;
    notifyListeners();
    try {
      final result = await GroupService.instance.requestRide(id);
      await refreshCurrent(silent: true);
      return result;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  Future<void> sendMessage(String text) async {
    final id = _currentGroupId;
    if (id == null) return;
    final message = await GroupService.instance.sendMessage(id, text);
    if (!_messages.any((m) => m.id == message.id)) {
      _messages = [..._messages, message];
      notifyListeners();
    }
  }

  Future<void> inviteFriend(String userId) async {
    final id = _currentGroupId;
    if (id == null) return;
    await inviteFriendToGroup(id, userId);
    await refreshCurrent(silent: true);
  }

  Future<void> inviteFriendToGroup(String groupId, String userId) async {
    await GroupService.instance.inviteFriend(groupId, userId);
    await refreshGroups(silent: true);
    if (_currentGroupId == groupId) {
      await refreshCurrent(silent: true);
    }
  }

  Future<Map<String, dynamic>> inviteContact({
    required String phone,
    String? name,
    String? message,
  }) async {
    final id = _currentGroupId;
    if (id == null) throw StateError('No open group');
    final result = await GroupService.instance.inviteContact(
      id,
      phone: phone,
      name: name,
      message: message,
    );
    await refreshCurrent(silent: true);
    return result;
  }

  Future<void> cancelInvitation(String invitationId) async {
    final id = _currentGroupId;
    if (id == null) return;
    await GroupService.instance.cancelInvitation(id, invitationId);
    await refreshCurrent(silent: true);
  }

  Future<void> acceptInvitation(String invitationId) async {
    final detail = await GroupService.instance.acceptInvitation(invitationId);
    _currentGroupId = detail.id;
    _current = detail;
    _messages = await GroupService.instance.messages(detail.id);
    _ride?.subscribeGroup(detail.id);
    notifyListeners();
    await refreshGroups(silent: true);
  }

  Future<void> declineInvitation(String invitationId) async {
    await GroupService.instance.declineInvitation(invitationId);
    await refreshGroups(silent: true);
  }

  Future<GroupDetail> joinByToken(String token) async {
    final detail = await GroupService.instance.joinByToken(token);
    _currentGroupId = detail.id;
    _current = detail;
    _messages = await GroupService.instance.messages(detail.id);
    _ride?.subscribeGroup(detail.id);
    notifyListeners();
    await refreshGroups(silent: true);
    return detail;
  }

  Future<void> refreshFriends() async {
    try {
      final data = await GroupService.instance.friends();
      List<NetRideFriend> parse(dynamic raw) => (raw as List? ?? [])
          .whereType<Map>()
          .map((e) => NetRideFriend.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      _friends = parse(data['friends']);
      _incomingRequests = parse(data['incoming']);
      _outgoingRequests = parse(data['outgoing']);
      notifyListeners();
    } catch (_) {
      // Friends are optional to render; surface through the screen's own
      // error handling when the caller needs it.
    }
  }

  Future<Map<String, dynamic>> requestFriend({String? userId, String? phone}) async {
    final result = await GroupService.instance.requestFriend(
      userId: userId,
      phone: phone,
    );
    await refreshFriends();
    return result;
  }

  Future<void> respondFriend(String friendshipId, bool accept) async {
    await GroupService.instance.respondFriend(friendshipId, accept);
    await refreshFriends();
  }

  Future<void> removeFriend(String userId) async {
    await GroupService.instance.removeFriend(userId);
    await refreshFriends();
  }

  Future<List<ContactMatch>> matchContacts(List<Map<String, String>> contacts) {
    return GroupService.instance.matchContacts(contacts);
  }

  void _onRideConnectionChanged() {
    final connected = _ride?.isConnected == true;
    if (connected && !_lastConnected) {
      _lastConnected = true;
      if (_currentGroupId != null) _ride?.subscribeGroup(_currentGroupId!);
      refreshGroups(silent: true);
    } else if (!connected) {
      _lastConnected = false;
    }
  }

  void _onEvent(Map<String, dynamic> event) {
    final type = event['event']?.toString() ?? '';
    final messagePayload = event['message'] is Map
        ? Map<String, dynamic>.from(event['message'] as Map)
        : (event['content'] != null ? event : null);
    final groupId = event['groupId']?.toString() ??
        messagePayload?['group_id']?.toString() ??
        messagePayload?['groupId']?.toString();
    switch (type) {
      case 'groupMessageReceived':
        if (messagePayload != null &&
            _currentGroupId != null &&
            groupId == _currentGroupId) {
          final message = GroupMessage.fromJson(messagePayload);
          if (!_messages.any((m) => m.id == message.id)) {
            _messages = [..._messages, message];
            notifyListeners();
          }
          unawaited(GroupService.instance.markRead(_currentGroupId!));
        }
        _debouncedRefreshList();
        break;
      case 'groupDriverLocation':
        if (groupId == _currentGroupId && event['lat'] is num && event['lng'] is num) {
          _driverLocation = GroupPickup(
            lat: (event['lat'] as num).toDouble(),
            lng: (event['lng'] as num).toDouble(),
          );
          notifyListeners();
        }
        break;
      case 'groupLeft':
        if (groupId == _currentGroupId) {
          closeGroup();
        }
        _debouncedRefreshList();
        break;
      case 'groupInvitationReceived':
      case 'friendRequestReceived':
        refreshGroups(silent: true);
        refreshFriends();
        break;
      case 'groupActivity':
        _debouncedRefreshList();
        break;
      case 'groupSubscribed':
      case 'groupSubscriptionFailed':
        break;
      default:
        if (groupId == _currentGroupId) {
          _debouncedRefreshCurrent();
        }
        _debouncedRefreshList();
        break;
    }
  }

  void _debouncedRefreshCurrent() {
    _detailDebounce?.cancel();
    _detailDebounce = Timer(const Duration(milliseconds: 350), () {
      refreshCurrent(silent: true);
    });
  }

  void _debouncedRefreshList() {
    _listDebounce?.cancel();
    _listDebounce = Timer(const Duration(milliseconds: 450), () {
      refreshGroups(silent: true);
    });
  }

  void reset() {
    final currentId = _currentGroupId;
    if (currentId != null) _ride?.unsubscribeGroup(currentId);
    _groups = [];
    _friends = [];
    _incomingRequests = [];
    _outgoingRequests = [];
    _current = null;
    _messages = [];
    _driverLocation = null;
    _currentGroupId = null;
    _loadingGroups = false;
    _loadingDetail = false;
    _busy = false;
    _error = null;
    _detailDebounce?.cancel();
    _listDebounce?.cancel();
    notifyListeners();
  }

  @override
  void dispose() {
    _detailDebounce?.cancel();
    _listDebounce?.cancel();
    _sub?.cancel();
    _ride?.removeListener(_onRideConnectionChanged);
    super.dispose();
  }
}
