// lib/screens/specials_screen.dart
//
// "SPECIALS" tab — sponsor discovery + the rider's active redemption card.
// Live updates arrive via the RideProvider socket relay; the provider
// refreshes server state on every transition (spec §27-31).

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../components/state_container.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';

class SpecialsScreen extends StatefulWidget {
  const SpecialsScreen({super.key});

  @override
  State<SpecialsScreen> createState() => _SpecialsScreenState();
}

class _SpecialsScreenState extends State<SpecialsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final provider = context.read<SpecialsProvider>();
      if (!provider.loaded) provider.refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F4EF),
      body: SafeArea(
        child: Consumer<SpecialsProvider>(
          builder: (context, specials, _) {
            if (specials.loading && !specials.loaded) {
              return const Center(child: CircularProgressIndicator());
            }
            if (!specials.loaded && specials.error != null) {
              return StateContainer(
                state: ViewState.failure,
                errorMessage: specials.error,
                onRetry: specials.refresh,
                successWidget: const SizedBox.shrink(),
              );
            }
            return RefreshIndicator(
              onRefresh: specials.refresh,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 32),
                children: [
                  if (!specials.introSeen) _introCard(specials),
                  const SizedBox(height: 20),
                  Text(
                    'SPECIALS',
                    style: TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: const Color(0xFF2F3A32),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Ride, visit the business, and get money back.',
                    style: TextStyle(
                      fontSize: 13,
                      color: const Color(0xFF2F3A32).withOpacity(0.6),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (specials.current != null && specials.current!.isActive)
                    _activeRedemptionCard(specials.current!),
                  const SizedBox(height: 20),
                  if (specials.sponsors.isEmpty)
                    const _EmptyState()
                  else
                    ...specials.sponsors.map(
                        (s) => _sponsorCard(s, specials.canAttachToRide)),
                ],
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _introCard(SpecialsProvider specials) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: const [
              Icon(Icons.percent_rounded, color: Colors.white, size: 22),
              SizedBox(width: 8),
              Text(
                'Save on every visit',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Pick a SPECIAL business, take a ride there, and show your 6-digit '
            'code at the desk. The business confirms the visit and the '
            'discount is applied to your ride.',
            style: TextStyle(
              color: Colors.white.withOpacity(0.85),
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 14),
          Align(
            alignment: Alignment.centerRight,
            child: OutlinedButton(
              onPressed: () => specials.acknowledgeIntro(),
              style: OutlinedButton.styleFrom(
                foregroundColor: Colors.white,
                side: const BorderSide(color: Colors.white54),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(30),
                ),
              ),
              child: const Text('Got it'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _activeRedemptionCard(SpecialRedemption r) {
    final themes = {
      'CREATED': (Icons.event_available_rounded, 'You picked a special'),
      'RIDE_PENDING': (Icons.directions_car_rounded, 'Special ride in progress'),
      'WAITING_FOR_SPONSOR': (Icons.qr_code_2_rounded, 'Show your code'),
      'SPONSOR_VALIDATED': (Icons.check_circle_rounded, 'Confirmed — get your reward'),
      'REWARD_SELECTED': (Icons.check_circle_rounded, 'Reward in progress'),
    };
    final (icon, title) = themes[r.status] ??
        (Icons.local_offer_rounded, 'Special active');
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760),
        borderRadius: BorderRadius.circular(18),
        boxShadow: [
          BoxShadow(
            color: const Color(0xFF2F3A32).withOpacity(0.18),
            blurRadius: 14,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: () => _openRedemption(r),
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Row(
              children: [
                Icon(icon, color: Colors.white, size: 28),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        r.sponsorName,
                        style: TextStyle(
                          color: Colors.white.withOpacity(0.85),
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right_rounded,
                    color: Colors.white70, size: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _openRedemption(SpecialRedemption r) {
    Navigator.of(context).pushNamed('/special-redemption');
  }

  Widget _sponsorCard(SponsorSpecial s, bool canAttach) {
    final disabled = !canAttach;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: () {
            Navigator.of(context).pushNamed(
              '/special-detail',
              arguments: {'id': s.id},
            );
          },
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: const Color(0xFF5B7760).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Icon(
                    _typeIcon(s.businessType),
                    color: const Color(0xFF5B7760),
                    size: 26,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.businessName,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF2F3A32),
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        s.discount.label.isEmpty
                            ? _fallbackLabel(s)
                            : s.discount.label,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF5B7760),
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        [
                          if (s.city?.isNotEmpty ?? false) s.city!,
                          if (s.state?.isNotEmpty ?? false) s.state!,
                        ].join(', '),
                        style: TextStyle(
                          fontSize: 12,
                          color: const Color(0xFF2F3A32).withOpacity(0.55),
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  disabled
                      ? Icons.lock_outline_rounded
                      : Icons.chevron_right_rounded,
                  color: disabled
                      ? const Color(0xFF2F3A32).withOpacity(0.3)
                      : const Color(0xFF2F3A32).withOpacity(0.55),
                  size: 24,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _fallbackLabel(SponsorSpecial s) {
    if (s.discount.type == 'PERCENT') {
      final label = s.discount.percent != null ? '${s.discount.percent}% off' : 'Save';
      if (s.discount.fixedAmountCents != null && s.discount.fixedAmountCents! > 0) {
        return '$label (up to ${formatCents2(s.discount.fixedAmountCents!)})';
      }
      return label;
    }
    if (s.discount.fixedAmountCents != null) {
      return '${formatCents2(s.discount.fixedAmountCents!)} off';
    }
    return 'Save on your ride';
  }

  IconData _typeIcon(String? type) {
    switch (type) {
      case 'RESTAURANT':
        return Icons.restaurant_rounded;
      case 'CAFE':
        return Icons.local_cafe_rounded;
      case 'RETAIL':
        return Icons.shopping_bag_rounded;
      case 'SERVICES':
        return Icons.content_cut_rounded;
      case 'ENTERTAINMENT':
        return Icons.theater_comedy_rounded;
      case 'MEDICAL':
        return Icons.local_hospital_rounded;
      case 'FITNESS':
        return Icons.fitness_center_rounded;
      case 'EDUCATION':
        return Icons.school_rounded;
      case 'EVENTS':
        return Icons.event_rounded;
      case 'OTHER':
        return Icons.storefront_rounded;
      default:
        return Icons.storefront_rounded;
    }
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(28),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Column(
        children: [
          const Icon(Icons.storefront_rounded,
              size: 40, color: Color(0xFF9AA79E)),
          const SizedBox(height: 12),
          const Text(
            'No SPECIALS right now',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Local businesses join all the time — pull down to check again.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 13,
              color: const Color(0xFF2F3A32).withOpacity(0.6),
            ),
          ),
        ],
      ),
    );
  }
}
