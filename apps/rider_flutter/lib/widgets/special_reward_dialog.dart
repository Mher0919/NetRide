// lib/widgets/special_reward_dialog.dart
//
// Confirmation dialog shown when the sponsor VALIDATES the rider's code.
// NEW MODEL: validation settles the special server-side automatically — the
// rider's discount stays applied to the ride fare and NO money is ever sent
// back (no refund, no credits).

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';

class SpecialRewardDialog extends StatefulWidget {
  const SpecialRewardDialog({super.key, required this.redemption});

  final SpecialRedemption redemption;

  @override
  State<SpecialRewardDialog> createState() => _SpecialRewardDialogState();
}

class _SpecialRewardDialogState extends State<SpecialRewardDialog> {
  bool _busy = false;

  Future<void> _done() async {
    if (_busy) return;
    setState(() => _busy = true);
    // Refresh the server state so the card renders the settled view.
    final provider = Provider.of<SpecialsProvider>(context, listen: false);
    await provider.refreshSettlementState();
    if (!mounted) return;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.redemption;
    final D = r.calculatedDiscountCents;

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
                colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
            child: const Icon(Icons.verified_rounded, color: Colors.white, size: 32),
          ),
          const SizedBox(height: 14),
          const Text(
            'Visit confirmed!',
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
            '${r.sponsorName} validated your visit. Your discount of '
            '${formatCents2(D)} is applied to the ride. No refund or credit is '
            'issued for specials.',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, height: 1.5, color: Colors.black54),
          ),
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _busy ? null : _done,
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 44),
              textStyle: const TextStyle(fontSize: 14, height: 1.25),
              backgroundColor: const Color(0xFF5B7760),
            ),
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                  )
                : const Text(
                    'Done',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
          ),
        ),
      ],
    );
  }
}