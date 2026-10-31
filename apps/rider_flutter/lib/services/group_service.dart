import 'package:dio/dio.dart';
import 'api_service.dart';
import '../models/group_models.dart';

/// Thin, typed HTTP client for the group-ride API. All authority (prices,
// payments, permissions) stays on the backend.
class GroupService {
  GroupService._();
  static final GroupService instance = GroupService._();

  static String friendly(DioException e, {String fallback = 'Something went wrong. Please try again.'}) {
    final data = e.response?.data;
    if (data is Map && data['error'] is String) return data['error'] as String;
    if (e.response?.statusCode == 401) return 'Your session expired. Please sign in again.';
    if (e.response?.statusCode == 403) return 'You do not have permission to do that.';
    if (e.response?.statusCode == 404) return 'This group is no longer available.';
    return fallback;
  }

  static String code(DioException e) {
    final data = e.response?.data;
    return data is Map ? (data['code'] ?? '').toString() : '';
  }

  Future<List<GroupSummary>> listGroups() async {
    final res = await ApiService.dio.get('/groups');
    final list = res.data is Map ? res.data['groups'] as List? : null;
    return (list ?? [])
        .whereType<Map>()
        .map((e) => GroupSummary.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<GroupDetail> getGroup(String groupId) async {
    final res = await ApiService.dio.get('/groups/$groupId');
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<GroupDetail> createGroup({
    required String name,
    List<String> memberIds = const [],
  }) async {
    final res = await ApiService.dio.post('/groups', data: {
      'name': name,
      'memberIds': memberIds,
    });
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<GroupDetail> rename(String groupId, String name) async {
    final res = await ApiService.dio.patch('/groups/$groupId', data: {'name': name});
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<GroupDetail> removeMember(String groupId, String userId) async {
    final res = await ApiService.dio.delete('/groups/$groupId/members/$userId');
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<void> leaveGroup(String groupId) async {
    await ApiService.dio.post('/groups/$groupId/leave');
  }

  Future<void> cancelGroup(String groupId) async {
    await ApiService.dio.post('/groups/$groupId/cancel');
  }

  Future<GroupDetail> setPickup(
    String groupId, {
    double? lat,
    double? lng,
    String? address,
    String? placeId,
    bool sameAsHost = false,
  }) async {
    final res = await ApiService.dio.post('/groups/$groupId/pickup', data: {
      if (sameAsHost) 'sameAsHost': true,
      if (!sameAsHost && lat != null) 'lat': lat,
      if (!sameAsHost && lng != null) 'lng': lng,
      if (!sameAsHost && address != null) 'address': address,
      if (!sameAsHost && placeId != null) 'placeId': placeId,
    });
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<GroupDetail> setDestination(
    String groupId, {
    required double lat,
    required double lng,
    required String address,
    String? placeId,
  }) async {
    final res = await ApiService.dio.post('/groups/$groupId/destination', data: {
      'lat': lat,
      'lng': lng,
      'address': address,
      if (placeId != null) 'placeId': placeId,
    });
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<Map<String, dynamic>> previewQuote(
    String groupId, {
    String? promoCode,
  }) async {
    final res = await ApiService.dio.post('/groups/$groupId/quote/preview', data: {
      if (promoCode != null && promoCode.trim().isNotEmpty)
        'promoCode': promoCode.trim().toUpperCase(),
    });
    return Map<String, dynamic>.from(res.data);
  }

  Future<GroupDetail> createQuote(
    String groupId, {
    required String splitMethod,
    String? promoCode,
    String vehicleCategory = 'CORE',
    Map<String, int>? customShares,
  }) async {
    final res = await ApiService.dio.post('/groups/$groupId/quote', data: {
      'splitMethod': splitMethod,
      'vehicleCategory': vehicleCategory,
      if (promoCode != null && promoCode.trim().isNotEmpty)
        'promoCode': promoCode.trim().toUpperCase(),
      if (customShares != null) 'customShares': customShares,
    });
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<GroupDetail> confirmPayment(String groupId, {bool useCredits = false}) async {
    final res = await ApiService.dio.post('/groups/$groupId/payments/confirm', data: {
      'useCredits': useCredits,
    });
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<Map<String, dynamic>> requestRide(String groupId) async {
    final res = await ApiService.dio.post('/groups/$groupId/request');
    return Map<String, dynamic>.from(res.data);
  }

  Future<List<GroupMessage>> messages(String groupId, {String? before}) async {
    final res = await ApiService.dio.get('/groups/$groupId/messages', queryParameters: {
      if (before != null) 'before': before,
      'limit': 50,
    });
    final list = res.data is Map ? res.data['messages'] as List? : null;
    return (list ?? [])
        .whereType<Map>()
        .map((e) => GroupMessage.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<void> markRead(String groupId) async {
    await ApiService.dio.post('/groups/$groupId/read');
  }

  Future<GroupMessage> sendMessage(String groupId, String message) async {
    final res = await ApiService.dio.post('/groups/$groupId/messages', data: {'message': message});
    return GroupMessage.fromJson(Map<String, dynamic>.from(res.data['message']));
  }

  Future<Map<String, dynamic>> inviteFriend(String groupId, String userId) async {
    final res = await ApiService.dio.post('/groups/$groupId/invitations', data: {'userId': userId});
    return Map<String, dynamic>.from(res.data['invitation']);
  }

  Future<Map<String, dynamic>> inviteContact(
    String groupId, {
    required String phone,
    String? name,
    String? message,
  }) async {
    final res = await ApiService.dio.post('/groups/$groupId/invitations/contact', data: {
      'phone': phone,
      if (name != null) 'name': name,
      if (message != null) 'message': message,
    });
    return Map<String, dynamic>.from(res.data);
  }

  Future<void> cancelInvitation(String groupId, String invitationId) async {
    await ApiService.dio.delete('/groups/$groupId/invitations/$invitationId');
  }

  Future<List<Map<String, dynamic>>> incomingInvitations() async {
    final res = await ApiService.dio.get('/groups/invitations/incoming');
    final list = res.data is Map ? res.data['invitations'] as List? : null;
    return (list ?? []).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
  }

  Future<GroupDetail> acceptInvitation(String invitationId) async {
    final res = await ApiService.dio.post('/groups/invitations/$invitationId/accept');
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<void> declineInvitation(String invitationId) async {
    await ApiService.dio.post('/groups/invitations/$invitationId/decline');
  }

  Future<Map<String, dynamic>> invitationPreview(String token) async {
    final res = await ApiService.dio.get('/groups/invitations/token/$token');
    return Map<String, dynamic>.from(res.data);
  }

  Future<GroupDetail> joinByToken(String token) async {
    final res = await ApiService.dio.post('/groups/invitations/token/$token/accept');
    return GroupDetail.fromJson(Map<String, dynamic>.from(res.data['group']));
  }

  Future<Map<String, dynamic>> friends() async {
    final res = await ApiService.dio.get('/groups/friends');
    return Map<String, dynamic>.from(res.data);
  }

  Future<List<ContactMatch>> matchContacts(List<Map<String, String>> contacts) async {
    final res = await ApiService.dio.post('/groups/friends/match', data: {'contacts': contacts});
    final matches = res.data is Map ? res.data['matches'] as List? : null;
    return (matches ?? [])
        .whereType<Map>()
        .map((e) => ContactMatch.fromJson(Map<String, dynamic>.from(e)))
        .toList();
  }

  Future<Map<String, dynamic>> requestFriend({String? userId, String? phone}) async {
    final res = await ApiService.dio.post('/groups/friends/requests', data: {
      if (userId != null) 'userId': userId,
      if (phone != null) 'phone': phone,
    });
    return Map<String, dynamic>.from(res.data);
  }

  Future<void> respondFriend(String friendshipId, bool accept) async {
    await ApiService.dio.post('/groups/friends/requests/$friendshipId/respond', data: {
      'accept': accept,
    });
  }

  Future<void> removeFriend(String userId) async {
    await ApiService.dio.delete('/groups/friends/$userId');
  }
}
