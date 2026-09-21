// lib/services/ride_intent.dart
//
// Cross-screen "start booking a ride to X" intent. The persistent map
// screen (always mounted inside MainWrapper) listens to this notifier and
// applies the destination + attaches the active special redemption, so the
// rider lands straight in the normal ride-planning flow (route, ride
// options, confirm) instead of a separate redemption page.

import 'package:flutter/foundation.dart';

class SpecialRideIntent {
  final double lat;
  final double lng;
  final String address;
  final String sponsorName;
  final String discountLabel;

  const SpecialRideIntent({
    required this.lat,
    required this.lng,
    required this.address,
    required this.sponsorName,
    required this.discountLabel,
  });
}

class RideIntent {
  RideIntent._();
  static final RideIntent instance = RideIntent._();

  final ValueNotifier<SpecialRideIntent?> _notifier = ValueNotifier(null);

  /// The map screen subscribes to this.
  ValueNotifier<SpecialRideIntent?> get notifier => _notifier;

  /// Ask the map screen to start a ride to this special right now.
  void startSpecialRide(SpecialRideIntent intent) {
    _notifier.value = intent;
  }

  /// Called by the map screen once it consumed the intent.
  void clear() {
    _notifier.value = null;
  }
}
