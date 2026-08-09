// apps/driver_flutter/lib/components/navigation/top_maneuver_card.dart
//
// Dark-forest panel that lives at the top of the navigation view.
// Shows the next maneuver icon, distance-to-maneuver, instruction
// text, and (when OSRM gives us lanes) a horizontal LaneGuidance
// strip. Matches the existing palette (sage / dark-forest / cream).

import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import 'lane_guidance.dart';

class TopManeuverCard extends StatelessWidget {
  final IconData icon;
  final String distanceLabel;
  final String instruction;
  final List<LaneGuidance> lanes;

  const TopManeuverCard({
    super.key,
    required this.icon,
    required this.distanceLabel,
    required this.instruction,
    this.lanes = const [],
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      decoration: BoxDecoration(
        color: AppTheme.secondaryDarkText,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: AppTheme.secondaryDarkText.withOpacity(0.18),
            blurRadius: 24,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBrandGreen.withOpacity(0.18),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(icon, color: Colors.white, size: 32),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      distanceLabel,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 26,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      instruction,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: Colors.white.withOpacity(0.78),
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (lanes.isNotEmpty) ...[
            const SizedBox(height: 14),
            LaneGuidanceRow(lanes: lanes),
          ],
        ],
      ),
    );
  }
}

/// Map an OSRM `maneuver.type` + `maneuver.modifier` to a Material
/// icon. Used by TopManeuverCard and LaneGuidance.
IconData maneuverIcon(String type, String modifier) {
  // `type` is the OSRM verb (turn, depart, arrive, merge, …); modifier
  // is the direction (left, right, slight left, …).
  switch (type) {
    case 'arrive':
      return Icons.flag_rounded;
    case 'depart':
      return Icons.play_arrow_rounded;
    case 'merge':
      return Icons.merge_type_rounded;
    case 'fork':
    case 'end of road':
      return Icons.call_split_rounded;
    case 'roundabout':
    case 'rotary':
      return Icons.roundabout_right_rounded;
    case 'continue':
      return Icons.straight_rounded;
    case 'turn':
      return _turnIcon(modifier);
    case 'new name':
      return Icons.straight_rounded;
    default:
      return Icons.navigation_rounded;
  }
}

IconData _turnIcon(String modifier) {
  switch (modifier) {
    case 'left':
      return Icons.turn_left_rounded;
    case 'right':
      return Icons.turn_right_rounded;
    case 'slight left':
      return Icons.turn_slight_left_rounded;
    case 'slight right':
      return Icons.turn_slight_right_rounded;
    case 'sharp left':
      return Icons.turn_sharp_left_rounded;
    case 'sharp right':
      return Icons.turn_sharp_right_rounded;
    case 'uturn':
      return Icons.u_turn_left_rounded;
    default:
      return Icons.straight_rounded;
  }
}