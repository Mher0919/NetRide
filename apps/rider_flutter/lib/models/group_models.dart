// Group ride models. Everything is parsed defensively: the backend is the
// source of truth and older payloads may omit optional fields.

class GroupSummary {
  final String id;
  final String name;
  final String status;
  final String hostId;
  final String hostName;
  final int participantCount;
  final String? lastMessage;
  final DateTime? lastMessageAt;
  final String? lastMessageSenderName;
  final int unreadCount;
  final String? rideStatus;
  final String? rideId;
  final List<GroupParticipant> members;

  GroupSummary({
    required this.id,
    required this.name,
    required this.status,
    required this.hostId,
    required this.hostName,
    this.participantCount = 0,
    this.lastMessage,
    this.lastMessageAt,
    this.lastMessageSenderName,
    this.unreadCount = 0,
    this.rideStatus,
    this.rideId,
    this.members = const [],
  });

  factory GroupSummary.fromJson(Map<String, dynamic> json) {
    final last = json['lastMessage'];
    return GroupSummary(
      id: json['id'].toString(),
      name: (json['name'] ?? 'Group').toString(),
      status: (json['status'] ?? 'COLLECTING_MEMBERS').toString(),
      hostId: (json['hostId'] ?? '').toString(),
      hostName: (json['hostName'] ?? 'Host').toString(),
      participantCount: (json['participantCount'] as num?)?.toInt() ?? 0,
      lastMessage: last is Map ? last['content']?.toString() : null,
      lastMessageAt: last is Map
          ? DateTime.tryParse((last['createdAt'] ?? '').toString())
          : null,
      lastMessageSenderName:
          last is Map ? last['senderName']?.toString() : null,
      unreadCount: (json['unreadCount'] as num?)?.toInt() ?? 0,
      rideStatus: json['rideStatus']?.toString(),
      rideId: json['rideId']?.toString(),
      members: (json['members'] as List? ?? [])
          .whereType<Map>()
          .map((e) => GroupParticipant.fromJson(Map<String, dynamic>.from(e)))
          .toList(),
    );
  }

  bool get hasActiveRide => rideStatus != null &&
      !['COMPLETED', 'CANCELLED'].contains(rideStatus);
}

class GroupPickup {
  final double lat;
  final double lng;
  final String? address;
  const GroupPickup({required this.lat, required this.lng, this.address});

  factory GroupPickup.fromJson(Map<String, dynamic> json) => GroupPickup(
        lat: (json['lat'] as num).toDouble(),
        lng: (json['lng'] as num).toDouble(),
        address: json['address']?.toString(),
      );
}

class GroupParticipant {
  final String userId;
  final String fullName;
  final String? profileImageUrl;
  final String role;
  final String status;
  final GroupPickup? pickup;
  final String? pickupSource;
  final String paymentStatus;
  final bool isMe;

  GroupParticipant({
    required this.userId,
    required this.fullName,
    this.profileImageUrl,
    required this.role,
    required this.status,
    this.pickup,
    this.pickupSource,
    required this.paymentStatus,
    required this.isMe,
  });

  bool get isHost => role == 'HOST';
  bool get hasPickup => pickup != null;
  bool get isActive => const [
        'JOINED',
        'PICKUP_PENDING',
        'PICKUP_CONFIRMED',
        'PICKED_UP',
        'COMPLETED',
      ].contains(status);
  bool get isPickedUp => status == 'PICKED_UP' || status == 'COMPLETED';

  factory GroupParticipant.fromJson(Map<String, dynamic> json) => GroupParticipant(
        userId: json['userId'].toString(),
        fullName: (json['fullName'] ?? 'Member').toString(),
        profileImageUrl: json['profileImageUrl']?.toString(),
        role: (json['role'] ?? 'MEMBER').toString(),
        status: (json['status'] ?? 'JOINED').toString(),
        pickup: json['pickup'] is Map
            ? GroupPickup.fromJson(Map<String, dynamic>.from(json['pickup']))
            : null,
        pickupSource: json['pickupSource']?.toString(),
        paymentStatus: (json['paymentStatus'] ?? 'NOT_REQUIRED').toString(),
        isMe: json['isMe'] == true,
      );
}

class GroupShare {
  final String userId;
  final String fullName;
  final int amountCents;
  final int distanceMeters;
  final double weight;
  final bool required;

  GroupShare({
    required this.userId,
    required this.fullName,
    required this.amountCents,
    required this.distanceMeters,
    required this.weight,
    required this.required,
  });

  factory GroupShare.fromJson(Map<String, dynamic> json) => GroupShare(
        userId: json['userId'].toString(),
        fullName: (json['fullName'] ?? 'Member').toString(),
        amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
        distanceMeters: (json['distanceMeters'] as num?)?.toInt() ?? 0,
        weight: (json['weight'] as num?)?.toDouble() ?? 0,
        required: json['required'] == true,
      );
}

class GroupQuote {
  final String id;
  final int version;
  final String status;
  final String splitMethod;
  final String vehicleCategory;
  final int originalFareCents;
  final int promoDiscountCents;
  final int discountedTotalCents;
  final String? promoCode;
  final DateTime? expiresAt;
  final List<GroupShare> shares;

  GroupQuote({
    required this.id,
    required this.version,
    required this.status,
    required this.splitMethod,
    required this.vehicleCategory,
    required this.originalFareCents,
    required this.promoDiscountCents,
    required this.discountedTotalCents,
    this.promoCode,
    this.expiresAt,
    required this.shares,
  });

  factory GroupQuote.fromJson(Map<String, dynamic> json) => GroupQuote(
        id: json['id'].toString(),
        version: (json['version'] as num?)?.toInt() ?? 0,
        status: (json['status'] ?? '').toString(),
        splitMethod: (json['splitMethod'] ?? 'HOST_PAYS').toString(),
        vehicleCategory: (json['vehicleCategory'] ?? 'CORE').toString(),
        originalFareCents: (json['originalFareCents'] as num?)?.toInt() ?? 0,
        promoDiscountCents: (json['promoDiscountCents'] as num?)?.toInt() ?? 0,
        discountedTotalCents:
            (json['discountedTotalCents'] as num?)?.toInt() ?? 0,
        promoCode: json['promoCode']?.toString(),
        expiresAt: json['expiresAt'] != null
            ? DateTime.tryParse(json['expiresAt'].toString())
            : null,
        shares: (json['shares'] as List? ?? [])
            .whereType<Map>()
            .map((e) => GroupShare.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
      );

  GroupShare? shareFor(String userId) {
    for (final s in shares) {
      if (s.userId == userId) return s;
    }
    return null;
  }
}

class GroupPayment {
  final String id;
  final String participantId;
  final int amountCents;
  final bool required;
  final String status;
  final String method;
  final int creditCents;
  final int cardCents;
  final String? failureReason;

  GroupPayment({
    required this.id,
    required this.participantId,
    required this.amountCents,
    required this.status,
    required this.method,
    this.required = false,
    this.creditCents = 0,
    this.cardCents = 0,
    this.failureReason,
  });

  factory GroupPayment.fromJson(Map<String, dynamic> json) => GroupPayment(
        id: json['id'].toString(),
        participantId: json['participantId'].toString(),
        amountCents: (json['amountCents'] as num?)?.toInt() ?? 0,
        required: json['required'] == true ||
            ((json['amountCents'] as num?)?.toInt() ?? 0) > 0,
        status: (json['status'] ?? 'PENDING').toString(),
        method: (json['method'] ?? 'CARD').toString(),
        creditCents: (json['creditCents'] as num?)?.toInt() ?? 0,
        cardCents: (json['cardCents'] as num?)?.toInt() ?? 0,
        failureReason: json['failureReason']?.toString(),
      );

  bool get isPaid => status == 'SUCCEEDED' || status == 'NOT_REQUIRED';
}

class GroupRouteStop {
  final int sequence;
  final double lat;
  final double lng;
  final String address;
  final List<String> passengerIds;
  final List<Map<String, dynamic>> passengers;
  final bool completed;

  GroupRouteStop({
    required this.sequence,
    required this.lat,
    required this.lng,
    required this.address,
    required this.passengerIds,
    required this.passengers,
    this.completed = false,
  });

  factory GroupRouteStop.fromJson(Map<String, dynamic> json) => GroupRouteStop(
        sequence: (json['sequence'] as num?)?.toInt() ?? 1,
        lat: (json['lat'] as num).toDouble(),
        lng: (json['lng'] as num).toDouble(),
        address: (json['address'] ?? '').toString(),
        passengerIds: (json['passengerIds'] as List? ?? [])
            .map((e) => e.toString())
            .toList(),
        passengers: (json['passengers'] as List? ?? [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(),
        completed: json['completed'] == true,
      );
}

class GroupRoutePlan {
  final String id;
  final int version;
  final List<GroupRouteStop> stops;
  final Map<String, dynamic>? geometry;
  final int totalDistanceMeters;
  final int totalDurationSeconds;
  final GroupPickup? driverStart;

  GroupRoutePlan({
    required this.id,
    required this.version,
    required this.stops,
    this.geometry,
    this.totalDistanceMeters = 0,
    this.totalDurationSeconds = 0,
    this.driverStart,
  });

  factory GroupRoutePlan.fromJson(Map<String, dynamic> json) => GroupRoutePlan(
        id: json['id'].toString(),
        version: (json['version'] as num?)?.toInt() ?? 0,
        stops: (json['stops'] as List? ?? [])
            .whereType<Map>()
            .map((e) => GroupRouteStop.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        geometry: json['geometry'] is Map
            ? Map<String, dynamic>.from(json['geometry'])
            : null,
        totalDistanceMeters:
            (json['totalDistanceMeters'] as num?)?.toInt() ?? 0,
        totalDurationSeconds:
            (json['totalDurationSeconds'] as num?)?.toInt() ?? 0,
        driverStart: json['driverStart'] is Map
            ? GroupPickup.fromJson(Map<String, dynamic>.from(json['driverStart']))
            : null,
      );
}

class GroupRideInfo {
  final String id;
  final String status;
  final String? driverId;
  final String? driverName;
  final String? driverPhotoUrl;
  final double? driverRating;
  final GroupPickup? driverLocation;
  final GroupRoutePlan? routePlan;
  final GroupPickup? destination;
  final int? distanceMeters;
  final int? durationSeconds;
  final DateTime? completedAt;

  GroupRideInfo({
    required this.id,
    required this.status,
    this.driverId,
    this.driverName,
    this.driverPhotoUrl,
    this.driverRating,
    this.driverLocation,
    this.routePlan,
    this.destination,
    this.distanceMeters,
    this.durationSeconds,
    this.completedAt,
  });

  factory GroupRideInfo.fromJson(Map<String, dynamic> json) {
    final loc = json['driverLocation'];
    return GroupRideInfo(
      id: json['id'].toString(),
      status: (json['status'] ?? '').toString(),
      driverId: json['driverId']?.toString(),
      driverName: json['driverName']?.toString(),
      driverPhotoUrl: json['driverPhotoUrl']?.toString(),
      driverRating: (json['driverRating'] as num?)?.toDouble(),
      driverLocation: loc is Map && loc['lat'] != null
          ? GroupPickup.fromJson(Map<String, dynamic>.from(loc))
          : null,
      routePlan: json['routePlan'] is Map
          ? GroupRoutePlan.fromJson(
              Map<String, dynamic>.from(json['routePlan']))
          : null,
      destination: json['destination'] is Map
          ? GroupPickup.fromJson(Map<String, dynamic>.from(json['destination']))
          : null,
      distanceMeters: (json['distanceMeters'] as num?)?.toInt(),
      durationSeconds: (json['durationSeconds'] as num?)?.toInt(),
      completedAt: json['completedAt'] != null
          ? DateTime.tryParse(json['completedAt'].toString())
          : null,
    );
  }

  bool get isActive => !['COMPLETED', 'CANCELLED'].contains(status);
  bool get canReview => status == 'COMPLETED';
}

class GroupDetail {
  final String id;
  final String name;
  final String status;
  final String hostId;
  final String hostName;
  final bool isHost;
  final GroupPickup? destination;
  final String splitMethod;
  final List<GroupParticipant> participants;
  final List<Map<String, dynamic>> pendingInvitations;
  final Map<String, dynamic>? lastMessage;
  final GroupQuote? quote;
  final GroupRoutePlan? routePlan;
  final List<GroupPayment> payments;
  final Map<String, dynamic>? myShare;
  final GroupRideInfo? ride;
  final bool canRequest;
  final bool canConfigure;
  final DateTime? createdAt;

  GroupDetail({
    required this.id,
    required this.name,
    required this.status,
    required this.hostId,
    required this.hostName,
    required this.isHost,
    this.destination,
    required this.splitMethod,
    required this.participants,
    required this.pendingInvitations,
    this.lastMessage,
    this.quote,
    this.routePlan,
    required this.payments,
    this.myShare,
    this.ride,
    required this.canRequest,
    required this.canConfigure,
    this.createdAt,
  });

  factory GroupDetail.fromJson(Map<String, dynamic> json) => GroupDetail(
        id: json['id'].toString(),
        name: (json['name'] ?? 'Group').toString(),
        status: (json['status'] ?? '').toString(),
        hostId: (json['hostId'] ?? '').toString(),
        hostName: (json['hostName'] ?? 'Host').toString(),
        isHost: json['isHost'] == true,
        destination: json['destination'] is Map
            ? GroupPickup.fromJson(Map<String, dynamic>.from(json['destination']))
            : null,
        splitMethod: (json['splitMethod'] ?? 'HOST_PAYS').toString(),
        participants: (json['participants'] as List? ?? [])
            .whereType<Map>()
            .map((e) => GroupParticipant.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        pendingInvitations: (json['pendingInvitations'] as List? ?? [])
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(),
        lastMessage: json['lastMessage'] is Map
            ? Map<String, dynamic>.from(json['lastMessage'])
            : null,
        quote: json['quote'] is Map
            ? GroupQuote.fromJson(Map<String, dynamic>.from(json['quote']))
            : null,
        routePlan: json['routePlan'] is Map
            ? GroupRoutePlan.fromJson(Map<String, dynamic>.from(json['routePlan']))
            : null,
        payments: (json['payments'] as List? ?? [])
            .whereType<Map>()
            .map((e) => GroupPayment.fromJson(Map<String, dynamic>.from(e)))
            .toList(),
        myShare: json['myShare'] is Map
            ? Map<String, dynamic>.from(json['myShare'])
            : null,
        ride: json['ride'] is Map
            ? GroupRideInfo.fromJson(Map<String, dynamic>.from(json['ride']))
            : null,
        canRequest: json['canRequest'] == true,
        canConfigure: json['canConfigure'] == true,
        createdAt: json['createdAt'] != null
            ? DateTime.tryParse(json['createdAt'].toString())
            : null,
      );

  GroupParticipant? get me {
    for (final p in participants) {
      if (p.isMe) return p;
    }
    return null;
  }

  GroupParticipant? get host {
    for (final p in participants) {
      if (p.isHost) return p;
    }
    return null;
  }

  bool get hasDestination => destination != null;
  bool get allPickupsSet =>
      participants.isNotEmpty && participants.every((p) => p.hasPickup);
  bool get hasActiveRide => ride != null && ride!.isActive;

  GroupPayment? get myPayment {
    if (me == null) return null;
    for (final p in payments) {
      if (p.participantId == me!.userId) return p;
    }
    return null;
  }

  int get myAmountCents =>
      (myShare?['amountCents'] as num?)?.toInt() ?? 0;

  int get paidCount =>
      payments.where((p) => p.required && p.isPaid).length;
  int get requiredCount => payments.where((p) => p.required).length;
}

class GroupMessage {
  final String id;
  final String? senderId;
  final String? senderName;
  final String? senderPhotoUrl;
  final String type;
  final String content;
  final DateTime createdAt;

  GroupMessage({
    required this.id,
    this.senderId,
    this.senderName,
    this.senderPhotoUrl,
    required this.type,
    required this.content,
    required this.createdAt,
  });

  factory GroupMessage.fromJson(Map<String, dynamic> json) => GroupMessage(
        id: json['id'].toString(),
        senderId: json['sender_id']?.toString() ?? json['senderId']?.toString(),
        senderName:
            json['sender_name']?.toString() ?? json['senderName']?.toString(),
        senderPhotoUrl: json['sender_photo_url']?.toString(),
        type: (json['message_type'] ?? json['type'] ?? 'TEXT').toString(),
        content: (json['content'] ?? '').toString(),
        createdAt: DateTime.tryParse(
                (json['created_at'] ?? json['createdAt'] ?? '').toString()) ??
            DateTime.now(),
      );

  bool get isSystem => type != 'TEXT';
}

class NetRideFriend {
  final String userId;
  final String fullName;
  final String? profileImageUrl;
  final String? phone;
  final String? friendshipId;

  NetRideFriend({
    required this.userId,
    required this.fullName,
    this.profileImageUrl,
    this.phone,
    this.friendshipId,
  });

  factory NetRideFriend.fromJson(Map<String, dynamic> json) => NetRideFriend(
        userId: json['userId'].toString(),
        fullName: (json['fullName'] ?? 'Friend').toString(),
        profileImageUrl: json['profileImageUrl']?.toString(),
        phone: json['phone']?.toString(),
        friendshipId: json['friendshipId']?.toString(),
      );
}

class ContactMatch {
  final String userId;
  final String fullName;
  final String? profileImageUrl;
  final String phone;
  final String matchedPhone;

  ContactMatch({
    required this.userId,
    required this.fullName,
    this.profileImageUrl,
    required this.phone,
    required this.matchedPhone,
  });

  factory ContactMatch.fromJson(Map<String, dynamic> json) => ContactMatch(
        userId: json['userId'].toString(),
        fullName: (json['fullName'] ?? 'Contact').toString(),
        profileImageUrl: json['profileImageUrl']?.toString(),
        phone: (json['phone'] ?? '').toString(),
        matchedPhone: (json['matchedPhone'] ?? '').toString(),
      );
}
