import 'dart:async';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../services/user_service.dart';

/// Support contact shown to blocked riders. They may only reach support —
/// no app functionality is accessible from this screen.
const String kSupportEmail = 'support@netride.com';

class BlockedAccountScreen extends StatefulWidget {
  final String? reason;

  const BlockedAccountScreen({super.key, this.reason});

  @override
  State<BlockedAccountScreen> createState() => _BlockedAccountScreenState();
}

class _BlockedAccountScreenState extends State<BlockedAccountScreen> {
  Timer? _pollTimer;
  bool _checking = false;

  @override
  void initState() {
    super.initState();
    // Poll for an unblock so the rider returns to the normal app as soon
    // as an admin lifts the block — no app restart required.
    _pollTimer = Timer.periodic(const Duration(seconds: 10), (_) => _checkUnblocked());
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkUnblocked() async {
    if (_checking || !mounted) return;
    _checking = true;
    try {
      final profile = await UserService.getProfile();
      if (!mounted) return;
      if (profile['verification_status'] != 'BLOCKED') {
        _pollTimer?.cancel();
        // Everything is back to normal — return the rider to the app.
        Navigator.pushNamedAndRemoveUntil(context, '/', (route) => false);
      }
    } catch (_) {
      // Keep polling; a transient error shouldn't trap the rider.
    } finally {
      _checking = false;
    }
  }

  Future<void> _emailSupport() async {
    final subject = Uri.encodeComponent('NetRide Account Blocked - Appeal / Question');
    final body = Uri.encodeComponent(
      'Hello NetRide Support,\n\nMy rider account has been blocked. '
      'Please review my case.\n\nThank you.',
    );
    final uri = Uri.parse('mailto:$kSupportEmail?subject=$subject&body=$body');
    if (!await launchUrl(uri)) {
      // Fallback: try a plain mailto without encoding.
      await launchUrl(Uri.parse('mailto:$kSupportEmail'));
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  color: const Color(0xFF5B7760).withOpacity(0.12),
                  shape: BoxShape.circle,
                ),
                child: const Icon(
                  Icons.block_rounded,
                  size: 48,
                  color: Color(0xFF5B7760),
                ),
              ),
              const SizedBox(height: 28),
              const Text(
                'Account Blocked',
                style: TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF2F3A32),
                  letterSpacing: 0.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              const Text(
                'Your NetRide account has been blocked by an administrator. '
                'You will not be able to request rides while your account is blocked.',
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w400,
                  color: Color(0xFF5A6470),
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              if (widget.reason != null && widget.reason!.trim().isNotEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(
                      color: const Color(0xFF5B7760).withOpacity(0.25),
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withOpacity(0.05),
                        blurRadius: 10,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Reason provided by admin:',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF5B7760),
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        widget.reason!,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF2F3A32),
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 28),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _emailSupport,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF5B7760),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                    textStyle: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  child: const Text('Contact Support'),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                'Questions? Email $kSupportEmail',
                style: TextStyle(
                  fontSize: 13,
                  color: theme.colorScheme.onSurface.withOpacity(0.5),
                ),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 18),
              const _CheckingHint(),
            ],
          ),
        ),
      ),
    );
  }
}

class _CheckingHint extends StatelessWidget {
  const _CheckingHint();

  @override
  Widget build(BuildContext context) {
    return const Text(
      'We\'ll automatically return you to the app once your account is unblocked.',
      style: TextStyle(
        fontSize: 12,
        color: Color(0xFF9AA1A8),
        height: 1.4,
      ),
      textAlign: TextAlign.center,
    );
  }
}
