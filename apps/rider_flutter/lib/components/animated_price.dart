// lib/components/animated_price.dart
//
// Animated price-reduction display: counts the original → discounted price
// down with a tween, strikes through the original, and shows a "You saved"
// badge. Used for both promo codes and ride credits — one shared component
// guarantees parity between the two flows.

import 'package:flutter/material.dart';

class AnimatedPriceReduction extends StatefulWidget {
  const AnimatedPriceReduction({
    super.key,
    required this.originalCents,
    required this.finalCents,
    required this.savedCents,
    this.duration = const Duration(milliseconds: 900),
    this.savedLabel = 'You saved',
    this.priceStyle,
  });

  final int originalCents;
  final int finalCents;
  final int savedCents;
  final Duration duration;
  final String savedLabel;
  final TextStyle? priceStyle;

  @override
  State<AnimatedPriceReduction> createState() => _AnimatedPriceReductionState();
}

class _AnimatedPriceReductionState extends State<AnimatedPriceReduction>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late Animation<double> _countdown;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: widget.duration);
    _countdown = CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic);
    _controller.forward();
  }

  @override
  void didUpdateWidget(AnimatedPriceReduction oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.originalCents != widget.originalCents ||
        oldWidget.finalCents != widget.finalCents) {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  String _fmt(int cents) {
    final dollars = cents / 100;
    return dollars % 1 == 0
        ? '\$${dollars.toStringAsFixed(0)}'
        : '\$${dollars.toStringAsFixed(2)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AnimatedBuilder(
      animation: _countdown,
      builder: (context, _) {
        final delta = widget.originalCents - widget.finalCents;
        final current = widget.originalCents - (delta * _countdown.value).round();
        return Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(
              _fmt(current),
              style: widget.priceStyle ??
                  theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w800,
                    color: theme.colorScheme.primary,
                    letterSpacing: -0.5,
                  ),
            ),
            if (widget.savedCents > 0) ...[
              const SizedBox(width: 10),
              Text(
                _fmt(widget.originalCents),
                style: theme.textTheme.titleMedium?.copyWith(
                  decoration: TextDecoration.lineThrough,
                  decorationColor: Colors.grey.shade500,
                  color: Colors.grey.shade500,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}

/// Small glowing pill used under the price, e.g. "You saved $3.50".
class SavedBadge extends StatelessWidget {
  const SavedBadge({super.key, required this.cents, this.label = 'You saved'});

  final int cents;
  final String label;

  String _fmt(int cents) {
    final dollars = cents / 100;
    return dollars % 1 == 0
        ? '\$${dollars.toStringAsFixed(0)}'
        : '\$${dollars.toStringAsFixed(2)}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (cents <= 0) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            theme.colorScheme.primary.withOpacity(0.16),
            theme.colorScheme.secondary.withOpacity(0.14),
          ],
        ),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: theme.colorScheme.primary.withOpacity(0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.arrow_downward_rounded,
              size: 13, color: theme.colorScheme.primary),
          const SizedBox(width: 3),
          Text(
            '$label ${_fmt(cents)}',
            style: theme.textTheme.labelSmall?.copyWith(
              fontWeight: FontWeight.w700,
              color: theme.colorScheme.primary,
            ),
          ),
        ],
      ),
    );
  }
}
