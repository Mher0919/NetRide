// test/speed_monitor_test.dart
//
// Guards the HUD's speed-limit sourcing:
//   * a route without a limit map starts with NO fake limit (the old
//     hard-coded 30 mph was indistinguishable from a real Google limit);
//   * the per-minute Google Roads result fills the HUD when the route has no
//     limit of its own, and a failed lookup keeps the last known value.

import 'package:flutter_test/flutter_test.dart';
import 'package:driver_flutter/services/speed_monitor.dart';

void main() {
  test('route without a speed-limit map does not invent 30 mph', () {
    final limits = SpeedLimitMap.fromRoute(const {});
    expect(limits.limitMph, 0);
    expect(limits.isFreeway, isFalse);
  });

  test('route speed-limit map is used when no external value exists', () {
    final limits = SpeedLimitMap.fromRoute(const {
      'speedLimitsByRoad': {'Main St': 25},
    });
    expect(limits.limitMph, 25);
  });

  test('external Google limit fills the HUD and failure keeps it', () {
    final monitor = SpeedMonitor();
    expect(monitor.hud.value.speedLimitMph, 0);

    monitor.applyExternalLimit(45);
    expect(monitor.hud.value.speedLimitMph, 45);

    // A failed lookup arrives as 0 and must be a no-op.
    monitor.applyExternalLimit(0);
    expect(monitor.hud.value.speedLimitMph, 45);

    monitor.dispose();
  });
}
