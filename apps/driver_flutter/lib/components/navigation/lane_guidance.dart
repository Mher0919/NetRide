// apps/driver_flutter/lib/components/navigation/lane_guidance.dart
//
// Horizontal row of lane pictograms. The "active" lane (the one the
// driver should be in) is rendered in sage; others are at 30% opacity
// to keep them visible but clearly de-emphasized.
//
// OSRM's per-lane shape: `{ valid: bool, indications: ['left', ...] }`
// The NavigationScreen flattens these into `LaneGuidance` for us.

import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class LaneGuidance {
  final String indication; // 'left' | 'right' | 'straight' | …
  final bool valid;
  const LaneGuidance({required this.indication, required this.valid});
}

class LaneGuidanceRow extends StatelessWidget {
  final List<LaneGuidance> lanes;
  const LaneGuidanceRow({super.key, required this.lanes});

  @override
  Widget build(BuildContext context) {
    if (lanes.isEmpty) return const SizedBox.shrink();
    return Row(
      mainAxisAlignment: MainAxisAlignment.start,
      children: [
        for (final lane in lanes) _LanePictogram(lane: lane),
      ],
    );
  }
}

class _LanePictogram extends StatelessWidget {
  final LaneGuidance lane;
  const _LanePictogram({required this.lane});

  @override
  Widget build(BuildContext context) {
    final color = lane.valid ? AppTheme.primaryBrandGreen : AppTheme.primaryBrandGreen;
    final opacity = lane.valid ? 1.0 : 0.3;
    return Container(
      width: 38,
      height: 38,
      margin: const EdgeInsets.only(right: 6),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.06),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: color.withOpacity(opacity),
          width: 1.4,
        ),
      ),
      child: Icon(
        _iconFor(lane.indication),
        color: color.withOpacity(opacity),
        size: 22,
      ),
    );
  }

  IconData _iconFor(String indication) {
    switch (indication.toLowerCase()) {
      case 'left':
        return Icons.arrow_back_rounded;
      case 'right':
        return Icons.arrow_forward_rounded;
      case 'straight':
        return Icons.arrow_upward_rounded;
      case 'sharp left':
        return Icons.subdirectory_arrow_left_rounded;
      case 'sharp right':
        return Icons.subdirectory_arrow_right_rounded;
      case 'slight left':
        return Icons.trending_flat_rounded;
      case 'slight right':
        return Icons.trending_flat_rounded;
      case 'uturn':
        return Icons.u_turn_left_rounded;
      default:
        return Icons.arrow_upward_rounded;
    }
  }
}