import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

class TipReceivedDialog extends StatelessWidget {
  final String amount;
  final String tipperName;

  const TipReceivedDialog({
    super.key,
    required this.amount,
    required this.tipperName,
  });

  @override
  Widget build(BuildContext context) {
    // Format amount cleanly: prepend '$' if not already present
    final displayAmount = amount.startsWith('\$') ? amount : '\$$amount';

    return Dialog(
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.symmetric(horizontal: 32),
      child: Container(
        decoration: BoxDecoration(
          color: AppTheme.lightCardBackground,
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: AppTheme.softBorderColor, width: 1),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.2),
              blurRadius: 15,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Gold Card Visual with Celebration Icon
            Container(
              width: double.infinity,
              height: 140,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [
                    Color(0xFFE5A93B), // gold
                    Color(0xFFF7D070), // light gold
                    Color(0xFFC58E2A), // deep gold
                  ],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(18),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFFC58E2A).withOpacity(0.3),
                    blurRadius: 8,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Stack(
                alignment: Alignment.center,
                children: [
                  // Decorative sparks
                  Positioned(
                    left: 20,
                    top: 20,
                    child: Icon(Icons.star_rounded, color: Colors.white.withOpacity(0.4), size: 24),
                  ),
                  Positioned(
                    right: 30,
                    bottom: 20,
                    child: Icon(Icons.star_rounded, color: Colors.white.withOpacity(0.4), size: 16),
                  ),
                  Positioned(
                    right: 20,
                    top: 30,
                    child: Icon(Icons.celebration_rounded, color: Colors.white.withOpacity(0.3), size: 32),
                  ),
                  Positioned(
                    left: 40,
                    bottom: 30,
                    child: Icon(Icons.celebration_rounded, color: Colors.white.withOpacity(0.3), size: 24),
                  ),
                  // Center icon and text
                  Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      const Icon(
                        Icons.celebration_rounded,
                        color: Colors.white,
                        size: 48,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        displayAmount,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 32,
                          fontWeight: FontWeight.w900,
                          letterSpacing: -0.5,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            Text(
              "You got a $displayAmount tip\nfrom $tipperName!",
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: AppTheme.secondaryDarkText,
                fontSize: 20,
                fontWeight: FontWeight.bold,
                height: 1.3,
              ),
            ),
            const SizedBox(height: 12),
            const Text(
              "Thank you for providing great service!",
              style: TextStyle(
                color: Colors.grey,
                fontSize: 14,
              ),
            ),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryBrandGreen,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14),
                  ),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                onPressed: () {
                  Navigator.of(context).pop();
                },
                child: const Text(
                  'OK',
                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
