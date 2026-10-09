// lib/widgets/explore_validation_section.dart
//
// "SPECIAL CODES" — the validation-code cards INSIDE Explore, placed
// between Recents and the SPECIALS section. One card per completed special
// ride awaiting the sponsor's code entry:
//
//   EXPLORE
//   ├── Search / Map / Recents
//   ├── SPECIAL CODES                 ← this widget (hidden when none open)
//   │   └── horizontal cards (code · sponsor · red 24h countdown)
//   ├── SPECIALS
//   └── other Explore content
//
// Cards are gold-accented to stand apart from the white SPECIALS cards.
// Tapping a card re-opens the full code card. When a code is validated the
// backend pushes SPONSOR_VALIDATED → the section pops the congratulations
// dialog (back to card / a little more in ride credits) and the card is
// gone once the reward is settled.
//
// Visibility rule: section renders NOTHING when no open validation cards
// exist (backend-authoritative via GET /specials/redemptions/pending).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/special_models.dart';
import '../providers/ride_provider.dart';
import '../providers/specials_provider.dart';
import '../models/trip_models.dart' as models;
import 'special_ready_dialog.dart';
import 'special_reward_dialog.dart';

class ExploreValidationSection extends StatefulWidget {
  const ExploreValidationSection({super.key});

  @override
  State<ExploreValidationSection> createState() =>
      _ExploreValidationSectionState();
}

class _ExploreValidationSectionState extends State<ExploreValidationSection> {
  /// Keeps the red countdowns honest (hour/minute granularity → 30s tick).
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  bool _cardVisible(SpecialRedemption r) {
    if (r.status == 'WAITING_FOR_SPONSOR') {
      final expiresAt = r.validationExpiresAt;
      if (expiresAt != null && !expiresAt.isAfter(DateTime.now())) {
        return false; // expired client-side (backend job flips to EXPIRED)
      }
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<SpecialsProvider>(
      builder: (context, specials, _) {
        final cards = specials.pending.where(_cardVisible).toList();
        if (cards.isEmpty) return const SizedBox.shrink();

        // Live transitions → pop the right dialog exactly once per card.
        final rideStatus =
            Provider.of<RideProvider>(context, listen: false).status;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted || !TickerMode.of(context)) return;
          final specialsNow = context.read<SpecialsProvider>();
          // Reward notice (sponsor validated) — never over an active ride.
          final rewardId = rideStatus == models.TripStatus.IDLE ||
                  rideStatus == models.TripStatus.REQUESTED
              ? specialsNow.consumeRewardNotice()
              : null;
          if (rewardId != null) {
            final r = cards.firstWhere((e) => e.id == rewardId,
                orElse: () => cards.first);
            if (r.status == 'SPONSOR_VALIDATED' ||
                r.status == 'REWARD_SELECTED' ||
                r.status == 'REWARD_FAILED') {
              showDialog<void>(
                context: context,
                barrierDismissible: false,
                builder: (_) => SpecialRewardDialog(redemption: r),
              );
            }
            return;
          }
          // Ready notice (ride completed) — fallback consumer for completions
          // that raced past the trip screen.
          final readyId = specialsNow.consumeReadyNotice();
          if (readyId != null) {
            final r = cards.firstWhere((e) => e.id == readyId,
                orElse: () => cards.first);
            showDialog<void>(
              context: context,
              builder: (_) => SpecialReadyDialog(
                redemption: r,
                code: specialsNow.codeFor(r.id),
              ),
            );
          }
        });

        return Padding(
          padding: const EdgeInsets.only(top: 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.confirmation_number_rounded,
                    size: 18,
                    color: Color(0xFF8A5A00),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'SPECIAL CODES',
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: Color(0xFF2F3A32),
                    ),
                  ),
                  const Spacer(),
                  Text(
                    '${cards.length} open',
                    style: const TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: Color(0xFF8A5A00),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              Text(
                'Validate your code inside the deal place to get your deal back.',
                style: TextStyle(
                  fontSize: 12,
                  color: const Color(0xFF2F3A32).withOpacity(0.6),
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 152,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  physics: const BouncingScrollPhysics(),
                  itemCount: cards.length,
                  separatorBuilder: (_, _) => const SizedBox(width: 10),
                  itemBuilder: (context, i) =>
                      _ValidationCard(redemption: cards[i]),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _ValidationCard extends StatelessWidget {
  const _ValidationCard({required this.redemption});

  final SpecialRedemption redemption;

  void _open(BuildContext context, SpecialsProvider specials) {
    final r = redemption;
    if (r.status == 'SPONSOR_VALIDATED' ||
        r.status == 'REWARD_SELECTED' ||
        r.status == 'REWARD_FAILED') {
      // Reward is ready — the congratulations + choice dialog is the point.
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => SpecialRewardDialog(redemption: r),
      );
      return;
    }
    Navigator.of(context).pushNamed('/special-redemption', arguments: {
      'redemptionId': r.id,
      'code': specials.codeFor(r.id),
    });
  }

  @override
  Widget build(BuildContext context) {
    final r = redemption;
    final specials = Provider.of<SpecialsProvider>(context, listen: false);
    final isWaiting = r.status == 'WAITING_FOR_SPONSOR';
    final code = specials.codeFor(r.id);
    final expiresAt = r.validationExpiresAt;

    return Container(
      width: 240,
      decoration: BoxDecoration(
        gradient: isWaiting
            ? const LinearGradient(
                colors: [Color(0xFFFBF6EC), Color(0xFFF5EAD2)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              )
            : const LinearGradient(
                colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: isWaiting
              ? const Color(0xFFC79A4A).withOpacity(0.55)
              : Colors.transparent,
          width: 1.2,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.05),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: () => _open(context, specials),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      isWaiting
                          ? Icons.storefront_rounded
                          : Icons.verified_rounded,
                      size: 16,
                      color: isWaiting
                          ? const Color(0xFF8A5A00)
                          : Colors.white,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        isWaiting ? r.sponsorName : 'Reward ready!',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w800,
                          color: isWaiting
                              ? const Color(0xFF2F3A32)
                              : Colors.white,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                if (isWaiting)
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(vertical: 9),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: const Color(0xFFC79A4A).withOpacity(0.4),
                      ),
                    ),
                    child: Center(
                      child: Text(
                        code ?? '••••••',
                        style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 6,
                          color: Color(0xFF2F3A32),
                          fontFamily: 'monospace',
                        ),
                      ),
                    ),
                  )
                else
                  Text(
                    formatCents2(
                      r.rewardAmountCents ??
                          r.calculatedDiscountCents +
                              (r.calculatedDiscountCents ~/ 10),
                    ),
                    style: const TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.w900,
                      color: Colors.white,
                    ),
                  ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    if (isWaiting && expiresAt != null) ...[
                      Icon(
                        Icons.timer_outlined,
                        size: 13,
                        color: expiresAt
                                .isBefore(DateTime.now().add(
                                  const Duration(hours: 1),
                                ))
                            ? const Color(0xFFC65A5A)
                            : const Color(0xFFC65A5A),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        'Expires in ${validationCountdownLabel(expiresAt)}',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFFC65A5A),
                        ),
                      ),
                      const Spacer(),
                    ] else
                      const Spacer(),
                    if (isWaiting && r.discountLabel.isNotEmpty)
                      Flexible(
                        child: Text(
                          r.discountLabel,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF8A5A00),
                          ),
                        ),
                      )
                    else if (!isWaiting)
                      Text(
                        'Confirmed — see details',
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: Colors.white.withOpacity(0.85),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}