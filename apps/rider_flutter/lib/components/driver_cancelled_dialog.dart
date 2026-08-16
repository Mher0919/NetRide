import 'package:flutter/material.dart';

/// Apology popup shown when the assigned driver cancels BEFORE pickup:
/// the backend releases the SAME ride (same fare quote, promo + credits)
/// back to REQUESTED and re-dispatches it, so the rider keeps searching
/// at the same price — no re-request needed. Rendered exactly once by
/// the screen in front (map sheet or trip screen).
class DriverCancelledDialog extends StatelessWidget {
  const DriverCancelledDialog({super.key});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      backgroundColor: Colors.white,
      title: Center(
        child: Column(
          children: [
            const Icon(Icons.info_outline_rounded, size: 40, color: Color(0xFF5B7760)),
            const SizedBox(height: 12),
            const Text(
              "Driver couldn't arrive",
              style: TextStyle(fontWeight: FontWeight.w900, fontSize: 20, color: Color(0xFF2F3A32)),
            ),
          ],
        ),
      ),
      content: const Text(
        "The driver couldn't approach for some reasons. Don't worry — we're already finding you a new driver at the same price.",
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 13, color: Colors.grey, height: 1.5),
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          height: 46,
          child: ElevatedButton(
            onPressed: () => Navigator.pop(context),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            ),
            child: const Text("OK", style: TextStyle(fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}