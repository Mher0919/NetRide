import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../components/chat_bubble.dart';
import '../models/group_models.dart';
import '../models/search_result.dart';
import '../models/trip_models.dart' as models;
import '../providers/group_provider.dart';
import '../services/contact_invite_service.dart';
import '../services/group_service.dart';
import '../services/secure_token_store.dart';
import '../theme/app_theme.dart';
import '../widgets/group_avatars.dart';
import 'address_search_delegate.dart';
import 'group_ride_screen.dart';
import 'rating_screen.dart';

class GroupChatScreen extends StatefulWidget {
  const GroupChatScreen({super.key});

  @override
  State<GroupChatScreen> createState() => _GroupChatScreenState();
}

class _GroupChatScreenState extends State<GroupChatScreen> {
  final TextEditingController _composer = TextEditingController();
  final ScrollController _scroll = ScrollController();
  bool _sending = false;
  String? _lastRenderedMessageId;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scroll.hasClients) return;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 280),
      curve: Curves.easeOut,
    );
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await context.read<GroupProvider>().sendMessage(text);
      _composer.clear();
      await Future<void>.delayed(const Duration(milliseconds: 100));
      _scrollToBottom();
    } on DioException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(GroupService.friendly(e, fallback: 'Message not sent.'))),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Message not sent. Tap send to retry.')),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<SearchResult?> _pickAddress(String label) {
    return showSearch<SearchResult?>(
      context: context,
      delegate: AddressSearchDelegate(searchFieldLabel: label),
    );
  }

  Future<void> _choosePickup(GroupDetail group) async {
    final provider = context.read<GroupProvider>();
    final host = group.host;
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 10),
            ListTile(
              leading: const Icon(Icons.home_outlined, color: AppTheme.primaryBrandGreen),
              title: Text(
                host != null && host.pickup != null
                    ? 'Same pickup as ${host.fullName.split(' ').first}'
                    : 'Same pickup as host',
              ),
              subtitle: host?.pickup?.address != null
                  ? Text(host!.pickup!.address!)
                  : const Text('The host has not chosen a pickup yet'),
              enabled: host?.pickup != null,
              onTap: host?.pickup != null
                  ? () => Navigator.pop(ctx, 'host')
                  : null,
            ),
            ListTile(
              leading: const Icon(Icons.place_outlined, color: AppTheme.primaryBrandGreen),
              title: const Text('Choose a different pickup'),
              subtitle: const Text('Search for an address'),
              onTap: () => Navigator.pop(ctx, 'different'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (choice == null || !mounted) return;
    try {
      if (choice == 'host') {
        await provider.setPickup(sameAsHost: true);
      } else {
        final result = await _pickAddress('Pickup location');
        if (result == null || !mounted) return;
        await provider.setPickup(
          lat: result.lat,
          lng: result.lon,
          address: result.formattedAddress ?? result.displayName,
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_friendlyError(e))),
      );
    }
  }

  String _friendlyError(Object e) {
    if (e is DioException) return GroupService.friendly(e);
    final text = e.toString();
    if (text.startsWith('Exception: ')) return text.substring(11);
    return 'Please try again.';
  }

  Future<void> _openSettings(GroupDetail group) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => _GroupSettingsSheet(
        group: group,
        onPickup: () {
          Navigator.pop(ctx);
          _choosePickup(group);
        },
        onConfigure: () {
          Navigator.pop(ctx);
          _openRideConfig();
        },
      ),
    );
  }

  Future<void> _openRideConfig() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const GroupRideScreen()),
    );
    if (!mounted) return;
    await context.read<GroupProvider>().refreshCurrent(silent: true);
  }

  Future<void> _reviewDriver(GroupDetail group) async {
    final ride = group.ride;
    if (ride == null || ride.driverId == null) return;
    final trip = models.Trip(
      id: ride.id,
      riderId: SecureTokenStore.userId ?? '',
      driverId: ride.driverId,
      status: models.TripStatus.COMPLETED,
      pickup: models.Location(
        lat: ride.routePlan?.stops.isNotEmpty == true
            ? ride.routePlan!.stops.first.lat
            : (group.destination?.lat ?? 0),
        lng: ride.routePlan?.stops.isNotEmpty == true
            ? ride.routePlan!.stops.first.lng
            : (group.destination?.lng ?? 0),
      ),
      destination: models.Location(
        lat: ride.destination?.lat ?? group.destination?.lat ?? 0,
        lng: ride.destination?.lng ?? group.destination?.lng ?? 0,
        address: ride.destination?.address ?? group.destination?.address,
      ),
      fareAmount: null,
      driverInfo: models.DriverInfo(
        id: ride.driverId!,
        name: ride.driverName ?? 'Your driver',
        photoUrl: ride.driverPhotoUrl,
        rating: ride.driverRating ?? 5.0,
      ),
    );
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => RatingScreen(
          trip: trip,
          onFinished: () {
            if (mounted) {
              context.read<GroupProvider>().refreshCurrent(silent: true);
            }
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<GroupProvider>();
    final group = provider.current;
    if (group == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen)),
      );
    }
    final myId = SecureTokenStore.userId;
    final lastMessageId =
        provider.messages.isEmpty ? null : provider.messages.last.id;
    if (lastMessageId != null && lastMessageId != _lastRenderedMessageId) {
      _lastRenderedMessageId = lastMessageId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _scrollToBottom();
      });
    }
    final statusLabel = _statusLabel(group);
    final canSetPickup = group.canConfigure &&
        !group.hasActiveRide &&
        group.me?.pickup == null;

    return Scaffold(
      backgroundColor: const Color(0xFFF3F0EB),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        elevation: 0.5,
        titleSpacing: 8,
        title: Row(
          children: [
            GroupAvatarStack(participants: group.participants, size: 36, max: 3),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    group.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -0.2,
                    ),
                  ),
                  Text(
                    '${group.participants.length} participants · $statusLabel',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Group settings',
            onPressed: () => _openSettings(group),
            icon: const Icon(Icons.tune_rounded),
          ),
        ],
      ),
      body: Column(
        children: [
          _RideSummaryCard(
            group: group,
            statusLabel: statusLabel,
            onOpen: _openRideConfig,
            onPickup: () => _choosePickup(group),
            onReview: () => _reviewDriver(group),
            canSetPickup: canSetPickup,
          ),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              itemCount: provider.messages.length,
              itemBuilder: (context, index) {
                final message = provider.messages[index];
                if (message.isSystem) {
                  return _SystemMessage(message: message);
                }
                final mine = message.senderId == myId;
                return Column(
                  crossAxisAlignment:
                      mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                  children: [
                    if (!mine && message.senderName != null)
                      Padding(
                        padding: const EdgeInsets.only(left: 10, bottom: 2),
                        child: Text(
                          message.senderName!,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                          ),
                        ),
                      ),
                    ChatBubble(
                      text: message.content,
                      isMine: mine,
                      timestamp: message.createdAt,
                    ),
                  ],
                );
              },
            ),
          ),
          _composerBar(),
        ],
      ),
    );
  }

  Widget _composerBar() {
    return Container(
      color: Colors.white,
      padding: EdgeInsets.fromLTRB(
        12,
        10,
        12,
        10 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Expanded(
              child: TextField(
                controller: _composer,
                minLines: 1,
                maxLines: 4,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  hintText: 'Message the group',
                  isDense: true,
                  contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
                onSubmitted: (_) => _send(),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              onPressed: _sending ? null : _send,
              style: IconButton.styleFrom(
                backgroundColor: AppTheme.primaryBrandGreen,
                foregroundColor: Colors.white,
                minimumSize: const Size(46, 46),
              ),
              icon: _sending
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                    )
                  : const Icon(Icons.send_rounded, size: 20),
            ),
          ],
        ),
      ),
    );
  }

  String _statusLabel(GroupDetail group) {
    if (group.ride != null) {
      switch (group.ride!.status) {
        case 'REQUESTED':
        case 'DRIVER_MATCHING':
          return 'Finding a driver';
        case 'ACCEPTED':
        case 'DRIVER_ARRIVING':
          return 'Driver on the way';
        case 'IN_PROGRESS':
          return 'On the trip';
        case 'COMPLETED':
          return 'Completed';
        case 'CANCELLED':
          return 'Cancelled';
      }
    }
    switch (group.status) {
      case 'COLLECTING_MEMBERS':
        return 'Collecting members';
      case 'CONFIGURING':
        return 'Configuring';
      case 'AWAITING_PAYMENT':
        return 'Awaiting payments';
      case 'READY_TO_REQUEST':
        return 'Ready to request';
      case 'DRIVER_MATCHING':
        return 'Finding a driver';
      case 'DRIVER_ASSIGNED':
        return 'Driver assigned';
      case 'IN_PROGRESS':
        return 'On the trip';
      case 'CANCELLED':
        return 'Cancelled';
      case 'COMPLETED':
        return 'Completed';
      default:
        return 'Group';
    }
  }
}

class _SystemMessage extends StatelessWidget {
  const _SystemMessage({required this.message});
  final GroupMessage message;

  @override
  Widget build(BuildContext context) {
    final isRide = message.type == 'RIDE';
    final isPayment = message.type == 'PAYMENT';
    final color = isRide
        ? const Color(0xFF4D6B52)
        : isPayment
            ? const Color(0xFF8A6A2F)
            : const Color(0xFF6B746D);
    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 7),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: Colors.white.withValues(alpha: 0.75),
          borderRadius: BorderRadius.circular(999),
        ),
        child: Text(
          message.content,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w600,
            color: color,
          ),
        ),
      ),
    );
  }
}

class _RideSummaryCard extends StatelessWidget {
  const _RideSummaryCard({
    required this.group,
    required this.statusLabel,
    required this.onOpen,
    required this.onPickup,
    required this.onReview,
    required this.canSetPickup,
  });

  final GroupDetail group;
  final String statusLabel;
  final VoidCallback onOpen;
  final VoidCallback onPickup;
  final VoidCallback onReview;
  final bool canSetPickup;

  @override
  Widget build(BuildContext context) {
    final quote = group.quote;
    final ride = group.ride;
    final total = quote?.discountedTotalCents ?? 0;
    final paid = group.paidCount;
    final required = group.requiredCount;
    final me = group.me;
    final myPayment = group.myPayment;
    final destination = group.destination?.address;

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.03),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: AppTheme.primaryBrandGreen.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  statusLabel.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                    color: AppTheme.primaryBrandGreen,
                  ),
                ),
              ),
              const Spacer(),
              if (total > 0)
                Text(
                  '\$${(total / 100).toStringAsFixed(2)} total',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.flag_outlined, size: 16, color: AppTheme.primaryBrandGreen),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  destination ?? 'The host has not selected a destination yet',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    height: 1.35,
                    fontWeight: FontWeight.w600,
                    color: destination == null
                        ? AppTheme.secondaryDarkText.withValues(alpha: 0.5)
                        : AppTheme.secondaryDarkText,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Icon(
                me?.pickup == null ? Icons.location_off_outlined : Icons.my_location_rounded,
                size: 15,
                color: me?.pickup == null ? AppTheme.warningColor : AppTheme.successGreen,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  me?.pickup?.address ??
                      (me?.pickupSource == 'HOST'
                          ? 'Same pickup as host'
                          : 'Choose your pickup location'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: AppTheme.secondaryDarkText.withValues(alpha: 0.7),
                  ),
                ),
              ),
              if (canSetPickup)
                TextButton(
                  onPressed: onPickup,
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: Size.zero,
                  ),
                  child: const Text('Choose', style: TextStyle(fontSize: 12)),
                ),
            ],
          ),
          if (required > 0) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                const Icon(Icons.payments_outlined, size: 15, color: AppTheme.primaryBrandGreen),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    myPayment?.isPaid == true
                        ? 'Your share is confirmed'
                        : 'Your share: \$${((group.myAmountCents) / 100).toStringAsFixed(2)}',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                  ),
                ),
                Text(
                  '$paid/$required paid',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onOpen,
                  icon: Icon(
                    group.isHost ? Icons.tune_rounded : Icons.visibility_outlined,
                    size: 17,
                  ),
                  label: Text(group.isHost ? 'Configure ride' : 'View ride'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
              if (ride?.canReview == true && ride?.driverId != null) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: onReview,
                    icon: const Icon(Icons.star_outline_rounded, size: 17),
                    label: const Text('Rate driver'),
                    style: ElevatedButton.styleFrom(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _GroupSettingsSheet extends StatelessWidget {
  const _GroupSettingsSheet({
    required this.group,
    required this.onPickup,
    required this.onConfigure,
  });

  final GroupDetail group;
  final VoidCallback onPickup;
  final VoidCallback onConfigure;

  Future<void> _rename(BuildContext context) async {
    final controller = TextEditingController(text: group.name);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rename group'),
        content: TextField(
          controller: controller,
          maxLength: 80,
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    try {
      await context.read<GroupProvider>().rename(name);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_friendly(e))),
      );
    }
  }

  Future<void> _inviteFriend(BuildContext context) async {
    final provider = context.read<GroupProvider>();
    final participantIds = group.participants.map((p) => p.userId).toSet();
    final available = provider.friends
        .where((f) => !participantIds.contains(f.userId))
        .toList();
    if (available.isEmpty) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('All of your friends are already in this group.')),
      );
      return;
    }
    final friend = await showModalBottomSheet<NetRideFriend>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
          children: [
            const Text(
              'Invite a friend',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            ...available.map(
              (f) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: GroupAvatar(name: f.fullName, imageUrl: f.profileImageUrl),
                title: Text(f.fullName),
                subtitle: f.phone != null ? Text(f.phone!) : null,
                onTap: () => Navigator.pop(ctx, f),
              ),
            ),
          ],
        ),
      ),
    );
    if (friend == null) return;
    try {
      await provider.inviteFriend(friend.userId);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Invitation sent to ${friend.fullName}.')),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_friendly(e))),
      );
    }
  }

  Future<void> _inviteContact(BuildContext context) async {
    try {
      final contact = await ContactInviteService.pickOne();
      if (contact == null || !context.mounted) return;
      final result = await context.read<GroupProvider>().inviteContact(
            phone: contact.phone,
            name: contact.name,
          );
      final message = (result['message'] ?? '').toString();
      if (message.isNotEmpty) {
        await ContactInviteService.openSmsComposer(
          phone: contact.phone,
          message: message,
        );
      }
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Invitation ready in your SMS app.')),
      );
    } on ContactPickerException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_friendly(e))),
      );
    }
  }

  Future<void> _leave(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Leave group?'),
        content: Text(
          group.isHost
              ? 'The host role will transfer to the earliest joined member. If you are the only participant, the group is disbanded.'
              : 'You will leave this group. The host keeps the shared ride and the remaining members.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Leave', style: TextStyle(color: AppTheme.errorColor)),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await context.read<GroupProvider>().leaveGroup();
      if (context.mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  Future<void> _cancelGroup(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel group ride?'),
        content: const Text(
          'This cancels the group. Any confirmed participant payments are refunded.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep group')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Cancel group', style: TextStyle(color: AppTheme.errorColor)),
          ),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    try {
      await context.read<GroupProvider>().cancelGroup();
      if (context.mounted) Navigator.of(context).pop();
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_friendly(e))));
    }
  }

  String _friendly(Object e) {
    if (e is DioException) return GroupService.friendly(e);
    final text = e.toString();
    if (text.startsWith('Exception: ')) return text.substring(11);
    return 'Please try again.';
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<GroupProvider>();
    final current = provider.current ?? group;
    final canConfigure = current.canConfigure && !current.hasActiveRide;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.72,
      minChildSize: 0.4,
      maxChildSize: 0.94,
      builder: (context, scrollController) => ListView(
        controller: scrollController,
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 30),
        children: [
          Center(
            child: Container(
              width: 38,
              height: 5,
              decoration: BoxDecoration(
                color: Colors.grey.shade300,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: Text(
                  current.name,
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
              ),
              if (current.isHost)
                IconButton(
                  tooltip: 'Rename',
                  onPressed: () => _rename(context),
                  icon: const Icon(Icons.edit_outlined),
                ),
            ],
          ),
          Text(
            '${current.participants.length} participants · ${current.status.replaceAll('_', ' ').toLowerCase()}',
            style: TextStyle(
              fontSize: 12.5,
              color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'PARTICIPANTS',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.9,
              color: Color(0xFF7C847D),
            ),
          ),
          const SizedBox(height: 6),
          ...current.participants.map(
            (p) => ListTile(
              contentPadding: EdgeInsets.zero,
              leading: GroupAvatar(name: p.fullName, imageUrl: p.profileImageUrl),
              title: Row(
                children: [
                  Flexible(
                    child: Text(
                      p.fullName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w600),
                    ),
                  ),
                  if (p.isHost) ...[
                    const SizedBox(width: 6),
                    const _Pill(text: 'HOST', color: AppTheme.primaryBrandGreen),
                  ],
                  if (p.isMe) ...[
                    const SizedBox(width: 6),
                    const _Pill(text: 'YOU', color: Color(0xFF7C847D)),
                  ],
                ],
              ),
              subtitle: Text(
                '${p.pickup?.address ?? (p.pickupSource == 'HOST' ? 'Same pickup as host' : 'Pickup pending')}'
                ' · ${p.paymentStatus.replaceAll('_', ' ').toLowerCase()}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
              trailing: current.isHost && canConfigure && !p.isMe
                  ? IconButton(
                      tooltip: 'Remove from group',
                      onPressed: () async {
                        final confirmed = await showDialog<bool>(
                          context: context,
                          builder: (ctx) => AlertDialog(
                            title: Text('Remove ${p.fullName}?'),
                            content: const Text('They will leave this group ride.'),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(ctx, false),
                                child: const Text('Cancel'),
                              ),
                              TextButton(
                                onPressed: () => Navigator.pop(ctx, true),
                                child: const Text('Remove',
                                    style: TextStyle(color: AppTheme.errorColor)),
                              ),
                            ],
                          ),
                        );
                        if (confirmed != true) return;
                        try {
                          await context.read<GroupProvider>().removeMember(p.userId);
                        } catch (e) {
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(_friendly(e))),
                          );
                        }
                      },
                      icon: const Icon(Icons.person_remove_outlined,
                          color: AppTheme.errorColor),
                    )
                  : null,
            ),
          ),
          if (canConfigure && current.isHost) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => _inviteFriend(context),
                    icon: const Icon(Icons.group_add_outlined, size: 18),
                    label: const Text('Friend'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () => _inviteContact(context),
                    icon: const Icon(Icons.sms_outlined, size: 18),
                    label: const Text('Contact'),
                  ),
                ),
              ],
            ),
          ],
          if (current.pendingInvitations.isNotEmpty) ...[
            const SizedBox(height: 16),
            const Text(
              'PENDING INVITATIONS',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.9,
                color: Color(0xFF7C847D),
              ),
            ),
            ...current.pendingInvitations.map(
              (inv) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.mail_outline, color: AppTheme.warningColor),
                title: Text(
                  (inv['invitedName'] ?? inv['invitedPhone'] ?? 'Contact').toString(),
                ),
                subtitle: const Text('Invitation pending'),
                trailing: current.isHost
                    ? IconButton(
                        tooltip: 'Cancel invitation',
                        onPressed: () async {
                          await context
                              .read<GroupProvider>()
                              .cancelInvitation(inv['id'].toString());
                        },
                        icon: const Icon(Icons.close),
                      )
                    : null,
              ),
            ),
          ],
          const SizedBox(height: 18),
          if (canConfigure)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.my_location_rounded),
              title: const Text('Choose / change my pickup'),
              onTap: () {
                Navigator.pop(context);
                onPickup();
              },
            ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.route_outlined),
            title: Text(current.isHost ? 'Configure the shared ride' : 'View shared ride details'),
            onTap: () {
              Navigator.pop(context);
              onConfigure();
            },
          ),
          const Divider(height: 26),
          if (canConfigure)
            TextButton.icon(
              onPressed: () => _leave(context),
              icon: const Icon(Icons.logout_rounded, color: AppTheme.errorColor),
              label: Text(
                current.isHost ? 'Leave group (transfer host)' : 'Leave group',
                style: const TextStyle(color: AppTheme.errorColor),
              ),
            ),
          if (current.isHost && !['COMPLETED', 'CANCELLED'].contains(current.status))
            TextButton.icon(
              onPressed: () => _cancelGroup(context),
              icon: const Icon(Icons.cancel_outlined, color: AppTheme.errorColor),
              label: const Text('Cancel group ride',
                  style: TextStyle(color: AppTheme.errorColor)),
            ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text, required this.color});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 8.5,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.4,
          color: color,
        ),
      ),
    );
  }
}


