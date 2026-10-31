import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../models/group_models.dart';
import '../providers/group_provider.dart';
import '../services/contact_invite_service.dart';
import '../theme/app_theme.dart';
import '../components/skeletons.dart';
import '../widgets/group_avatars.dart';
import 'group_chat_screen.dart';
import 'friends_screen.dart';

class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key});

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  bool _inviting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final provider = context.read<GroupProvider>();
      provider.refreshGroups();
      provider.refreshFriends();
    });
  }

  Future<void> _openGroup(GroupSummary group) async {
    final provider = context.read<GroupProvider>();
    try {
      await provider.openGroup(group.id);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const GroupChatScreen()),
      );
      if (mounted) provider.refreshGroups(silent: true);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('We couldn\'t open this group.')),
      );
    }
  }

  Future<void> _startInvite() async {
    if (_inviting) return;
    setState(() => _inviting = true);
    try {
      final contact = await ContactInviteService.pickOne();
      if (contact == null || !mounted) return;
      final name = await _askGroupName(contact.name);
      if (name == null || name.trim().isEmpty || !mounted) return;
      final provider = context.read<GroupProvider>();
      await provider.createGroup(name: name.trim());
      Map<String, dynamic> invite;
      try {
        invite = await provider.inviteContact(
          phone: contact.phone,
          name: contact.name,
        );
      } catch (e) {
        // If the contact is not on NetRide this still succeeds (SMS path).
        // Surface a clean failure only when the backend truly rejected it.
        rethrow;
      }
      final message = (invite['message'] ?? '').toString();
      if (message.isNotEmpty) {
        await ContactInviteService.openSmsComposer(
          phone: contact.phone,
          message: message,
        );
      }
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const GroupChatScreen()),
      );
      if (mounted) provider.refreshGroups(silent: true);
    } on ContactPickerException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('We couldn\'t create the invitation. Please try again.')),
        );
      }
    } finally {
      if (mounted) setState(() => _inviting = false);
    }
  }

  Future<String?> _askGroupName(String contactName) {
    final controller = TextEditingController(
      text: contactName.trim().isEmpty ? 'Group ride' : 'Ride with $contactName',
    );
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Name your group'),
        content: TextField(
          controller: controller,
          maxLength: 80,
          autofocus: true,
          textCapitalization: TextCapitalization.sentences,
          decoration: const InputDecoration(hintText: 'e.g. Saturday dinner'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Create group'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<GroupProvider>();
    final groups = provider.groups;

    return Scaffold(
      backgroundColor: AppTheme.primaryBackground,
      floatingActionButton: FloatingActionButton(
        onPressed: () => _createGroup(context),
        backgroundColor: AppTheme.primaryBrandGreen,
        child: const Icon(Icons.add, color: Colors.white),
      ),
      body: SafeArea(
        child: RefreshIndicator(
          color: AppTheme.primaryBrandGreen,
          onRefresh: () => provider.refreshGroups(),
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverToBoxAdapter(child: _header(context, provider)),
              if (provider.incomingInvitations.isNotEmpty)
                SliverToBoxAdapter(child: _invitationList(context, provider)),
              if (provider.loadingGroups && groups.isEmpty)
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (_, __) => const _GroupRowSkeleton(),
                    childCount: 5,
                  ),
                )
              else if (groups.isEmpty)
                SliverFillRemaining(
                  hasScrollBody: false,
                  child: _emptyState(context),
                )
              else
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (_, index) => _GroupRow(
                      group: groups[index],
                      onTap: () => _openGroup(groups[index]),
                    ),
                    childCount: groups.length,
                  ),
                ),
              const SliverToBoxAdapter(child: SizedBox(height: 100)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context, GroupProvider provider) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Groups',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        fontSize: 30,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.8,
                      ),
                ),
              ),
              _HeaderAction(
                icon: Icons.group_outlined,
                label: 'Friends',
                onTap: () async {
                  await Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const FriendsScreen()),
                  );
                  if (context.mounted) provider.refreshGroups(silent: true);
                },
              ),
              const SizedBox(width: 8),
              _HeaderAction(
                icon: Icons.person_add_alt_1_outlined,
                label: 'Invite',
                onTap: _inviting ? null : _startInvite,
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Plan one ride with friends and split the fare.',
            style: TextStyle(
              fontSize: 13.5,
              color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
              fontWeight: FontWeight.w500,
            ),
          ),
          if (provider.error != null) ...[
            const SizedBox(height: 10),
            Text(
              provider.error!,
              style: const TextStyle(color: AppTheme.errorColor, fontSize: 12.5),
            ),
          ],
        ],
      ),
    );
  }

  Widget _invitationList(BuildContext context, GroupProvider provider) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(4, 4, 4, 6),
            child: Text(
              'GROUP INVITATIONS',
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.9,
                color: Color(0xFF7C847D),
              ),
            ),
          ),
          ...provider.incomingInvitations.map((invitation) {
            final inviter = (invitation['inviterName'] ?? 'A friend').toString();
            final groupName = (invitation['groupName'] ?? 'a group').toString();
            final count = (invitation['participantCount'] as num?)?.toInt() ?? 0;
            return Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: AppTheme.primaryBrandGreen.withValues(alpha: 0.28),
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${inviter.split(' ').first} invited you to "$groupName"',
                    style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    '$count participants · coordinate pickups and split the fare',
                    style: TextStyle(
                      fontSize: 11.5,
                      color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () async {
                            await provider.declineInvitation(invitation['id'].toString());
                          },
                          style: OutlinedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                          child: const Text('Decline'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: ElevatedButton(
                          onPressed: () async {
                            try {
                              await provider
                                  .acceptInvitation(invitation['id'].toString());
                              if (!context.mounted) return;
                              await Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => const GroupChatScreen(),
                                ),
                              );
                            } catch (_) {
                              if (!context.mounted) return;
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('We couldn\'t join that group.'),
                                ),
                              );
                            }
                          },
                          style: ElevatedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(vertical: 10),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(10),
                            ),
                          ),
                          child: const Text('Accept'),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            );
          }),
        ],
      ),
    );
  }

  Widget _emptyState(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 36),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 92,
              height: 92,
              decoration: BoxDecoration(
                color: AppTheme.primaryBrandGreen.withValues(alpha: 0.12),
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.groups_2_outlined,
                size: 44,
                color: AppTheme.primaryBrandGreen,
              ),
            ),
            const SizedBox(height: 20),
            const Text(
              'No groups yet',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            Text(
              'Start a group with friends to coordinate pickups, share an optimized route and split the fare.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 14,
                height: 1.45,
                color: AppTheme.secondaryDarkText.withValues(alpha: 0.65),
              ),
            ),
            const SizedBox(height: 22),
            ElevatedButton.icon(
              onPressed: () => _createGroup(context),
              icon: const Icon(Icons.add),
              label: const Text('Create a group'),
            ),
          ],
        ),
      ),
    );
  }

  Future<List<String>?> _selectFriends(
    BuildContext context,
    GroupProvider provider,
  ) async {
    if (provider.friends.isEmpty) {
      await provider.refreshFriends();
      if (!mounted) return null;
    }
    if (provider.friends.isEmpty) return const [];
    final selected = <String>{};
    return showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => SafeArea(
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              16,
              18,
              16,
              16 + MediaQuery.viewInsetsOf(ctx).bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Add friends',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                Text(
                  'Choose up to 4 accepted NetRide friends. You can invite contacts later.',
                  style: TextStyle(
                    fontSize: 12,
                    color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
                  ),
                ),
                const SizedBox(height: 10),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: provider.friends.map((f) {
                      final checked = selected.contains(f.userId);
                      return CheckboxListTile(
                        value: checked,
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.trailing,
                        secondary:
                            GroupAvatar(name: f.fullName, imageUrl: f.profileImageUrl),
                        title: Text(f.fullName),
                        subtitle: f.phone != null ? Text(f.phone!) : null,
                        onChanged: (v) {
                          setLocal(() {
                            if (v == true) {
                              if (selected.length >= 4) {
                                return;
                              }
                              selected.add(f.userId);
                            } else {
                              selected.remove(f.userId);
                            }
                          });
                        },
                      );
                    }).toList(),
                  ),
                ),
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: () => Navigator.pop(ctx, selected.toList()),
                    child: Text(
                      'Create group${selected.isEmpty ? '' : ' · ${selected.length} friend${selected.length == 1 ? '' : 's'}'}',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _createGroup(BuildContext context) async {
    final name = await _askGroupName('');
    if (name == null || name.trim().isEmpty || !mounted) return;
    final provider = context.read<GroupProvider>();
    final selected = await _selectFriends(context, provider);
    if (selected == null || !mounted) return;
    try {
      await provider.createGroup(name: name.trim(), memberIds: selected);
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const GroupChatScreen()),
      );
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('We couldn\'t create the group. Please try again.')),
      );
    }
  }
}

class _HeaderAction extends StatelessWidget {
  const _HeaderAction({required this.icon, required this.label, this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppTheme.softBorderColor),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 19, color: AppTheme.primaryBrandGreen),
            const SizedBox(height: 2),
            Text(
              label,
              style: const TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                color: AppTheme.secondaryDarkText,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GroupRow extends StatelessWidget {
  const _GroupRow({required this.group, required this.onTap});
  final GroupSummary group;
  final VoidCallback onTap;

  String _timeLabel() {
    final at = group.lastMessageAt;
    if (at == null) return '';
    final now = DateTime.now();
    if (now.difference(at).inDays == 0) return DateFormat.jm().format(at);
    if (now.difference(at).inDays < 7) return DateFormat.E().format(at);
    return DateFormat.MMMd().format(at);
  }

  @override
  Widget build(BuildContext context) {
    final unread = group.unreadCount > 0;
    return InkWell(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(
          color: unread ? Colors.white : Colors.white.withValues(alpha: 0.65),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: unread
                ? AppTheme.primaryBrandGreen.withValues(alpha: 0.35)
                : AppTheme.softBorderColor,
          ),
        ),
        child: Row(
          children: [
            if (group.members.isNotEmpty)
              GroupAvatarStack(
                participants: group.members,
                size: 34,
                max: 2,
              )
            else
              Container(
                width: 50,
                height: 50,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBrandGreen.withValues(alpha: 0.14),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.groups_2_rounded,
                  color: AppTheme.primaryBrandGreen,
                  size: 26,
                ),
              ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          group.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 15.5,
                            fontWeight: unread ? FontWeight.w800 : FontWeight.w700,
                            letterSpacing: -0.2,
                          ),
                        ),
                      ),
                      if (group.hasActiveRide) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 3),
                          decoration: BoxDecoration(
                            color: AppTheme.successGreen.withValues(alpha: 0.16),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Text(
                            'RIDE',
                            style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.4,
                              color: AppTheme.successGreen,
                            ),
                          ),
                        ),
                      ],
                      const SizedBox(width: 6),
                      Text(
                        _timeLabel(),
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: AppTheme.secondaryDarkText.withValues(alpha: 0.45),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(
                        Icons.people_outline_rounded,
                        size: 13,
                        color: AppTheme.secondaryDarkText.withValues(alpha: 0.45),
                      ),
                      const SizedBox(width: 3),
                      Text(
                        '${group.participantCount}',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          group.lastMessage?.isNotEmpty == true
                              ? (group.lastMessageSenderName != null
                                  ? '${group.lastMessageSenderName}: ${group.lastMessage}'
                                  : group.lastMessage!)
                              : 'Group created — start planning',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12.5,
                            height: 1.3,
                            fontWeight: unread ? FontWeight.w600 : FontWeight.w500,
                            color: AppTheme.secondaryDarkText.withValues(
                              alpha: unread ? 0.8 : 0.55,
                            ),
                          ),
                        ),
                      ),
                      if (unread) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 3),
                          decoration: BoxDecoration(
                            color: AppTheme.primaryBrandGreen,
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            group.unreadCount > 99 ? '99+' : '${group.unreadCount}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GroupRowSkeleton extends StatelessWidget {
  const _GroupRowSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: SkeletonPulse(
        child: Row(
          children: [
            SkeletonCircle(size: 50),
            SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SkeletonLine(width: 150, height: 14),
                  SizedBox(height: 8),
                  SkeletonLine(height: 11),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
