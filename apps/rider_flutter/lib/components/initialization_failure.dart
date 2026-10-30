import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Recoverable initialization failure. Authentication is preserved; the
/// caller retries only the safe, idempotent profile/bootstrap request.
class InitializationFailure extends StatelessWidget {
  const InitializationFailure({
    super.key,
    this.message,
    required this.onRetry,
    this.onSignOut,
  });

  final String? message;
  final VoidCallback onRetry;
  final VoidCallback? onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Container(
                  padding: const EdgeInsets.all(22),
                  decoration: const BoxDecoration(
                    color: Color(0xFFC65A5A),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.cloud_off_rounded,
                    color: Colors.white,
                    size: 38,
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'We couldn\'t finish setting up your account',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.inter(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    color: const Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 10),
                Text(
                  message ??
                      'Your session is still active. Check your connection and retry.',
                  textAlign: TextAlign.center,
                  style: GoogleFonts.inter(
                    fontSize: 14,
                    height: 1.4,
                    color: const Color(0xFF2F3A32).withValues(alpha: 0.65),
                  ),
                ),
                const SizedBox(height: 28),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton(
                    onPressed: onRetry,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF2F3A32),
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14),
                      ),
                    ),
                    child: const Text('Retry'),
                  ),
                ),
                if (onSignOut != null) ...[
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: onSignOut,
                    child: const Text(
                      'Sign out',
                      style: TextStyle(color: Color(0xFF2F3A32)),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
