// apps/driver_flutter/lib/components/navigation/routing_options_bar.dart
//
// Lightweight bar that lives just under the top maneuver card. Shows
// the active route's primary road (or "Freeway"/"Local") and a
// single "Refresh route" icon button (manual reroute). Kept minimal
// so it doesn't compete with the maneuver card for attention.

import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class RoutingOptionsBar extends StatelessWidget {
  final String primaryRoad;
  final bool isFreeway;
  final VoidCallback? onRefresh;

  const RoutingOptionsBar({
    super.key,
    required this.primaryRoad,
    required this.isFreeway,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.92),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Row(
        children: [
          Icon(
            isFreeway ? Icons.route_rounded : Icons.alt_route_rounded,
            size: 18,
            color: AppTheme.primaryBrandGreen,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              primaryRoad.isEmpty
                  ? (isFreeway ? 'Freeway' : 'Local route')
                  : primaryRoad,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppTheme.secondaryDarkText,
              ),
            ),
          ),
          IconButton(
            onPressed: onRefresh,
            icon: const Icon(Icons.refresh_rounded),
            iconSize: 20,
            color: AppTheme.secondaryDarkText,
            visualDensity: VisualDensity.compact,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            tooltip: 'Refresh route',
          ),
        ],
      ),
    );
  }
}