// apps/rider_flutter/lib/screens/call_overlay.dart
//
// Full-screen call UI shown while a masked call to the driver is
// in-flight. Renders the theme's greens for the primary actions and
// the error red for the end-call button so muscle memory from the rest
// of the app carries over.
//
// The actual audio transport is owned by a Twilio Voice SDK plugin
// (added separately). This widget is the presentation layer — it
// reacts to CommunicationService.callPhase and tells the service when
// the user presses mute/end. The Voice SDK is started/stopped from
// the trip_screen that owns the overlay.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/communication_service.dart';
import '../theme/app_theme.dart';

class CallOverlay extends StatelessWidget {
  final String peerName;

  const CallOverlay({super.key, required this.peerName});

  @override
  Widget build(BuildContext context) {
    return Consumer<CommunicationService>(
      builder: (context, comm, _) {
        // Hide the overlay entirely when the call is idle — the
        // trip_screen will dispose of us via Navigator.pop once it
        // observes `idle` in its own listener. Falling back to a
        // transparent scaffold lets the trip screen stay interactive
        // while the user is being dialled.
        if (comm.callPhase == CallPhase.idle) {
          return const SizedBox.shrink();
        }
        return Material(
          color: Colors.black.withOpacity(0.92),
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Column(
                children: [
                  const Spacer(flex: 2),
                  _buildAvatar(comm),
                  const SizedBox(height: 24),
                  Text(
                    _statusLabel(comm.callPhase),
                    style: const TextStyle(
                      fontSize: 12,
                      letterSpacing: 1.6,
                      fontWeight: FontWeight.w800,
                      color: Colors.white70,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    peerName,
                    style: const TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.w700,
                      color: Colors.white,
                    ),
                  ),
                  const Spacer(flex: 3),
                  _buildControls(comm),
                  const SizedBox(height: 40),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildAvatar(CommunicationService comm) {
    final connected = comm.callPhase == CallPhase.connected;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 350),
      curve: Curves.easeInOut,
      width: connected ? 132 : 120,
      height: connected ? 132 : 120,
      decoration: BoxDecoration(
        color: AppTheme.primaryBrandGreen,
        shape: BoxShape.circle,
        boxShadow: [
          BoxShadow(
            color: AppTheme.primaryBrandGreen.withOpacity(0.4),
            blurRadius: connected ? 36 : 14,
            spreadRadius: connected ? 4 : 0,
          ),
        ],
      ),
      alignment: Alignment.center,
      child: Text(
        _initialsFromName(peerName),
        style: const TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w700,
          fontSize: 44,
        ),
      ),
    );
  }

  Widget _buildControls(CommunicationService comm) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        _CallButton(
          icon: comm.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
          label: comm.muted ? 'Unmute' : 'Mute',
          backgroundColor: AppTheme.lightCardBackground,
          foregroundColor: AppTheme.secondaryDarkText,
          onPressed: comm.callPhase == CallPhase.connected
              ? () => comm.toggleMute()
              : null,
        ),
        _CallButton(
          icon: Icons.call_end_rounded,
          label: 'End',
          backgroundColor: AppTheme.errorColor,
          foregroundColor: Colors.white,
          onPressed: () => comm.endCall(),
        ),
      ],
    );
  }

  String _statusLabel(CallPhase phase) {
    switch (phase) {
      case CallPhase.connecting:
        return 'CONNECTING…';
      case CallPhase.ringing:
        return 'RINGING…';
      case CallPhase.connected:
        return 'IN CALL';
      case CallPhase.ended:
        return 'CALL ENDED';
      case CallPhase.failed:
        return 'CALL FAILED';
      case CallPhase.idle:
        return '';
    }
  }

  String _initialsFromName(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return (parts.first.substring(0, 1) + parts.last.substring(0, 1)).toUpperCase();
  }
}

class _CallButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color backgroundColor;
  final Color foregroundColor;
  final VoidCallback? onPressed;

  const _CallButton({
    required this.icon,
    required this.label,
    required this.backgroundColor,
    required this.foregroundColor,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Opacity(
          opacity: disabled ? 0.5 : 1,
          child: Material(
            color: backgroundColor,
            shape: const CircleBorder(),
            child: InkWell(
              customBorder: const CircleBorder(),
              onTap: onPressed,
              child: SizedBox(
                width: 72,
                height: 72,
                child: Icon(icon, color: foregroundColor, size: 30),
              ),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Text(
          label,
          style: TextStyle(
            color: Colors.white.withOpacity(disabled ? 0.4 : 0.9),
            fontWeight: FontWeight.w600,
            fontSize: 12,
            letterSpacing: 0.4,
          ),
        ),
      ],
    );
  }
}