import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/group_provider.dart';
import '../services/group_service.dart';
import '../theme/app_theme.dart';
import 'group_chat_screen.dart';
import 'groups_screen.dart';

/// Opens a specific group from a push notification / universal link.
class GroupOpenScreen extends StatefulWidget {
  const GroupOpenScreen({super.key, this.groupId});
  final String? groupId;

  @override
  State<GroupOpenScreen> createState() => _GroupOpenScreenState();
}

class _GroupOpenScreenState extends State<GroupOpenScreen> {
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final id = widget.groupId;
    if (id == null || id.isEmpty) {
      setState(() => _loading = false);
      return;
    }
    try {
      await context.read<GroupProvider>().openGroup(id);
      if (mounted) setState(() => _loading = false);
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = 'This group is no longer available.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.groupId == null || widget.groupId!.isEmpty) {
      return const GroupsScreen();
    }
    if (_loading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen)),
      );
    }
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Group')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.error_outline_rounded,
                    size: 40, color: AppTheme.errorColor),
                const SizedBox(height: 12),
                Text(_error!, textAlign: TextAlign.center),
                const SizedBox(height: 16),
                ElevatedButton(onPressed: _load, child: const Text('Try again')),
              ],
            ),
          ),
        ),
      );
    }
    return const GroupChatScreen();
  }
}

/// Redeems a secure group invitation token from the SMS/universal link.
class GroupJoinScreen extends StatefulWidget {
  const GroupJoinScreen({super.key, required this.token});
  final String token;

  @override
  State<GroupJoinScreen> createState() => _GroupJoinScreenState();
}

class _GroupJoinScreenState extends State<GroupJoinScreen> {
  Map<String, dynamic>? _preview;
  bool _loading = true;
  bool _joining = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final preview = await GroupService.instance.invitationPreview(widget.token);
      if (!mounted) return;
      setState(() {
        _preview = preview;
        _loading = false;
        if (preview['valid'] != true) {
          _error = (preview['reason'] ?? 'This invitation is not valid.').toString();
        }
      });
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = GroupService.friendly(e, fallback: 'This invitation is not valid.');
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'This invitation is not valid.';
      });
    }
  }

  Future<void> _accept() async {
    if (_joining) return;
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      await context.read<GroupProvider>().joinByToken(widget.token);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(builder: (_) => const GroupChatScreen()),
      );
    } on DioException catch (e) {
      if (!mounted) return;
      setState(() {
        _joining = false;
        _error = GroupService.friendly(e, fallback: 'We couldn\'t join that group.');
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _joining = false;
        _error = 'We couldn\'t join that group.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final valid = _preview?['valid'] == true;
    final groupName = (_preview?['groupName'] ?? 'a group ride').toString();
    final inviter = (_preview?['inviterName'] ?? 'A friend').toString();
    final count = (_preview?['participantCount'] as num?)?.toInt() ?? 0;
    return Scaffold(
      backgroundColor: AppTheme.primaryBackground,
      appBar: AppBar(
        backgroundColor: AppTheme.primaryBackground,
        elevation: 0,
        title: const Text('Group invitation'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen))
          : Padding(
              padding: const EdgeInsets.all(24),
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
                      Icons.groups_2_rounded,
                      size: 46,
                      color: AppTheme.primaryBrandGreen,
                    ),
                  ),
                  const SizedBox(height: 22),
                  Text(
                    valid ? '$inviter invited you to $groupName' : 'Invitation unavailable',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 21, fontWeight: FontWeight.w800, height: 1.25),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    valid
                        ? '$count participants · coordinate pickups, share an optimized route and split the fare.'
                        : (_error ?? 'This invitation has expired or was revoked.'),
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 13.5,
                      height: 1.45,
                      color: AppTheme.secondaryDarkText.withValues(alpha: 0.65),
                    ),
                  ),
                  const SizedBox(height: 26),
                  if (valid)
                    SizedBox(
                      width: double.infinity,
                      height: 52,
                      child: ElevatedButton(
                        onPressed: _joining ? null : _accept,
                        child: _joining
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : const Text(
                                'Join group',
                                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                              ),
                      ),
                    )
                  else
                    OutlinedButton(onPressed: _load, child: const Text('Try again')),
                ],
              ),
            ),
    );
  }
}
