// lib/widgets/special_ready_dialog.dart
//
// The full "your special is ready" validation card. Popped right after a
// special ride completes (and re-opened any time by tapping the mini card
// in the Explore "SPECIAL CODES" section). Shows the one-time 6-digit code,
// a reminder that it must be validated inside the special deal place, and a
// red countdown to the 24h expiry (hours; minutes under 1h, never seconds).

import 'dart:async';

import 'package:flutter/material.dart';
import '../models/special_models.dart';
import '../services/specials_service.dart';

class SpecialReadyDialog extends StatefulWidget {
  const SpecialReadyDialog({
    super.key,
    required this.redemption,
    this.code,
  });

  final SpecialRedemption redemption;

  /// One-time code delivered live over the socket. When null (cold start /
  /// missed event) it is recovered from the rider's notification history.
  final String? code;

  @override
  State<SpecialReadyDialog> createState() => _SpecialReadyDialogState();
}

class _SpecialReadyDialogState extends State<SpecialReadyDialog> {
  String? _code;
  bool _recovering = false;
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _code = widget.code;
    if (_code == null) _recoverCode();
    // Refresh the countdown every 30s (labels are hour/minute granularity).
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _recoverCode() async {
    setState(() => _recovering = true);
    final code = await SpecialsService.recoverCode(widget.redemption.id);
    if (!mounted) return;
    setState(() {
      _code = code;
      _recovering = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.redemption;
    final expiresAt = r.validationExpiresAt;
    final expired = expiresAt != null && !expiresAt.isAfter(DateTime.now());

    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(26)),
      backgroundColor: Colors.white,
      surfaceTintColor: Colors.transparent,
      contentPadding: const EdgeInsets.fromLTRB(22, 22, 22, 0),
      title: Column(
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                colors: [Color(0xFFC79A4A), Color(0xFF8A5A00)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
            child: const Icon(
              Icons.confirmation_number_rounded,
              color: Colors.white,
              size: 32,
            ),
          ),
          const SizedBox(height: 14),
          const Text(
            'Your special is ready!',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontWeight: FontWeight.w900,
              fontSize: 21,
              color: Color(0xFF2F3A32),
            ),
          ),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(height: 6),
          Text(
            'Show this code at ${r.sponsorName} to get your deal back — '
            'the business validates it, then you choose between money back '
            'to your card or a little extra in ride credits.',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, height: 1.5, color: Colors.black54),
          ),
          const SizedBox(height: 18),
          if (_code != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 16),
              decoration: BoxDecoration(
                color: const Color(0xFFFBF6EC),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFC79A4A).withOpacity(0.5)),
              ),
              child: Center(
                child: Text(
                  _code!,
                  style: const TextStyle(
                    fontSize: 34,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 10,
                    color: Color(0xFF2F3A32),
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            )
          else if (_recovering)
            const Padding(
              padding: EdgeInsets.all(16),
              child: CircularProgressIndicator(strokeWidth: 2.5),
            )
          else
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text(
                'Your code was sent as a notification — open the latest '
                '"Your special is ready" notification to see it.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, height: 1.4, color: Colors.black54),
              ),
            ),
          const SizedBox(height: 14),
          if (expiresAt != null)
            Text(
              expired
                  ? 'Expired'
                  : 'Expires in ${validationCountdownLabel(expiresAt)}',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                color: expired
                    ? const Color(0xFFC65A5A)
                    : const Color(0xFFC65A5A),
              ),
            ),
          if (r.discountLabel.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              r.discountLabel,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: Color(0xFF8A5A00),
              ),
            ),
          ],
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: () => Navigator.of(context).pop(),
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF2F3A32),
              foregroundColor: Colors.white,
              padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
              minimumSize: const Size(0, 48),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              textStyle: const TextStyle(fontSize: 15, height: 1.25),
            ),
            child: const Text(
              'Got it',
              style: TextStyle(fontWeight: FontWeight.w800, height: 1.25),
            ),
          ),
        ),
      ],
    );
  }
}