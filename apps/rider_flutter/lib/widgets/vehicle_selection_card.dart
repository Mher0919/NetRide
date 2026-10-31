import 'package:flutter/material.dart';
import '../components/animated_price.dart';

/// Shared vehicle-selection card used by the regular checkout and the group
/// ride configuration. Keeping one widget guarantees the group flow never
/// drifts from the existing NetRide ride card.
class VehicleSelectionCard extends StatelessWidget {
  const VehicleSelectionCard({
    super.key,
    required this.fareCents,
    required this.finalCents,
    this.savedCents = 0,
    this.etaMinutes = 0,
    this.showBreakdown = false,
    this.promoLabel,
    this.promoDiscountCents = 0,
    this.specialDiscountCents = 0,
    this.creditsCents = 0,
    this.title = 'NetRide Premium',
    this.subtitle = 'Premium SUV or executive vehicle',
    this.tagline = 'Professional driver · Upfront fare',
    this.readOnly = false,
    this.footer,
  });

  final int fareCents;
  final int finalCents;
  final int savedCents;
  final int etaMinutes;
  final bool showBreakdown;
  final String? promoLabel;
  final int promoDiscountCents;
  final int specialDiscountCents;
  final int creditsCents;
  final String title;
  final String subtitle;
  final String tagline;
  final bool readOnly;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFF5B7760), width: 2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (readOnly) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: const Color(0xFF5B7760),
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Text(
                'HOST CONTROLS BOOKING',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 9.5,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.4,
                ),
              ),
            ),
            const SizedBox(height: 8),
          ],
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.asset(
                  'assets/images/car-logo.png',
                  width: 149,
                  height: 95,
                  fit: BoxFit.contain,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 15,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11.5,
                        color: Colors.grey,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      tagline,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 11,
                        color: Color(0xFF5B7760),
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (etaMinutes > 0)
                      Text(
                        'Est. · ~$etaMinutes min',
                        style: TextStyle(
                          fontSize: 10,
                          color: Colors.grey.shade500,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    const SizedBox(height: 4),
                    if (fareCents > 0)
                      AnimatedPriceReduction(
                        originalCents: fareCents,
                        finalCents: finalCents,
                        savedCents: savedCents,
                        priceStyle: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF2F3A32),
                          letterSpacing: -0.5,
                        ),
                      )
                    else
                      const Text(
                        'Calculating…',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: Color(0xFF5B7760),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (savedCents > 0) ...[
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: SavedBadge(cents: savedCents),
            ),
          ],
          if (showBreakdown && savedCents > 0) ...[
            const SizedBox(height: 10),
            if (promoDiscountCents > 0)
              _row(
                promoLabel == null || promoLabel!.isEmpty
                    ? 'Promo'
                    : 'Promo $promoLabel',
                -promoDiscountCents,
              ),
            if (specialDiscountCents > 0)
              _row('Special discount', -specialDiscountCents),
            if (creditsCents > 0) _row('Ride credits', -creditsCents),
            const SizedBox(height: 8),
            const Divider(height: 1),
            const SizedBox(height: 8),
            _row('You pay', finalCents, bold: true),
          ],
          if (footer != null) ...[
            const SizedBox(height: 10),
            footer!,
          ],
        ],
      ),
    );
  }

  Widget _row(String label, int amount, {bool bold = false}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 12.5,
                fontWeight: bold ? FontWeight.w700 : FontWeight.w500,
                color: Colors.grey.shade700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            amount == 0 ? '' : (amount < 0
                ? '-\$${((-amount) / 100).toStringAsFixed(2)}'
                : '\$${(amount / 100).toStringAsFixed(2)}'),
            style: TextStyle(
              fontSize: bold ? 17 : 12.5,
              fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
              color: const Color(0xFF2F3A32),
            ),
          ),
        ],
      ),
    );
  }
}
