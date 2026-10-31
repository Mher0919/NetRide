import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/group_models.dart';
import '../providers/group_provider.dart';
import '../services/contact_invite_service.dart';
import '../services/secure_token_store.dart';
import '../theme/app_theme.dart';
import '../widgets/group_avatars.dart';
import 'group_chat_screen.dart';

class FriendsScreen extends StatefulWidget {
  const FriendsScreen({super.key});

  @override
  State<FriendsScreen> createState() => _FriendsScreenState();
}

class _FriendsScreenState extends State<FriendsScreen> {
  bool _adding = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<GroupProvider>().refreshFriends();
    });
  }

  Future<void> _addFromContacts() async {
    if (_adding) return;
    setState(() => _adding = true);
    try {
      final contact = await ContactInviteService.pickOne();
      if (contact == null || !mounted) return;
      final provider = context.read<GroupProvider>();
      final matches = await provider.matchContacts([
        {'phone': contact.phone, 'name': contact.name},
      ]);
      if (!mounted) return;
      if (matches.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '${contact.name} is not on NetRide yet. Invite them from the Groups screen with an SMS.',
            ),
          ),
        );
        return;
      }
      final match = matches.first;
      try {
        final result = await provider.requestFriend(userId: match.userId);
        if (!mounted) return;
        final status = (result['status'] ?? '').toString();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              status == 'ACCEPTED'
                  ? '${match.fullName} is now your friend.'
                  : 'Friend request sent to ${match.fullName}.',
            ),
          ),
        );
      } catch (_) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('We couldn\'t send the friend request.')),
        );
      }
    } on ContactPickerException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } finally {
      if (mounted) setState(() => _adding = false);
    }
  }

  Future<void> _invite(NetRideFriend friend) async {
    final provider = context.read<GroupProvider>();
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
            const SizedBox(height: 8),
            Container(
              width: 38,
              height: 5,
              decoration: BoxDecoration(
                color: Colors.grey.shade300,
                borderRadius: BorderRadius.circular(99),
              ),
            ),
            const SizedBox(height: 14),
            ListTile(
              leading: const Icon(Icons.group_add_outlined, color: AppTheme.primaryBrandGreen),
              title: const Text('Create a new group'),
              subtitle: Text('Start a group ride with ${friend.fullName}'),
              onTap: () => Navigator.pop(ctx, 'new'),
            ),
            ListTile(
              leading: const Icon(Icons.group_outlined, color: AppTheme.primaryBrandGreen),
              title: const Text('Invite to an existing group'),
              subtitle: const Text('Only groups you host'),
              onTap: () => Navigator.pop(ctx, 'existing'),
            ),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
    if (choice == null || !mounted) return;

    try {
      if (choice == 'new') {
        final name = await _askGroupName(friend.fullName);
        if (name == null || name.trim().isEmpty || !mounted) return;
        final detail = await provider.createGroup(name: name.trim());
        await provider.inviteFriendToGroup(detail.id, friend.userId);
        if (!mounted) return;
        await Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const GroupChatScreen()),
        );
      } else {
        final myId = SecureTokenStore.userId;
        final hosted = provider.groups
            .where((g) => g.hostId == myId && g.rideStatus == null)
            .toList();
        if (hosted.isEmpty) {
          if (!mounted) return;
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('You have no open groups you host. Create one first.'),
            ),
          );
          return;
        }
        final group = await showModalBottomSheet<GroupSummary>(
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
                  'Invite to group',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 10),
                ...hosted.map(
                  (g) => ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const CircleAvatar(
                      backgroundColor: Color(0xFFE4DED5),
                      child: Icon(Icons.groups_2_rounded, color: AppTheme.primaryBrandGreen),
                    ),
                    title: Text(g.name),
                    subtitle: Text('${g.participantCount} participants'),
                    onTap: () => Navigator.pop(ctx, g),
                  ),
                ),
              ],
            ),
          ),
        );
        if (group == null || !mounted) return;
        await provider.inviteFriendToGroup(group.id, friend.userId);
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Invitation sent to ${friend.fullName}.')),
        );
      }
    } on ContactPickerException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e) {
      if (!mounted) return;
      final message = e is Exception ? e.toString() : 'Please try again.';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            message.startsWith('Exception: ')
                ? message.substring(11)
                : 'We couldn\'t send the invitation. Please try again.',
          ),
        ),
      );
    }
  }

  Future<String?> _askGroupName(String friendName) {
    final controller = TextEditingController(text: 'Ride with $friendName');
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Name your group'),
        content: TextField(
          controller: controller,
          maxLength: 80,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Group name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Create group'),
          ),
        ],
      ),
    );
  }

  Future<void> _removeFriend(NetRideFriend friend) async {
    final provider = context.read<GroupProvider>();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove friend?'),
        content: Text('${friend.fullName} will be removed from your NetRide friends.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Remove', style: TextStyle(color: AppTheme.errorColor)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await provider.removeFriend(friend.userId);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('We couldn\'t remove that friend.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<GroupProvider>();
    return Scaffold(
      backgroundColor: AppTheme.primaryBackground,
      appBar: AppBar(
        backgroundColor: AppTheme.primaryBackground,
        elevation: 0,
        title: const Text('Friends'),
        actions: [
          IconButton(
            tooltip: 'Add from contacts',
            onPressed: _adding ? null : _addFromContacts,
            icon: _adding
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.person_add_alt_1_outlined),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: AppTheme.primaryBrandGreen,
        onRefresh: provider.refreshFriends,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            if (provider.incomingRequests.isNotEmpty) ...[
              const _SectionLabel('FRIEND REQUESTS'),
              ...provider.incomingRequests.map(
                (f) => _RequestRow(
                  friend: f,
                  onAccept: () async {
                    await provider.respondFriend(f.friendshipId!, true);
                  },
                  onDecline: () async {
                    await provider.respondFriend(f.friendshipId!, false);
                  },
                ),
              ),
              const SizedBox(height: 18),
            ],
            const _SectionLabel('NETRIDE FRIENDS'),
            if (provider.friends.isEmpty)
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(18),
                  border: Border.all(color: AppTheme.softBorderColor),
                ),
                child: Column(
                  children: [
                    const Icon(Icons.people_outline_rounded,
                        size: 40, color: AppTheme.primaryBrandGreen),
                    const SizedBox(height: 10),
                    const Text(
                      'No friends yet',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Add a friend from your contacts, or invite them to a group by SMS.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 13,
                        height: 1.4,
                        color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
                      ),
                    ),
                    const SizedBox(height: 14),
                    OutlinedButton.icon(
                      onPressed: _adding ? null : _addFromContacts,
                      icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                      label: const Text('Add from contacts'),
                    ),
                  ],
                ),
              )
            else
              ...provider.friends.map(
                (friend) => _FriendRow(
                  friend: friend,
                  onInvite: () => _invite(friend),
                  onLongPress: () => _removeFriend(friend),
                ),
              ),
            if (provider.outgoingRequests.isNotEmpty) ...[
              const SizedBox(height: 20),
              const _SectionLabel('PENDING REQUESTS'),
              ...provider.outgoingRequests.map(
                (f) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: GroupAvatar(name: f.fullName, imageUrl: f.profileImageUrl),
                  title: Text(f.fullName),
                  subtitle: const Text('Request sent'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 10, 2, 8),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.9,
          color: AppTheme.secondaryDarkText.withValues(alpha: 0.5),
        ),
      ),
    );
  }
}

class _FriendRow extends StatelessWidget {
  const _FriendRow({
    required this.friend,
    required this.onInvite,
    required this.onLongPress,
  });

  final NetRideFriend friend;
  final VoidCallback onInvite;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onLongPress: onLongPress,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppTheme.softBorderColor),
        ),
        child: Row(
          children: [
            GroupAvatar(name: friend.fullName, imageUrl: friend.profileImageUrl),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    friend.fullName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                  if (friend.phone != null)
                    Text(
                      friend.phone!,
                      style: TextStyle(
                        fontSize: 12,
                        color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                      ),
                    ),
                ],
              ),
            ),
            TextButton(
              onPressed: onInvite,
              style: TextButton.styleFrom(
                foregroundColor: AppTheme.primaryBrandGreen,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                  side: const BorderSide(color: AppTheme.primaryBrandGreen),
                ),
              ),
              child: const Text('Invite', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
          ],
        ),
      ),
    );
  }
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({
    required this.friend,
    required this.onAccept,
    required this.onDecline,
  });

  final NetRideFriend friend;
  final Future<void> Function() onAccept;
  final Future<void> Function() onDecline;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Row(
        children: [
          GroupAvatar(name: friend.fullName, imageUrl: friend.profileImageUrl),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              friend.fullName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
            ),
          ),
          IconButton(
            tooltip: 'Decline',
            onPressed: onDecline,
            icon: const Icon(Icons.close, color: AppTheme.errorColor),
          ),
          IconButton(
            tooltip: 'Accept',
            onPressed: onAccept,
            icon: const Icon(Icons.check, color: AppTheme.successGreen),
          ),
        ],
      ),
    );
  }
}
