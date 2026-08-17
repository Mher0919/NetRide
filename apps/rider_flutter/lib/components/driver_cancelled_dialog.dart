import 'dart:async';

import 'package:flutter/material.dart';

/// Apology dialog shown when an ASSIGNED driver cancels the ride after
/// accepting (pre-pickup release): the backend released the SAME ride
/// (same fare quote, promo + credits) back to searching and re-dispatched
/// it, so the rider keeps searching at the same price — no re-request
/// needed.
///
/// The dialog is temporary by design (spec §10): it dismisses itself after
/// a short moment and the app automatically continues into the existing
/// normal driver-search experience.
class DriverCancelledDialog extends StatefulWidget {
  const DriverCancelledDialog({super.key, this.autoDismissAfter});

  /// How long the apology stays up before dismissing itself. Null/<=0
  /// disables auto-dismiss (waits for the OK button).
  final Duration? autoDismissAfter;

  @override
  State<DriverCancelledDialog> createState() => _DriverCancelledDialogState();
}

class _DriverCancelledDialogState extends State<DriverCancelledDialog> {
  Timer? _dismissTimer;

  @override
  void initState() {
    super.initState();
    final autoDismissAfter = widget.autoDismissAfter;
    if (autoDismissAfter != null && autoDismissAfter > Duration.zero) {
      _dismissTimer = Timer(autoDismissAfter, () {
        if (mounted) Navigator.of(context).pop();
      });
    }
  }

  @override
  void dispose() {
    _dismissTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final autoDismiss = _dismissTimer != null;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        // Tap outside / system back are intentionally ignored: the apology
        // is temporary and the ride recovery continues automatically.
      },
      child: AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        backgroundColor: Colors.white,
        title: Center(
          child: Column(
            children: [
              const Icon(Icons.info_outline_rounded, size: 40, color: Color(0xFF5B7760)),
              const SizedBox(height: 12),
              const Text(
                "We're Sorry",
                style: TextStyle(fontWeight: FontWeight.w900, fontSize: 20, color: Color(0xFF2F3A32)),
              ),
            ],
          ),
        ),
        content: const Text(
          "Your driver had to cancel the ride.\nDon't worry — you're not at fault, and we're finding you another driver right now.",
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: 13, color: Colors.grey, height: 1.5),
        ),
        actionsAlignment: MainAxisAlignment.center,
        actions: autoDismiss
            ? null
            : [
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
      ),
    );
  }
}

/// Convenience: show the apology with the standard auto-dismiss duration.
Future<void> showDriverCancelledApology(BuildContext context) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const DriverCancelledDialog(
      autoDismissAfter: Duration(milliseconds: 2600),
    ),
  );
}
