import 'package:flutter/material.dart';

class VerificationBanner extends StatelessWidget {
  final String status; // PENDING, VERIFIED, REJECTED
  final String? reason;
  final VoidCallback? onDismiss;
  final VoidCallback? onViewDetails;

  const VerificationBanner({
    super.key,
    required this.status,
    this.reason,
    this.onDismiss,
    this.onViewDetails,
  });

  @override
  Widget build(BuildContext context) {
    if (status == 'PENDING') {
      return _buildBanner(
        color: const Color(0xFFF9A825), // Industry yellow
        icon: Icons.hourglass_empty_rounded,
        message: 'Account inspection in progress. Ride requests are temporarily restricted.',
      );
    }

    if (status == 'VERIFIED') {
      return _buildBanner(
        color: const Color(0xFF2E7D32), // Success green
        icon: Icons.check_circle_outline_rounded,
        message: 'Identity verified successfully! You now have full platform access.',
        isDismissible: true,
      );
    }

    if (status == 'REJECTED') {
      return _buildBanner(
        color: const Color(0xFFC62828), // Error red
        icon: Icons.error_outline_rounded,
        message: 'Verification failed. Review the feedback and re-submit your application.',
        actionLabel: 'SEE WHY',
        onAction: onViewDetails,
      );
    }

    return const SizedBox.shrink();
  }

  Widget _buildBanner({
    required Color color,
    required IconData icon,
    required String message,
    bool isDismissible = false,
    String? actionLabel,
    VoidCallback? onAction,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: color,
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 4, offset: const Offset(0, 2)),
        ],
      ),
      child: SafeArea(
        bottom: false,
        child: Row(
          children: [
            Icon(icon, color: Colors.white, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                message,
                style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            if (actionLabel != null)
              TextButton(
                onPressed: onAction,
                style: TextButton.styleFrom(
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  side: const BorderSide(color: Colors.white, width: 1),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: Text(actionLabel, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w800)),
              ),
            if (isDismissible)
              IconButton(
                icon: const Icon(Icons.close, color: Colors.white, size: 18),
                onPressed: onDismiss,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints(),
              ),
          ],
        ),
      ),
    );
  }
}
