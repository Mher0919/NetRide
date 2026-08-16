// lib/widgets/explore_specials_section.dart
//
// SPECIALS inside EXPLORE (spec: no standalone Specials tab).
//
// Rendered by the Explore (map) screen as a conditional section:
//
//   EXPLORE
//   ├── Search / Map / Recents
//   ├── SPECIALS                      ← this widget (hidden when 0 active)
//   │   ├── category filter chips
//   │   └── deal cards (name · type · distance · discount)
//   └── other Explore content
//
// Visibility rule (backend is the source of truth):
//     showSpecials = activeSpecials.isNotEmpty
//
// The widget renders NOTHING — no heading, no placeholder, no empty card —
// when the backend's eligible-special list is empty. The same eligible list
// drives the map sponsor markers (map_screen.dart), so both surfaces always
// agree. Filtering operates ONLY on that eligible list: an inactive sponsor
// can never resurface through a filter chip.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';

/// Friendly category label for a sponsor business type (spec: Food, Drink,
/// Club, Cafe, Shopping, Entertainment…). Unknown types get the raw value.
String specialCategoryLabel(String? type) {
  if (type == null || type.isEmpty) return 'Other';
  const labels = {
    'RESTAURANT': 'Food',
    'BAR': 'Drink',
    'CLUB': 'Club',
    'CAFE': 'Cafe',
    'RETAIL': 'Shopping',
    'SHOPPING': 'Shopping',
    'ENTERTAINMENT': 'Entertainment',
    'EVENTS': 'Events',
    'SERVICES': 'Services',
    'MEDICAL': 'Medical',
    'FITNESS': 'Fitness',
    'EDUCATION': 'Education',
    'AUTO': 'Auto',
    'OTHER': 'Other',
  };
  return labels[type] ?? type;
}

IconData specialTypeIcon(String? type) {
  switch (type) {
    case 'RESTAURANT':
      return Icons.restaurant_rounded;
    case 'CAFE':
      return Icons.local_cafe_rounded;
    case 'RETAIL':
    case 'SHOPPING':
      return Icons.shopping_bag_rounded;
    case 'SERVICES':
      return Icons.content_cut_rounded;
    case 'CLUB':
    case 'ENTERTAINMENT':
    case 'EVENTS':
      return Icons.theater_comedy_rounded;
    case 'MEDICAL':
      return Icons.local_hospital_rounded;
    case 'FITNESS':
      return Icons.fitness_center_rounded;
    case 'EDUCATION':
      return Icons.school_rounded;
    case 'AUTO':
      return Icons.directions_car_rounded;
    default:
      return Icons.storefront_rounded;
  }
}

/// Discount copy straight from backend-configured values (never hardcoded).
String specialDiscountLabel(SponsorSpecial s) {
  final label = s.discount.label;
  if (label.isNotEmpty) return label;
  if (s.discount.type == 'PERCENT' && s.discount.percent != null) {
    final base = '${s.discount.percent}% off';
    final cap = s.discount.fixedAmountCents;
    return (cap != null && cap > 0) ? '$base (up to ${formatCents2(cap)})' : base;
  }
  if (s.discount.fixedAmountCents != null && s.discount.fixedAmountCents! > 0) {
    return '${formatCents2(s.discount.fixedAmountCents!)} off';
  }
  return 'Save on your ride';
}

class ExploreSpecialsSection extends StatefulWidget {
  const ExploreSpecialsSection({super.key});

  @override
  State<ExploreSpecialsSection> createState() => _ExploreSpecialsSectionState();
}

class _ExploreSpecialsSectionState extends State<ExploreSpecialsSection> {
  /// Currently selected category label (null = show all active specials).
  String? _selectedCategory;

  @override
  Widget build(BuildContext context) {
    return Consumer<SpecialsProvider>(
      builder: (context, specials, _) {
        // Backend-authoritative: only ACTIVE eligible specials live in
        // provider.sponsors. Zero active specials → zero SPECIALS UI.
        final active = specials.sponsors;
        if (active.isEmpty) return const SizedBox.shrink();

        final categories = active
            .map((s) => specialCategoryLabel(s.businessType))
            .toSet()
            .toList();
        final selected = (_selectedCategory != null && categories.contains(_selectedCategory))
            ? _selectedCategory
            : null;
        final shown = selected == null
            ? active
            : active.where((s) => specialCategoryLabel(s.businessType) == selected).toList();

        return Padding(
          padding: const EdgeInsets.only(top: 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.storefront_rounded, size: 18, color: Color(0xFF5B7760)),
                  const SizedBox(width: 8),
                  Text(
                    'SPECIALS',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                      color: const Color(0xFF2F3A32),
                    ),
                  ),
                  const Spacer(),
                  Text(
                    '${active.length} active deal${active.length == 1 ? '' : 's'}',
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w600,
                      color: const Color(0xFF5B7760),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              Text(
                'Ride there, get money back.',
                style: TextStyle(
                  fontSize: 12,
                  color: const Color(0xFF2F3A32).withOpacity(0.6),
                ),
              ),
              if (categories.isNotEmpty) ...[
                const SizedBox(height: 10),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      _FilterChipLabel(
                        label: 'All',
                        selected: selected == null,
                        onTap: () => setState(() => _selectedCategory = null),
                      ),
                      for (final c in categories) ...[
                        const SizedBox(width: 8),
                        _FilterChipLabel(
                          label: c,
                          selected: selected == c,
                          onTap: () => setState(() => _selectedCategory = c),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 12),
              if (shown.isEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE3DDD4)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.storefront_rounded, size: 18, color: Color(0xFF9AA79E)),
                      const SizedBox(width: 10),
                      Text(
                        'No $selected specials right now',
                        style: TextStyle(
                          fontSize: 12.5,
                          color: const Color(0xFF2F3A32).withOpacity(0.6),
                        ),
                      ),
                    ],
                  ),
                )
              else
                SizedBox(
                  height: 118,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    physics: const BouncingScrollPhysics(),
                    itemCount: shown.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 10),
                    itemBuilder: (context, i) => _SponsorDealCard(sponsor: shown[i]),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _FilterChipLabel extends StatelessWidget {
  const _FilterChipLabel({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? const Color(0xFF5B7760) : Colors.white,
      borderRadius: BorderRadius.circular(30),
      child: InkWell(
        borderRadius: BorderRadius.circular(30),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(30),
            border: Border.all(
              color: selected ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA),
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : const Color(0xFF2F3A32),
            ),
          ),
        ),
      ),
    );
  }
}

class _SponsorDealCard extends StatelessWidget {
  const _SponsorDealCard({required this.sponsor});

  final SponsorSpecial sponsor;

  String _distanceLabel() {
    final km = sponsor.kmAway;
    if (km != null && km > 0) {
      final miles = km * 0.621371;
      return '${miles < 10 ? miles.toStringAsFixed(1) : miles.round()} mi';
    }
    final place = [sponsor.city, sponsor.state]
        .where((v) => v?.isNotEmpty ?? false)
        .join(', ');
    return place.isEmpty ? 'Local' : place;
  }

  String _typeAndDistance() {
    final type = specialCategoryLabel(sponsor.businessType);
    return '$type · ${_distanceLabel()}';
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 236,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE3DDD4)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.04),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: () {
            Navigator.of(context).pushNamed(
              '/special-detail',
              arguments: {'id': sponsor.id},
            );
          },
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(
                      width: 38,
                      height: 38,
                      decoration: BoxDecoration(
                        color: const Color(0xFF5B7760).withOpacity(0.12),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Icon(
                        specialTypeIcon(sponsor.businessType),
                        color: const Color(0xFF5B7760),
                        size: 20,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            sponsor.businessName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 13.5,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF2F3A32),
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            _typeAndDistance(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11.5,
                              color: const Color(0xFF2F3A32).withOpacity(0.55),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  specialDiscountLabel(sponsor),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF5B7760),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
