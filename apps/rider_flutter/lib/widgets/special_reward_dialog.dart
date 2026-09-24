// lib/widgets/special_reward_dialog.dart
//
// Congratulations dialog shown when the sponsor VALIDATES the rider's code.
// The rider chooses between getting the deal back to their card (REFUND →
// wallet) or a little extra in ride credits (CREDITS, +10% bonus). The
// backend settles atomically; the card disappears once settled.

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

  Future<void> _choose(String choice) async {
    if (_busy) return;
    setState(() => _busy = true);
    final provider = Provider.of<SpecialsProvider>(context, listen: false);
    final settled = await provider.chooseReward(choice);
    if (!mounted) return;
    if (settled != null) {
      Navigator.of(context).pop();
    } else {
      setState(() => _busy = false);
      final error = provider.error;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error == null || error.startsWith('Exception')
              ? 'Could not collect your reward right now. Please try again.'
              : error),
          behavior: SnackBarBehavior.floating,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.redemption;
    final D = r.calculatedDiscountCents;
    final credits = r.rewardAmountCents ?? (D + (D ~/ 10));

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
            'Congratulations!',
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
            '${r.sponsorName} validated your visit. Choose how to collect '
            'your savings:',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, height: 1.5, color: Colors.black54),
          ),
          const SizedBox(height: 16),
          _RewardChoiceTile(
            title: 'Back to card',
            amount: formatCents2(D),
            subtitle: 'Refunded to your wallet',
            icon: Icons.account_balance_wallet_rounded,
            busy: _busy,
            onTap: () => _choose('REFUND'),
          ),
          const SizedBox(height: 10),
          _RewardChoiceTile(
            title: 'A little more in ride credits',
            amount: formatCents2(credits),
            subtitle: '+10% bonus — spend on any ride',
            icon: Icons.bolt_rounded,
            highlighted: true,
            busy: _busy,
            onTap: () => _choose('CREDITS'),
          ),
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        SizedBox(
          width: double.infinity,
          child: TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 44),
              textStyle: const TextStyle(fontSize: 14, height: 1.25),
            ),
            child: const Text(
              'Not yet',
              style: TextStyle(fontWeight: FontWeight.w700, color: Colors.black54),
            ),
          ),
        ),
      ],
    );
  }
}

class _RewardChoiceTile extends StatelessWidget {
  const _RewardChoiceTile({
    required this.title,
    required this.amount,
    required this.subtitle,
    required this.icon,
    required this.busy,
    required this.onTap,
    this.highlighted = false,
  });

  final String title;
  final String amount;
  final String subtitle;
  final IconData icon;
  final bool busy;
  final VoidCallback onTap;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: highlighted ? const Color(0xFF5B7760) : Colors.white,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: busy ? null : onTap,
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: highlighted
                ? null
                : Border.all(color: const Color(0xFFE3DDD4)),
          ),
          child: Row(
            children: [
              Icon(
                icon,
                color: highlighted ? Colors.white : const Color(0xFF5B7760),
                size: 26,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: highlighted
                            ? Colors.white
                            : const Color(0xFF2F3A32),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 11.5,
                        color: highlighted
                            ? Colors.white.withOpacity(0.8)
                            : const Color(0xFF2F3A32).withOpacity(0.55),
                      ),
                    ),
                  ],
                ),
              ),
              if (busy)
                const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              else
                Text(
                  amount,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w800,
                    color:
                        highlighted ? Colors.white : const Color(0xFF5B7760),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}