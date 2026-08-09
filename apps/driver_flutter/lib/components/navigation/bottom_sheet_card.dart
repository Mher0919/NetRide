// apps/driver_flutter/lib/components/navigation/bottom_sheet_card.dart
//
// White palette-matched card that anchors the bottom of the navigation
// view. Shows the destination address, ETA, remaining distance, and
// the active CTA (PICK UP RIDER or COMPLETE TRIP). Stays structurally
// identical to the existing trip_screen bottom sheet — only the data
// binding switches to NavigationService.currentLeg / progress.
//
// Optional chat/call icons live above the CTA so the driver can stay
// in touch with the rider without leaving the navigation view.

import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class BottomSheetCard extends StatelessWidget {
  final String heading; // e.g. "EN ROUTE TO PICKUP"
  final String destinationAddress;
  final String etaLabel; // e.g. "ETA 6 min"
  final String remainingLabel; // e.g. "2.4 mi"
  final String actionLabel; // e.g. "PICK UP RIDER"
  final bool actionEnabled;
  final VoidCallback? onAction;
  final bool showProgress; // true while navigating, false when at-pickup
  final double progressFraction; // 0..1

  /// Optional chat/call actions rendered above the CTA. Pass null to
  /// hide them (e.g. before a trip is active).
  final VoidCallback? onChat;
  final VoidCallback? onCall;
  final bool callActive;

  const BottomSheetCard({
    super.key,
    required this.heading,
    required this.destinationAddress,
    required this.etaLabel,
    required this.remainingLabel,
    required this.actionLabel,
    required this.actionEnabled,
    this.onAction,
    this.showProgress = true,
    this.progressFraction = 0.0,
    this.onChat,
    this.onCall,
    this.callActive = false,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 22),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        border: Border(
          top: BorderSide(color: AppTheme.softBorderColor.withOpacity(0.6)),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.05),
            blurRadius: 16,
            offset: const Offset(0, -4),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 6,
                height: 28,
                decoration: BoxDecoration(
                  color: AppTheme.primaryBrandGreen,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                heading,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                  color: AppTheme.primaryBrandGreen,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            destinationAddress,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 19,
              fontWeight: FontWeight.w700,
              color: AppTheme.secondaryDarkText,
              letterSpacing: -0.3,
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              _Pill(label: etaLabel, icon: Icons.access_time_rounded),
              const SizedBox(width: 8),
              _Pill(
                label: remainingLabel,
                icon: Icons.straighten_rounded,
              ),
              const Spacer(),
              if (onChat != null || onCall != null) _buildCommActions(),
            ],
          ),
          if (showProgress) ...[
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: progressFraction.clamp(0.0, 1.0),
                minHeight: 6,
                backgroundColor: AppTheme.softBorderColor.withOpacity(0.4),
                valueColor: const AlwaysStoppedAnimation(
                    AppTheme.primaryBrandGreen),
              ),
            ),
          ],
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: actionEnabled ? onAction : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: actionEnabled
                    ? AppTheme.primaryBrandGreen
                    : AppTheme.softBorderColor,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 18),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                ),
                textStyle: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.2,
                ),
              ),
              child: Text(actionLabel),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCommActions() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (onChat != null)
          _IconAction(
            tooltip: 'Chat with rider',
            icon: Icons.chat_bubble_outline,
            onTap: onChat!,
          ),
        if (onCall != null) ...[
          const SizedBox(width: 6),
          _IconAction(
            tooltip: 'Call rider',
            icon: callActive
                ? Icons.phone_in_talk_rounded
                : Icons.phone_outlined,
            onTap: callActive ? null : onCall!,
            tinted: callActive,
          ),
        ],
      ],
    );
  }
}

class _IconAction extends StatelessWidget {
  final String tooltip;
  final IconData icon;
  final VoidCallback? onTap;
  final bool tinted;

  const _IconAction({
    required this.tooltip,
    required this.icon,
    required this.onTap,
    this.tinted = false,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Material(
        color: tinted
            ? AppTheme.primaryBrandGreen.withOpacity(0.15)
            : AppTheme.primaryBackground,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 36,
            height: 36,
            child: Icon(
              icon,
              size: 18,
              color: AppTheme.secondaryDarkText,
            ),
          ),
        ),
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  final String label;
  final IconData icon;
  const _Pill({required this.label, required this.icon});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: AppTheme.primaryBackground,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: AppTheme.secondaryDarkText),
          const SizedBox(width: 6),
          Text(
            label,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: AppTheme.secondaryDarkText,
            ),
          ),
        ],
      ),
    );
  }
}
