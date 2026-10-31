// lib/services/app_nav.dart
//
// Cross-screen bottom-navigation requests. Surfaces like the Explore
// SPECIALS header and the Special business sheet need to switch
// MainWrapper's active tab; a singleton notifier avoids threading
// callbacks through the IndexedStack screens.

import 'package:flutter/foundation.dart';

class AppNav extends ChangeNotifier {
  AppNav._();
  static final AppNav instance = AppNav._();

  /// Tab indexes used by MainWrapper.
  static const int explore = 0;
  static const int specials = 1;
  static const int groups = 2;
  static const int activity = 3;
  static const int account = 4;

  int? _pending;

  /// Ask MainWrapper to switch tabs. Always notifies — even when the same
  /// tab is requested twice — so a tap can never be silently swallowed.
  void goToTab(int index) {
    _pending = index;
    notifyListeners();
  }

  /// Called by MainWrapper once it consumed the request.
  int? take() {
    final value = _pending;
    _pending = null;
    return value;
  }
}
