// apps/driver_flutter/lib/components/navigation/speed_hud.dart
//
// Top-right card showing current speed + speed limit. The HUD turns
// terracotta (`errorColor`) when the driver is over the limit,
// matching the warnings emitted by both SpeedMonitor and the backend
// SpeedingDetector. Subtle palette, no chrome on the map.

import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';
import '../../services/speed_monitor.dart' show SpeedHud;

class SpeedHudCard extends StatelessWidget {
  final SpeedHud value;
  const SpeedHudCard({super.key, required this.value});

  @override
  Widget build(BuildContext context) {
    final isSpeeding = value.isSpeeding;
    final accent =
        isSpeeding ? AppTheme.errorColor : AppTheme.primaryBrandGreen;
    return Container(
      width: 110,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: isSpeeding ? AppTheme.errorColor : AppTheme.softBorderColor,
          width: isSpeeding ? 1.8 : 1.0,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.08),
            blurRadius: 14,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                '${value.currentMph}',
                style: TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w700,
                  color: accent,
                  letterSpacing: -1,
                ),
              ),
              const SizedBox(width: 4),
              const Text(
                'mph',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.secondaryDarkText,
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          if (value.speedLimitMph > 0)
            Text(
              'Limit ${value.speedLimitMph}',
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w500,
                color: AppTheme.secondaryDarkText.withOpacity(0.7),
              ),
            ),
          if (isSpeeding)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.warning_amber_rounded,
                      size: 12, color: AppTheme.errorColor),
                  const SizedBox(width: 2),
                  const Text(
                    'Slow',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.errorColor,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}