// lib/screens/post_auth_gate.dart
//
// Backend-authoritative gate shown right after login/signup/cold start.
// The backend decides EVERYTHING here:
//   - BLOCKED account            → /blocked
//   - referral onboarding open   → /referral-onboarding
//   - otherwise                  → /
//
// The Flutter app never decides eligibility on its own; if the backend is
// unreachable it trusts the existing session (same fallback as main.dart).

import 'package:flutter/material.dart';
import '../services/rewards_service.dart';
import '../services/user_service.dart';
import '../main.dart' show kInitialBlockedReason, kInitialIsBlocked;

class PostAuthGate extends StatefulWidget {
  const PostAuthGate({super.key});

  @override
  State<PostAuthGate> createState() => _PostAuthGateState();
}

class _PostAuthGateState extends State<PostAuthGate> {
  @override
  void initState() {
    super.initState();
    _resolve();
  }

  Future<void> _resolve() async {
    try {
      final profile = await UserService.getProfile();
      if (!mounted) return;
      if (profile['verification_status'] == 'BLOCKED') {
        kInitialBlockedReason = profile['blocked_reason'] as String?;
        kInitialIsBlocked = true;
        Navigator.pushReplacementNamed(context, '/blocked');
        return;
      }
    } catch (_) {
      // Backend unreachable — trust the existing session.
      if (!mounted) return;
      Navigator.pushReplacementNamed(context, '/');
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
      // Gate check failed (network) — never block the rider from the app.
    }

    if (!mounted) return;
    Navigator.pushReplacementNamed(context, '/');
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: Color(0xFF11140F),
      body: Center(
        child: CircularProgressIndicator(color: Color(0xFF6E8B74)),
      ),
    );
  }
}
