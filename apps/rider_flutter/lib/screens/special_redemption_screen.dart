// lib/screens/special_redemption_screen.dart
//
// The rider's active redemption — a single card that walks the lifecycle:
//   CREATED             → book a ride to the business
//   RIDE_PENDING        → discount applied, ride in progress
//   WAITING_FOR_SPONSOR → show your one-time 6-digit code + "I got verified"
//   SPONSOR_VALIDATED   → choose REFUND (wallet) or CREDITS (+10% bonus)
//   REWARD_COMPLETED    → done
//   CANCELLED / EXPIRED → terminal with reason
// The raw code is never persisted; it arrives via push data or is recovered
// from in-app notification history (spec §99).

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';
import '../services/specials_service.dart';

class SpecialRedemptionScreen extends StatefulWidget {
  const SpecialRedemptionScreen({super.key, this.code});

  /// Code delivered by a tapped `special_reward_ready` push, if any.
  final String? code;

  @override
  State<SpecialRedemptionScreen> createState() =>
      _SpecialRedemptionScreenState();
}

class _SpecialRedemptionScreenState extends State<SpecialRedemptionScreen> {
  String? _knownCode;
  bool _recoveringCode = false;

  @override
  void initState() {
    super.initState();
    _knownCode = widget.code;
    final provider = context.read<SpecialsProvider>();
    if (provider.current == null) provider.refresh();
    if (_knownCode == null) {
      _recoverCode();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      provider.stashCode(null);
    });
  }

  Future<void> _recoverCode() async {
    final r = context.read<SpecialsProvider>().current;
    if (r == null || _knownCode != null) return;
    setState(() => _recoveringCode = true);
    final code = await SpecialsService.recoverCode(r.id);
    if (!mounted) return;
    setState(() {
      _knownCode = code;
      _recoveringCode = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F4EF),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        title: const Text(
          'Your special',
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w700,
            color: Color(0xFF2F3A32),
          ),
        ),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: Consumer<SpecialsProvider>(
        builder: (context, specials, _) {
          if (specials.loading && specials.current == null) {
            return const Center(child: CircularProgressIndicator());
          }
          final r = specials.current;
          if (r == null) {
            return _noRedemption();
          }
          return RefreshIndicator(
            onRefresh: specials.refresh,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 40),
              children: [
                _businessHeader(r),
                const SizedBox(height: 16),
                ..._bodyFor(specials, r),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _noRedemption() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.storefront_rounded,
                size: 44, color: Color(0xFF9AA79E)),
            const SizedBox(height: 14),
            const Text(
              'No active special',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: Color(0xFF2F3A32),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Pick a SPECIAL business from the list to start saving.',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 13,
                color: const Color(0xFF2F3A32).withOpacity(0.6),
              ),
            ),
            const SizedBox(height: 18),
            OutlinedButton(
              onPressed: () => Navigator.of(context).pop(),
              style: OutlinedButton.styleFrom(
                foregroundColor: const Color(0xFF5B7760),
                side: const BorderSide(color: Color(0xFF5B7760)),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(30),
                ),
              ),
              child: const Text('Browse SPECIALS'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _businessHeader(SpecialRedemption r) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(22),
      ),
      child: Row(
        children: [
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: Colors.white.withOpacity(0.16),
              borderRadius: BorderRadius.circular(14),
            ),
            child: const Icon(Icons.storefront_rounded,
                color: Colors.white, size: 26),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  r.sponsorName,
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  r.discountLabel.isEmpty ? 'Special offer' : r.discountLabel,
                  style: TextStyle(
                    color: Colors.white.withOpacity(0.85),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _bodyFor(SpecialsProvider specials, SpecialRedemption r) {
    switch (r.status) {
      case 'CREATED':
        return _createdBody(specials, r);
      case 'RIDE_PENDING':
        return _ridePendingBody(r);
      case 'WAITING_FOR_SPONSOR':
        return _waitingBody(specials, r);
      case 'SPONSOR_VALIDATED':
      case 'REWARD_SELECTED':
      case 'REWARD_FAILED':
        return _rewardBody(specials, r);
      case 'REWARD_COMPLETED':
        return _completedBody(r);
      case 'CANCELLED':
        return _cancelledBody(r);
      case 'EXPIRED':
        return _expiredBody(r);
      default:
        return [_infoCard('Special status: ${r.status}')];
    }
  }

  // ------------------------------------------------------------ CREATED
  List<Widget> _createdBody(SpecialsProvider specials, SpecialRedemption r) {
    return [
      _infoCard(
        'You\'re all set to save at ${r.sponsorName}. Book a ride to the '
        'business and your discount applies at checkout.',
        icon: Icons.event_available_rounded,
      ),
      const SizedBox(height: 14),
      SizedBox(
        width: double.infinity,
        height: 52,
        child: FilledButton(
          onPressed: () {
            Navigator.of(context).popUntil((route) => route.isFirst);
            context.read<SpecialsProvider>().refresh();
          },
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF5B7760),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(30),
            ),
          ),
          child: const Text(
            'Book my ride to this business',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ),
    ];
  }

  // -------------------------------------------------------- RIDE_PENDING
  List<Widget> _ridePendingBody(SpecialRedemption r) {
    return [
      _infoCard(
        'Your special is active on this ride. When the ride ends you\'ll get '
        'a one-time code to show at ${r.sponsorName}.',
        icon: Icons.directions_car_rounded,
      ),
    ];
  }

  // -------------------------------------------------- WAITING_FOR_SPONSOR
  List<Widget> _waitingBody(SpecialsProvider specials, SpecialRedemption r) {
    final code = _knownCode;
    return [
      Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFE3DDD4)),
        ),
        child: Column(
          children: [
            const Text(
              'Show this code at the business',
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 16),
            if (code != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 18),
                decoration: BoxDecoration(
                  color: const Color(0xFFF7F4EF),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Center(
                  child: Text(
                    code,
                    style: const TextStyle(
                      fontSize: 40,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 12,
                      color: Color(0xFF2F3A32),
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              )
            else if (_recoveringCode)
              const Padding(
                padding: EdgeInsets.all(20),
                child: CircularProgressIndicator(),
              )
            else
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: Text(
                  'Your code was sent as a notification — open the latest '
                  '"Your special is ready" notification to see it.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, height: 1.4),
                ),
              ),
            const SizedBox(height: 12),
            if (r.validationExpiresAt != null)
              Text(
                'Expires ${DateFormat('h:mm a · MMM d').format(r.validationExpiresAt!)}',
                style: TextStyle(
                  fontSize: 12,
                  color: const Color(0xFF2F3A32).withOpacity(0.55),
                ),
              ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      SizedBox(
        width: double.infinity,
        height: 52,
        child: FilledButton(
          onPressed: specials.busy ? null : () => specials.markVerified(),
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFF5B7760),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(30),
            ),
          ),
          child: specials.busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Text(
                  'I got verified',
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
                ),
        ),
      ),
      const SizedBox(height: 8),
      Text(
        'The business confirms the visit with your code.',
        textAlign: TextAlign.center,
        style: TextStyle(
          fontSize: 12,
          color: const Color(0xFF2F3A32).withOpacity(0.55),
        ),
      ),
    ];
  }

  // ------------------------------------------------- SPONSOR_VALIDATED
  List<Widget> _rewardBody(SpecialsProvider specials, SpecialRedemption r) {
    final D = r.calculatedDiscountCents;
    final credits = r.rewardAmountCents ?? (D + (D ~/ 10));
    return [
      _infoCard(
        '${r.sponsorName} confirmed your visit. Choose how to collect your '
        'savings:',
        icon: Icons.check_circle_rounded,
      ),
      const SizedBox(height: 14),
      _rewardOption(
        title: 'Cash back to wallet',
        amount: formatCents2(D),
        subtitle: 'Your wallet balance',
        icon: Icons.account_balance_wallet_rounded,
        onTap: specials.busy ? null : () => _chooseReward(specials, 'REFUND'),
      ),
      const SizedBox(height: 12),
      _rewardOption(
        title: 'Ride credits',
        amount: formatCents2(credits),
        subtitle: '+10% bonus — spend on any ride',
        icon: Icons.bolt_rounded,
        onTap: specials.busy ? null : () => _chooseReward(specials, 'CREDITS'),
        highlighted: true,
      ),
    ];
  }

  Future<void> _chooseReward(SpecialsProvider specials, String choice) async {
    final r = specials.current;
    if (r == null) return;
    final amount = choice == 'REFUND'
        ? formatCents2(r.calculatedDiscountCents)
        : formatCents2(r.rewardAmountCents ?? (r.calculatedDiscountCents + (r.calculatedDiscountCents ~/ 10)));
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Collect your reward?'),
        content: Text(
          choice == 'REFUND'
              ? '$amount will be refunded to your wallet.'
              : '$amount in ride credits will be added to your account.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Not yet'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF5B7760),
            ),
            child: const Text('Yes, collect'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await specials.chooseReward(choice);
  }

  // --------------------------------------------------- REWARD_COMPLETED
  List<Widget> _completedBody(SpecialRedemption r) {
    final isRefund = r.rewardChoice == 'REFUND';
    return [
      Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: const Color(0xFFE3DDD4)),
        ),
        child: Column(
          children: [
            const Icon(Icons.verified_rounded,
                color: Color(0xFF5B7760), size: 44),
            const SizedBox(height: 12),
            const Text(
              'Reward collected',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              isRefund
                  ? '${formatCents2(r.rewardAmountCents ?? 0)} was refunded to '
                      'your wallet.'
                  : '${formatCents2(r.rewardAmountCents ?? 0)} in ride credits '
                      'was added to your account.',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 14, height: 1.4),
            ),
          ],
        ),
      ),
    ];
  }

  // --------------------------------------------------------- CANCELLED
  List<Widget> _cancelledBody(SpecialRedemption r) {
    final reason = r.cancellationReasonText ??
        (r.cancellationReasonCode ?? '').replaceAll('_', ' ').toLowerCase();
    return [
      _infoCard(
        reason.isEmpty
            ? 'This special was cancelled.'
            : 'This special was cancelled: $reason',
        icon: Icons.cancel_rounded,
      ),
    ];
  }

  // ----------------------------------------------------------- EXPIRED
  List<Widget> _expiredBody(SpecialRedemption r) {
    return [
      _infoCard(
        'Your validation code expired before the business could confirm the '
        'visit. Pick a new special any time.',
        icon: Icons.timer_off_rounded,
      ),
    ];
  }

  Widget _rewardOption({
    required String title,
    required String amount,
    required String subtitle,
    required IconData icon,
    required VoidCallback? onTap,
    bool highlighted = false,
  }) {
    return Material(
      color: highlighted ? const Color(0xFF5B7760) : Colors.white,
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: highlighted
                ? null
                : Border.all(color: const Color(0xFFE3DDD4)),
          ),
          child: Row(
            children: [
              Icon(
                icon,
                color: highlighted
                    ? Colors.white
                    : const Color(0xFF5B7760),
                size: 28,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color:
                            highlighted ? Colors.white : const Color(0xFF2F3A32),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12,
                        color: highlighted
                            ? Colors.white.withOpacity(0.8)
                            : const Color(0xFF2F3A32).withOpacity(0.55),
                      ),
                    ),
                  ],
                ),
              ),
              Text(
                amount,
                style: TextStyle(
                  fontSize: 16,
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

  Widget _infoCard(String message, {IconData icon = Icons.info_rounded}) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 22, color: const Color(0xFF5B7760)),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontSize: 14, height: 1.45),
            ),
          ),
        ],
      ),
    );
  }
}
