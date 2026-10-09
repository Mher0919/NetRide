// lib/widgets/special_card.dart
//
// Netride-native Special card: the business photo is the visual anchor, the
// discount is the loudest element, and the whole card opens the reusable
// SpecialBusinessSheet. Imagery priority:
//
//   1. admin cover image (sponsor.coverImageUrl)
//   2. Google business photo (hydrated by SpecialsProvider)
//   3. polished branded gradient fallback (never a broken image)
//
// No Google data is fetched here — the provider warms basic business info
// for at most five visible cards (spec §22/§39).

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/google_business.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';
import '../utils/file_url.dart';

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
/// Always ends in "off" so the rider sees the actual deal ("$5.00 off" /
/// "25% off"), never a bare number.
String specialDiscountLabel(SponsorSpecial s) {
  final label = s.discount.label;
  if (label.isNotEmpty) {
    return label.toLowerCase().endsWith('off') ? label : '$label off';
  }
  if (s.discount.type == 'PERCENT' && s.discount.percent != null) {
    final base = '${s.discount.percent}% off';
    final cap = s.discount.fixedAmountCents;
    return (cap != null && cap > 0)
        ? '$base (up to ${formatCents2(cap)})'
        : base;
  }
  if (s.discount.fixedAmountCents != null && s.discount.fixedAmountCents! > 0) {
    return '${formatCents2(s.discount.fixedAmountCents!)} off';
  }
  return 'Save on your ride';
}

/// Distance / locality copy for a Special: "0.4 mi" when the backend provided
/// a geo origin, otherwise "City, ST" or "Local".
String specialDistanceLabel(SponsorSpecial s) {
  final km = s.kmAway;
  if (km != null && km > 0) {
    final miles = km * 0.621371;
    return '${miles < 10 ? miles.toStringAsFixed(1) : miles.round()} mi';
  }
  final place = [s.city, s.state].where((v) => v?.isNotEmpty ?? false).join(', ');
  return place.isEmpty ? 'Local' : place;
}

class SpecialCard extends StatelessWidget {
  const SpecialCard({
    super.key,
    required this.sponsor,
    required this.onTap,
    this.selected = false,
    this.width = 248,
    this.height = 208,
  });

  final SponsorSpecial sponsor;
  final VoidCallback onTap;
  final bool selected;
  final double width;
  final double height;

  String? _imageUrl(GoogleBusiness? business) {
    final cover = sponsor.coverImageUrl;
    if (cover != null && cover.isNotEmpty) return resolveFileUrl(cover);
    final photos = business?.photos;
    if (photos != null && photos.isNotEmpty) {
      final p = photos.first;
      final url = p.url.isNotEmpty ? p.url : p.thumbUrl;
      if (url.isNotEmpty) return resolveApiUrl(url);
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final business = context.select<SpecialsProvider, GoogleBusiness?>(
      (p) => p.businessFor(sponsor.id)?.business,
    );
    final imageUrl = _imageUrl(business);
    final rating = business?.rating;
    final label = specialDiscountLabel(sponsor);
    final meta = '${specialCategoryLabel(sponsor.businessType)} · ${specialDistanceLabel(sponsor)}';

    return Semantics(
      button: true,
      selected: selected,
      label: 'Special at ${sponsor.businessName}: $label. $meta. Opens details.',
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
        width: width,
        height: height,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: selected ? const Color(0xFFD64545) : Colors.transparent,
            width: 2,
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: selected ? 0.16 : 0.07),
              blurRadius: selected ? 18 : 12,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: Material(
            color: const Color(0xFF2F3A32),
            child: InkWell(
              onTap: onTap,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  _buildBackdrop(imageUrl),
                  const DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Color(0x14000000),
                          Color(0x22000000),
                          Color(0xE6000000),
                        ],
                        stops: [0.0, 0.45, 1.0],
                      ),
                    ),
                  ),
                  Positioned(
                    top: 10,
                    left: 10,
                    child: _DiscountBadge(label: label),
                  ),
                  if (rating != null && rating > 0)
                    Positioned(
                      top: 10,
                      right: 10,
                      child: _RatingBadge(rating: rating),
                    ),
                  Positioned(
                    left: 12,
                    right: 12,
                    bottom: 10,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          sponsor.businessName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w800,
                            color: Colors.white,
                            letterSpacing: -0.2,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          meta,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w500,
                            color: Colors.white.withValues(alpha: 0.78),
                          ),
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Text(
                              'View Special',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w800,
                                color: Colors.white.withValues(alpha: 0.95),
                              ),
                            ),
                            const SizedBox(width: 4),
                            Icon(
                              Icons.arrow_forward_rounded,
                              size: 14,
                              color: Colors.white.withValues(alpha: 0.95),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBackdrop(String? imageUrl) {
    if (imageUrl == null) return _fallback();
    return CachedNetworkImage(
      imageUrl: imageUrl,
      fit: BoxFit.cover,
      fadeInDuration: const Duration(milliseconds: 260),
      placeholder: (_, _) => _fallback(),
      errorWidget: (_, _, _) => _fallback(),
    );
  }

  Widget _fallback() {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF6E8B74), Color(0xFF2F3A32)],
        ),
      ),
      child: Center(
        child: Icon(
          specialTypeIcon(sponsor.businessType),
          size: 40,
          color: Colors.white.withValues(alpha: 0.30),
        ),
      ),
    );
  }
}

class _DiscountBadge extends StatelessWidget {
  const _DiscountBadge({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F4EF),
        borderRadius: BorderRadius.circular(30),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Text(
        label.toUpperCase(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w900,
          letterSpacing: 0.4,
          color: Color(0xFF2F3A32),
        ),
      ),
    );
  }
}

class _RatingBadge extends StatelessWidget {
  const _RatingBadge({required this.rating});
  final double rating;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(30),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.star_rounded, size: 13, color: Color(0xFFFFC94D)),
          const SizedBox(width: 3),
          Text(
            rating.toStringAsFixed(1),
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w800,
              color: Colors.white,
            ),
          ),
        ],
      ),
    );
  }
}
