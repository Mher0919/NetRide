// lib/screens/post_auth_gate.dart
//
// Backend-authoritative gate shown right after login/signup/cold start.
//
// The gate never routes into the authenticated shell until the session's
// authoritative profile has been resolved. A profile that is merely still
// loading (or failed to load) is never interpreted as unverified/incomplete:
// the rider sees a skeleton while loading and a retryable error on failure.
//
// The backend decides the destination:
//   - BLOCKED account            -> /blocked
//   - referral onboarding open   -> /referral-onboarding
//   - otherwise                  -> /

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../components/initialization_failure.dart';
import '../components/skeletons.dart';
import '../providers/session_provider.dart';
import '../services/auth_service.dart';
import '../services/rewards_service.dart';
import '../main.dart' show kInitialBlockedReason, kInitialIsBlocked;

class PostAuthGate extends StatefulWidget {
  const PostAuthGate({super.key});

  @override
  State<PostAuthGate> createState() => _PostAuthGateState();
}

class _PostAuthGateState extends State<PostAuthGate> {
  SessionProvider? _session;
  bool _routing = false;

  @override
  void initState() {
    super.initState();
    _session = context.read<SessionProvider>()..addListener(_onSessionChanged);
    _onSessionChanged();
  }

  @override
  void dispose() {
    _session?.removeListener(_onSessionChanged);
    super.dispose();
  }

  void _onSessionChanged() {
    final session = _session;
    if (!mounted || session == null) return;

    switch (session.status) {
      case SessionStatus.restoring:
      case SessionStatus.loadingProfile:
      case SessionStatus.failed:
        return;
      case SessionStatus.unauthenticated:
        if (_routing) return;
        _routing = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        });
      case SessionStatus.ready:
        if (_routing) return;
        _routing = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _routeAfterProfile(session);
        });
    }
  }

  Future<void> _routeAfterProfile(SessionProvider session) async {
    _routing = true;
    final profile = session.profile ?? const <String, dynamic>{};
    if (profile['verification_status'] == 'BLOCKED') {
      kInitialBlockedReason = profile['blocked_reason'] as String?;
      kInitialIsBlocked = true;
      Navigator.pushReplacementNamed(context, '/blocked');
      return;
    }

    try {
      final status = await RewardsService.getOnboardingStatus();
      if (!mounted) return;
      if (status.eligible) {
        Navigator.pushReplacementNamed(context, '/referral-onboarding');
        return;
      }
    } catch (_) {
      // Referral eligibility is optional; a failure must not block the rider.
    }

    if (!mounted) return;
    Navigator.pushReplacementNamed(context, '/');
  }

  Future<void> _signOut() async {
    // Own the navigation: suppress the auth-notifier listener's redirect so
    // the user lands on exactly one login screen.
    _routing = true;
    await AuthService.logout();
    if (!mounted) return;
    Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionProvider>();

    if (session.status == SessionStatus.failed) {
      return InitializationFailure(
        message: session.errorMessage,
        onRetry: () {
          _routing = false;
          session.retry();
        },
        onSignOut: _signOut,
      );
    }

    // Force an authoritative load when this gate is reached with no attempt
    // in flight (e.g. an auth event that landed between frames).
    if (session.status == SessionStatus.restoring) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _session?.status == SessionStatus.restoring) {
          _session?.initialize();
        }
      });
    }

    return const PostAuthSkeleton();
  }
}
