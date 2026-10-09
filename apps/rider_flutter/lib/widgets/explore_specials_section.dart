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
//   │   └── premium deal cards (photo · discount · name · rating · distance)
//   └── other Explore content
//
// Visibility rule (backend is the source of truth):
//     showSpecials = activeSpecials.isNotEmpty
//
// Tapping a card opens the SAME SpecialBusinessSheet the map markers open
// (spec §13) — no navigation to a separate page.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/specials_provider.dart';
import 'special_business_sheet.dart';
import 'special_card.dart';

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
        // provider.sponsors. Show ONLY the 5 closest, horizontally
        // scrollable — never a random pile of every sponsor. When the list
        // was fetched with a geo origin the backend already ordered it by
        // distance (kmAway ascending); a local sort keeps the guarantee even
        // for coordinate-less refreshes. Zero active specials → zero UI.
        final closest = [...specials.sponsors]
          ..sort(
            (a, b) => (a.kmAway ?? double.infinity).compareTo(
              b.kmAway ?? double.infinity,
            ),
          );
        final active = closest.take(5).toList();
        if (active.isEmpty) return const SizedBox.shrink();

        // Warm the Google photos for visible cards (max 5, once each).
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) specials.hydrateCardPhotos(active);
        });

        final categories = active
            .map((s) => specialCategoryLabel(s.businessType))
            .toSet()
            .toList();
        final selected =
            (_selectedCategory != null &&
                categories.contains(_selectedCategory))
            ? _selectedCategory
            : null;
        final shown = selected == null
            ? active
            : active
                  .where(
                    (s) => specialCategoryLabel(s.businessType) == selected,
                  )
                  .toList();

        return Padding(
          padding: const EdgeInsets.only(top: 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.storefront_rounded,
                    size: 18,
                    color: Color(0xFF5B7760),
                  ),
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
                  color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
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
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 14,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFE3DDD4)),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.storefront_rounded,
                        size: 18,
                        color: Color(0xFF9AA79E),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        'No $selected specials right now',
                        style: TextStyle(
                          fontSize: 12.5,
                          color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
                        ),
                      ),
                    ],
                  ),
                )
              else
                SizedBox(
                  height: 208,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    physics: const BouncingScrollPhysics(),
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    itemCount: shown.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 12),
                    itemBuilder: (context, i) {
                      final s = shown[i];
                      final selectedNow = context.select<SpecialsProvider, bool>(
                        (p) => p.selectedSpecialId == s.id,
                      );
                      return SpecialCard(
                        sponsor: s,
                        selected: selectedNow,
                        onTap: () => SpecialBusinessSheet.show(context, sponsor: s),
                      );
                    },
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
              color: selected
                  ? const Color(0xFF5B7760)
                  : const Color(0xFFD8D2CA),
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
