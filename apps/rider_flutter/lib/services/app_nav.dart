// lib/services/app_nav.dart
//
// Cross-screen bottom-navigation requests. Surfaces like the Explore
// SPECIALS header and the Special business sheet need to switch
// MainWrapper's active tab; a singleton notifier avoids threading
// callbacks through the IndexedStack screens.

import 'package:flutter/foundation.dart';

class AppNav {
  AppNav._();
  static final AppNav instance = AppNav._();

  /// Tab indexes used by MainWrapper.
  static const int explore = 0;
  static const int specials = 1;
  static const int activity = 2;
  static const int account = 3;

  final ValueNotifier<int?> _request = ValueNotifier<int?>(null);
  ValueNotifier<int?> get request => _request;

  void goToTab(int index) => _request.value = index;

  /// Called by MainWrapper once it consumed the request.
  void consume() => _request.value = null;
}
