import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// App-level sound effects, in addition to the small click + alert
/// system sounds already wired up via [SystemSound]. Backed by MP3
/// assets bundled under `assets/sounds/`. The asset list lives in
/// [_kSoundAssetMap] below; keep the README in that folder in sync.
enum SoundEffect {
  orderAccepted,
  orderCancelled,
  tipReceived,
  tripCompleted,
}

const Map<SoundEffect, String> _kSoundAssetMap = {
  SoundEffect.orderAccepted: 'sounds/order_accepted.mp3',
  SoundEffect.orderCancelled: 'sounds/order_cancelled.mp3',
  SoundEffect.tipReceived: 'sounds/tip_received.mp3',
  SoundEffect.tripCompleted: 'sounds/trip_completed.mp3',
};

/// Centralized sound + haptic feedback service for the app.
///
/// Plays a short click sound (and a light haptic) whenever a button is
/// pressed, plus app-level sound effects (accept, cancel, tip,
/// completed) backed by bundled MP3s via `audioplayers`. The sound
/// can be muted at runtime via [setEnabled] (persisted in
/// SharedPreferences). All audio playback is wrapped in try/catch so
/// a missing/empty asset (the bundled placeholders are 0 bytes) never
/// crashes the UI.
class SoundService extends ChangeNotifier {
  static const String _prefsKey = 'sound_enabled';
  static final SoundService instance = SoundService._();

  SoundService._();

  bool _enabled = true;
  bool get enabled => _enabled;

  // One AudioPlayer per effect, lazily created. Releasing on dispose
  // would be cleaner but the service is a process-lifetime singleton.
  final Map<SoundEffect, AudioPlayer> _players = {};

  /// Loads the persisted preference. Call once at app startup before
  /// building the widget tree.
  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _enabled = prefs.getBool(_prefsKey) ?? true;
  }

  /// Toggle sound effects on or off. The choice is persisted so it
  /// survives restarts.
  Future<void> setEnabled(bool value) async {
    if (_enabled == value) return;
    _enabled = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefsKey, value);
    notifyListeners();
  }

  /// Plays the short click sound + a light haptic pulse. Safe to call
  /// from a build context; swallows platform exceptions so a missing
  /// audio engine never crashes the UI.
  Future<void> playClick({bool haptic = true}) async {
    if (!_enabled) return;
    try {
      // SystemSound.click is the closest thing to a native "tap" tone
      // available without bundling an audio file. On Android the system
      // plays its standard keypress tone; on iOS it plays a soft click;
      // on web/desktop it is a no-op.
      await SystemSound.play(SystemSoundType.click);
    } catch (_) {
      // Ignore — sound is decorative.
    }
    if (haptic) {
      try {
        await HapticFeedback.lightImpact();
      } catch (_) {
        // Haptics not supported on this platform; ignore.
      }
    }
  }

  /// Plays a slightly heavier "alert" sound + a medium haptic. Useful
  /// for confirmations, completed actions, and errors.
  Future<void> playAlert() async {
    if (!_enabled) return;
    try {
      await SystemSound.play(SystemSoundType.alert);
    } catch (_) {}
    try {
      await HapticFeedback.mediumImpact();
    } catch (_) {}
  }

  /// Plays a bundled sound effect. Safe to call from any code path —
  /// the master mute toggle, missing-asset errors, and unsupported
  /// platforms are all handled here.
  Future<void> play(SoundEffect effect) async {
    if (!_enabled) return;
    final path = _kSoundAssetMap[effect];
    if (path == null) return;

    final player = _players[effect] ??= () {
      final p = AudioPlayer(playerId: 'sound_effect_${effect.name}');
      p.setReleaseMode(ReleaseMode.stop);
      return p;
    }();
    try {
      await player.stop();
      await player.play(AssetSource(path));
    } catch (e) {
      // Empty / missing assets throw inside audioplayers. The bundled
      // placeholders are 0-byte on purpose — fail silently so the app
      // never crashes over a decorative sound.
      if (kDebugMode) {
        debugPrint('[SoundService] play(${effect.name}) failed: $e');
      }
    }
  }

  Future<void> playOrderAccepted() => play(SoundEffect.orderAccepted);
  Future<void> playOrderCancelled() => play(SoundEffect.orderCancelled);
  Future<void> playTipReceived() => play(SoundEffect.tipReceived);
  Future<void> playTripCompleted() => play(SoundEffect.tripCompleted);

  /// Stops every effect player. Useful on app teardown or when the
  /// user disables sounds mid-trip.
  Future<void> stopAll() async {
    for (final p in _players.values) {
      try {
        await p.stop();
      } catch (_) {}
    }
  }
}

/// Convenience extension so any widget that already has a `BuildContext`
/// can fire a click sound without importing the service directly.
extension SoundFeedback on BuildContext {
  void playClickSound() => SoundService.instance.playClick();
  void playAlertSound() => SoundService.instance.playAlert();
}

/// Wrapper around [ElevatedButton] that plays the click sound before
/// invoking the user's onPressed. Drop-in replacement for ElevatedButton
/// with the same constructor signature.
class SoundElevatedButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final Widget child;
  final ButtonStyle? style;
  final FocusNode? focusNode;
  final bool autofocus;
  final Clip clipBehavior;

  const SoundElevatedButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.style,
    this.focusNode,
    this.autofocus = false,
    this.clipBehavior = Clip.none,
  });

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: onPressed == null
          ? null
          : () {
              SoundService.instance.playClick();
              onPressed!();
            },
      style: style,
      focusNode: focusNode,
      autofocus: autofocus,
      clipBehavior: clipBehavior,
      child: child,
    );
  }
}

/// Wrapper around [TextButton] that plays the click sound on press.
class SoundTextButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final Widget child;
  final ButtonStyle? style;
  final FocusNode? focusNode;
  final bool autofocus;
  final Clip clipBehavior;

  const SoundTextButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.style,
    this.focusNode,
    this.autofocus = false,
    this.clipBehavior = Clip.none,
  });

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: onPressed == null
          ? null
          : () {
              SoundService.instance.playClick();
              onPressed!();
            },
      style: style,
      focusNode: focusNode,
      autofocus: autofocus,
      clipBehavior: clipBehavior,
      child: child,
    );
  }
}

/// Wrapper around [OutlinedButton] that plays the click sound on press.
class SoundOutlinedButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final Widget child;
  final ButtonStyle? style;
  final FocusNode? focusNode;
  final bool autofocus;
  final Clip clipBehavior;

  const SoundOutlinedButton({
    super.key,
    required this.onPressed,
    required this.child,
    this.style,
    this.focusNode,
    this.autofocus = false,
    this.clipBehavior = Clip.none,
  });

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: onPressed == null
          ? null
          : () {
              SoundService.instance.playClick();
              onPressed!();
            },
      style: style,
      focusNode: focusNode,
      autofocus: autofocus,
      clipBehavior: clipBehavior,
      child: child,
    );
  }
}

/// Wrapper around [IconButton] that plays the click sound on press.
class SoundIconButton extends StatelessWidget {
  final VoidCallback? onPressed;
  final Widget icon;
  final String? tooltip;
  final Color? color;
  final double? iconSize;
  final EdgeInsetsGeometry padding;
  final AlignmentGeometry alignment;
  final double? splashRadius;
  final FocusNode? focusNode;
  final bool autofocus;
  final ButtonStyle? style;
  final MouseCursor? mouseCursor;
  final bool isSelected;

  const SoundIconButton({
    super.key,
    required this.onPressed,
    required this.icon,
    this.tooltip,
    this.color,
    this.iconSize,
    this.padding = const EdgeInsets.all(8),
    this.alignment = Alignment.center,
    this.splashRadius,
    this.focusNode,
    this.autofocus = false,
    this.style,
    this.mouseCursor,
    this.isSelected = false,
  });

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: icon,
      onPressed: onPressed == null
          ? null
          : () {
              SoundService.instance.playClick();
              onPressed!();
            },
      tooltip: tooltip,
      color: color,
      iconSize: iconSize,
      padding: padding,
      alignment: alignment,
      splashRadius: splashRadius,
      focusNode: focusNode,
      autofocus: autofocus,
      style: style,
      mouseCursor: mouseCursor,
      isSelected: isSelected,
    );
  }
}

/// Mixin for [StatefulWidget] states that need to play a click sound
/// from many places without importing the service everywhere. Exposes
/// `playClick()` and `playAlert()` helpers.
mixin SoundFeedbackMixin<T extends StatefulWidget> on State<T> {
  void playClick() => SoundService.instance.playClick();
  void playAlert() => SoundService.instance.playAlert();
}

/// A drop-in widget that wraps the entire app and plays a click sound
/// whenever a `PointerDownEvent` lands on a focusable, tappable, or
/// button-typed widget. This avoids having to wire up the sound at every
/// individual button call site.
///
/// Use it as the root of your [MaterialApp]'s `builder`:
///
/// ```dart
/// MaterialApp(
///   builder: (context, child) =>
///       GlobalClickSoundListener(child: child ?? const SizedBox.shrink()),
/// )
/// ```
class GlobalClickSoundListener extends StatefulWidget {
  final Widget child;
  const GlobalClickSoundListener({super.key, required this.child});

  @override
  State<GlobalClickSoundListener> createState() =>
      _GlobalClickSoundListenerState();
}

class _GlobalClickSoundListenerState extends State<GlobalClickSoundListener> {
  // Pending tap state. When a PointerDown arrives we schedule a click
  // sound with a small delay; if the pointer moves more than
  // [_moveThresholdPx] before then, we cancel — that turns the gesture
  // into a drag/scroll and we don't want to play a sound.
  static const Duration _pendingDelay = Duration(milliseconds: 60);
  static const double _moveThresholdPx = 12;

  final Map<int, _PendingTap> _pending = {};

  void _onPointerDown(PointerDownEvent event) {
    if (event.kind != PointerDeviceKind.touch &&
        event.kind != PointerDeviceKind.mouse &&
        event.kind != PointerDeviceKind.stylus) {
      return;
    }
    _pending[event.pointer] = _PendingTap(
      origin: event.position,
      timer: Timer(_pendingDelay, () {
        if (_pending.remove(event.pointer) != null) {
          SoundService.instance.playClick(haptic: false);
        }
      }),
    );
  }

  void _onPointerMove(PointerMoveEvent event) {
    final p = _pending[event.pointer];
    if (p == null) return;
    if ((event.position - p.origin).distance > _moveThresholdPx) {
      p.timer.cancel();
      _pending.remove(event.pointer);
    }
  }

  void _onPointerEnd(PointerEvent event) {
    final p = _pending.remove(event.pointer);
    p?.timer.cancel();
  }

  @override
  void dispose() {
    for (final p in _pending.values) {
      p.timer.cancel();
    }
    _pending.clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: _onPointerDown,
      onPointerMove: _onPointerMove,
      onPointerUp: _onPointerEnd,
      onPointerCancel: _onPointerEnd,
      child: widget.child,
    );
  }
}

class _PendingTap {
  final Offset origin;
  final Timer timer;
  _PendingTap({required this.origin, required this.timer});
}
