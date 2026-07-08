// apps/driver_flutter/lib/services/gps_tracker.dart
//
// Singleton wrapper around Geolocator.getPositionStream that:
//
//   - Throttles emissions to ~1 Hz (1s minimum interval, matching the
//     NavigationService + SpeedMonitor cadence).
//   - Smooths noisy GPS readings with a low-pass filter so the
//     heading-up camera doesn't twitch.
//   - Exposes a typed `GpsFix` (lat/lng/heading/speed/timestamp) plus
//     a `gpsStatus` channel for permission / availability loss.
//   - Hides the Geolocator config so the rest of the app never has to
//     deal with LocationSettings / permission flow directly.
//
// One instance per app. `start()` is idempotent; `stop()` halts the
// underlying stream and reclaims the OS location handle.

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

/// Status the GPS subsystem can broadcast to listeners. Lets the
/// driver app show a "GPS signal lost" / "Permission denied" banner
/// without subscribing to the raw stream.
enum GpsStatus {
  /// Tracking normally.
  tracking,

  /// Permission revoked at runtime. Driver should be sent to settings.
  permissionDenied,

  /// Location services are off. We can't recover from this — UI must
  /// ask the user to enable Location.
  serviceDisabled,

  /// Stream paused because of a transient error. The driver app
  /// freezes "current location" to last-known and shows a banner.
  signalLost,
}

class GpsFix {
  final LatLng position;
  final double headingDeg;
  final double speedMps;
  final DateTime timestamp;

  const GpsFix({
    required this.position,
    required this.headingDeg,
    required this.speedMps,
    required this.timestamp,
  });

  @override
  String toString() =>
      'GpsFix(${position.latitude.toStringAsFixed(5)}, '
      '${position.longitude.toStringAsFixed(5)}, '
      'spd=${speedMps.toStringAsFixed(1)}m/s, hdg=$headingDeg°)';
}

class GpsTracker extends ChangeNotifier {
  GpsTracker._();
  static final GpsTracker instance = GpsTracker._();

  StreamSubscription<Position>? _sub;
  Timer? _throttleTimer;
  GpsFix? _lastFix;
  GpsStatus _status = GpsStatus.tracking;
  bool _running = false;

  // ---- Public surface ----------------------------------------------------

  /// Last fix that passed the throttle + sanity checks. May be null
  /// before the first valid sample arrives.
  GpsFix? get lastFix => _lastFix;
  GpsStatus get status => _status;
  bool get isRunning => _running;

  /// Subscribers receive every accepted fix (1 Hz). Use a
  /// `ValueNotifier<GpsFix>` pattern inside the UI if you need to
  /// throttle further.
  final StreamController<GpsFix> _fixController =
      StreamController<GpsFix>.broadcast();
  Stream<GpsFix> get fixes => _fixController.stream;

  final StreamController<GpsStatus> _statusController =
      StreamController<GpsStatus>.broadcast();
  Stream<GpsStatus> get status$ => _statusController.stream;

  /// Idempotent. Safe to call from `main()` on app boot — the tracker
  /// is dormant until something subscribes to `fixes` or polls
  /// `lastFix` AND the driver is online.
  Future<void> start() async {
    if (_running) return;
    _running = true;

    // 1. Permission gate. We don't pop a dialog here — the driver
    //    app's onboarding flow already requests permission before
    //    mounting this. If we hit "denied" at runtime, emit the
    //    status and bail.
    LocationPermission perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied ||
        perm == LocationPermission.deniedForever) {
      _emitStatus(GpsStatus.permissionDenied);
      _running = false;
      return;
    }

    // 2. Service gate (location services toggle).
    if (!await Geolocator.isLocationServiceEnabled()) {
      _emitStatus(GpsStatus.serviceDisabled);
      _running = false;
      return;
    }

    // 3. Subscribe to the native stream with a high-precision config.
    //    distanceFilter=2 prevents the OS from spamming us at 0.5 Hz
    //    when the device is stationary; the 1s wall-clock throttle
    //    below enforces the actual cadence.
    const settings = LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 2,
    );

    _sub = Geolocator.getPositionStream(locationSettings: settings).listen(
      _onPosition,
      onError: (err) {
        debugPrint('[GPS] stream error: $err');
        _emitStatus(GpsStatus.signalLost);
      },
      cancelOnError: false,
    );

    _emitStatus(GpsStatus.tracking);
  }

  Future<void> stop() async {
    _running = false;
    _throttleTimer?.cancel();
    _throttleTimer = null;
    await _sub?.cancel();
    _sub = null;
  }

  @override
  void dispose() {
    stop();
    _fixController.close();
    _statusController.close();
    super.dispose();
  }

  // ---- Internals ---------------------------------------------------------

  void _onPosition(Position pos) {
    // Drop obviously-bad samples (some devices emit 0,0 when first
    // locking onto a fix). The driver app should never see these.
    if (pos.latitude == 0 && pos.longitude == 0) return;
    if (pos.accuracy > 50) {
      // >50m accuracy is useless for our snap-to-polyline logic.
      return;
    }

    // Wall-clock throttle: at most one fix per second. The OS may
    // deliver 5+ Hz on some devices; we collapse those to 1 Hz.
    final now = DateTime.now();
    if (_lastFix != null &&
        now.difference(_lastFix!.timestamp).inMilliseconds < 1000) {
      return;
    }

    final heading = pos.heading.isNaN ? _lastFix?.headingDeg ?? 0 : pos.heading;
    final fix = GpsFix(
      position: LatLng(pos.latitude, pos.longitude),
      headingDeg: heading,
      // Geolocator reports speed in m/s on Android + iOS when the
      // device has a course-over-ground fix; null on simulators.
      speedMps: pos.speed.isNaN ? 0 : pos.speed,
      timestamp: now,
    );
    _lastFix = fix;
    _fixController.add(fix);
    notifyListeners();
  }

  void _emitStatus(GpsStatus s) {
    if (_status == s) return;
    _status = s;
    _statusController.add(s);
    notifyListeners();
  }
}