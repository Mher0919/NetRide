// lib/screens/referral_onboarding_screen.dart
//
// First-time referral onboarding — shown ONCE after sign-in, only when the
// backend says the rider is eligible (POST-AUTH GATE decides; this screen
// never trusts local state). Three paths:
//   1. Scan a friend's QR     → QrScannerScreen (onboarding mode)
//   2. Enter a referral code  → manual code dialog
//   3. Skip for now           → closes the onboarding offer; the rider can
//                               still use a referral code later from the
//                               account page (Refer & Earn)
//
// Every path is validated server-side; the app maps structured error codes
// to friendly copy (no raw errors).

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import '../services/rewards_service.dart';
import '../widgets/referral_code_dialog.dart';
import 'qr_scanner_screen.dart';

class ReferralOnboardingScreen extends StatefulWidget {
  const ReferralOnboardingScreen({super.key});

  @override
  State<ReferralOnboardingScreen> createState() => _ReferralOnboardingScreenState();
}

class _ReferralOnboardingScreenState extends State<ReferralOnboardingScreen> {
  bool _busy = false;

  Future<void> _openScanner() async {
    if (_busy) return;
    final result = await Navigator.push<Map<String, dynamic>>(
      context,
      MaterialPageRoute(builder: (_) => const QrScannerScreen(onboarding: true)),
    );
    if (result == null || !mounted) return;
    await _linkedSuccess(result['referrer_name'] as String?);
  }

Future<void> _enterCode() async {
    if (_busy) return;
    final code = await promptForReferralCode(context);
    if (code == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final result = await RewardsService.scanReferral(code: code);
      if (!mounted) return;
      await _linkedSuccess(result['referrer_name'] as String?);
    } on DioException catch (e) {
      if (!mounted) return;
      await _showMessage(
        title: 'Could not link referral',
        message: friendlyReferralError(e),
        error: true,
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _linkedSuccess(String? referrerName) async {
    await _showMessage(
      title: 'Referral linked!',
      message: referrerName != null
          ? 'You\'re now connected to $referrerName. You both earn \$5 in ride credits after your first completed ride.'
          : 'You\'re now linked. You both earn \$5 in ride credits after your first completed ride.',
    );
    if (!mounted) return;
    Navigator.pushReplacementNamed(context, '/');
  }

  Future<void> _skip() async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Skip for now?', textAlign: TextAlign.center),
        content: const Text(
          'No problem — you can use a referral code later from the Refer & Earn page in your account.',
          textAlign: TextAlign.center,
        ),
        actionsAlignment: MainAxisAlignment.center,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Not now'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Skip'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _busy = true);
    try {
      await RewardsService.skipOnboarding();
      if (!mounted) return;
      Navigator.pushReplacementNamed(context, '/');
    } on DioException {
      if (!mounted) return;
      await _showMessage(
        title: 'Could not update preference',
        message: 'Something went wrong. Please try again later.',
        error: true,
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

Future<void> _showMessage({
    required String title,
    required String message,
    bool error = false,
  }) async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        icon: Icon(
          error ? Icons.error_outline_rounded : Icons.check_circle_rounded,
          size: 48,
          color: error ? const Color(0xFFC65A5A) : const Color(0xFF6E8B74),
        ),
        title: Text(title, textAlign: TextAlign.center),
        content: Text(message, textAlign: TextAlign.center),
        actionsAlignment: MainAxisAlignment.center,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  Widget _actionCard({
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback? onTap,
  }) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      child: Material(
        color: const Color(0xFFF7F4EF),
        borderRadius: BorderRadius.circular(20),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(20),
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  decoration: BoxDecoration(
                    color: const Color(0xFF5B7760).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Icon(icon, color: const Color(0xFF5B7760), size: 26),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF2F3A32),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: TextStyle(
                          fontSize: 12.5,
                          color: const Color(0xFF2F3A32).withOpacity(0.6),
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right_rounded, color: Color(0xFF5B7760)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Scaffold(
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          elevation: 0,
          title: const Text('Welcome'),
          automaticallyImplyLeading: false,
        ),
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 40),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
              Container(
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF2F3A32),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: const Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Get \$5 in ride credits',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                      ),
                    ),
                    SizedBox(height: 8),
                    Text(
                      'Enter a friend\'s referral code and you both earn \$5 in ride credits after your first completed ride.',
                      style: TextStyle(fontSize: 14, color: Color(0xFFD8D2CA)),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 22),
              _actionCard(
                icon: Icons.qr_code_scanner_rounded,
                title: 'Scan a referral QR',
                subtitle: 'Point your camera at a friend\'s code',
                onTap: _busy ? null : _openScanner,
              ),
              _actionCard(
                icon: Icons.keyboard_rounded,
                title: 'Enter a referral code',
                subtitle: 'Type in a code your friend shared',
                onTap: _busy ? null : _enterCode,
              ),
              if (_busy) const Center(child: Padding(
                padding: EdgeInsets.all(8),
                child: CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFF5B7760)),
              )),
              const SizedBox(height: 12),
              Center(
                child: TextButton(
                  onPressed: _busy ? null : _skip,
                  child: const Text(
                    'Skip for now',
                    style: TextStyle(fontSize: 14, color: Color(0xFF5B7760)),
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
}
