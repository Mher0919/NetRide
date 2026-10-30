import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/auth_service.dart';
import '../services/error_handler.dart';
import '../services/secure_token_store.dart';
import '../services/user_service.dart';

/// Deterministic authenticated-session state for the rider app.
///
/// The app must never treat "profile has not loaded yet" as a definitive
/// account state (unverified / incomplete / unauthorized). This provider is
/// the single gate between "we have credentials" and "the authenticated
/// shell may render":
///
///   restoring -> loadingProfile -> ready
///                                -> failed (retryable)
///              -> unauthenticated
///
/// Requests are generation-scoped and identity-scoped: a response for a
/// previous user (or an older attempt) is ignored instead of overwriting the
/// current session.
enum SessionStatus { restoring, unauthenticated, loadingProfile, ready, failed }

typedef ProfileLoader = Future<Map<String, dynamic>> Function();
typedef TokenReader = String? Function();
typedef SignOutCallback = Future<void> Function();

class SessionProvider extends ChangeNotifier {
  SessionProvider({
    ProfileLoader? loadProfile,
    TokenReader? readToken,
    TokenReader? readUserId,
    SignOutCallback? signOut,
    bool listenToAuth = true,
  })  : _loadProfile = loadProfile ?? UserService.getProfile,
        _readToken = readToken ?? (() => SecureTokenStore.token),
        _readUserId = readUserId ?? (() => SecureTokenStore.userId),
        _signOut = signOut ?? AuthService.logout,
        _listenToAuth = listenToAuth {
    if (_listenToAuth) {
      AuthService.isAuthenticatedNotifier.addListener(_onAuthChanged);
      _onAuthChanged();
    } else {
      _status = SessionStatus.restoring;
    }
  }

  final ProfileLoader _loadProfile;
  final TokenReader _readToken;
  final TokenReader _readUserId;
  final SignOutCallback _signOut;
  final bool _listenToAuth;

  static const _profileCachePrefix = 'session_profile_v1:';
  static const _profileCacheMaxAge = Duration(days: 7);

  SessionStatus _status = SessionStatus.restoring;
  Map<String, dynamic>? _profile;
  String? _profileUserId;
  String? _errorMessage;
  int _generation = 0;
  Future<void>? _inFlight;

  SessionStatus get status => _status;
  Map<String, dynamic>? get profile => _profile;
  String? get errorMessage => _errorMessage;
  bool get isReady => _status == SessionStatus.ready;
  bool get isBusy =>
      _status == SessionStatus.restoring ||
      _status == SessionStatus.loadingProfile;

  /// Loads the authoritative profile for the current credentials.
  ///
  /// Concurrent calls share the same attempt. [force] starts a new attempt
  /// and invalidates any older response that is still in flight.
  Future<void> initialize({bool force = false}) {
    final existing = _inFlight;
    if (existing != null && !force) return existing;
    final future = _load();
    _inFlight = future;
    future.whenComplete(() {
      if (identical(_inFlight, future)) _inFlight = null;
    });
    return future;
  }

  Future<void> retry() => initialize(force: true);

  void _onAuthChanged() {
    if (AuthService.isAuthenticatedNotifier.value) {
      initialize(force: true);
    } else {
      _applyUnauthenticated();
    }
  }

  Future<void> _load() async {
    final token = _readToken();
    if (token == null || token.isEmpty) {
      _applyUnauthenticated();
      return;
    }

    final generation = ++_generation;
    final userId = _readUserId();
    final userChanged =
        _profileUserId != null && userId != null && _profileUserId != userId;

    if (userChanged) {
      _profile = null;
      _profileUserId = null;
    }
    _errorMessage = null;
    _status = SessionStatus.loadingProfile;
    notifyListeners();

    try {
      final profile = await _loadProfile();
      if (!_isCurrent(generation, token, userId)) {
        debugPrint('[SESSION] Ignoring stale profile response');
        return;
      }
      _profile = profile;
      _profileUserId = userId;
      _errorMessage = null;
      _status = SessionStatus.ready;
      // Cache the last authoritative profile so a returning rider can still
      // start the app if the backend is temporarily unreachable. A brand-new
      // account has no entry here, so a failed first load remains a
      // recoverable error instead of a half-initialized shell.
      await _writeCachedProfile(userId, profile);
      notifyListeners();
    } catch (e) {
      if (!_isCurrent(generation, token, userId)) {
        debugPrint('[SESSION] Ignoring stale profile error');
        return;
      }

      if (e is DioException && e.response?.statusCode == 404) {
        await _signOut();
        if (generation != _generation) return;
        _applyUnauthenticated();
        return;
      }

      // Keep an existing, already-authoritative profile usable during a
      // transient revalidation failure. An initial load failure falls back to
      // the last cached authoritative profile, when one exists.
      if (_profile != null && !userChanged) {
        _errorMessage = ErrorHandler.friendly(
          e,
          fallback: 'We could not refresh your account. Pull to retry.',
        );
        _status = SessionStatus.ready;
        notifyListeners();
        return;
      }

      final cached = await _readCachedProfile(userId);
      if (cached != null && _isCurrent(generation, token, userId)) {
        _profile = cached;
        _profileUserId = userId;
        _errorMessage = ErrorHandler.friendly(
          e,
          fallback: 'Using your last saved account details until we reconnect.',
        );
        _status = SessionStatus.ready;
        notifyListeners();
        return;
      }

      _errorMessage = ErrorHandler.friendly(
        e,
        fallback: 'We could not finish setting up your account. Please try again.',
      );
      _status = SessionStatus.failed;
      notifyListeners();
    }
  }

  bool _isCurrent(int generation, String token, String? userId) {
    if (generation != _generation) return false;
    if (_readToken() != token) return false;
    final currentUserId = _readUserId();
    if (userId != null && currentUserId != null && currentUserId != userId) {
      return false;
    }
    return true;
  }

  void _applyUnauthenticated() {
    final previousUserId = _profileUserId;
    _generation++;
    _profile = null;
    _profileUserId = null;
    _errorMessage = null;
    _status = SessionStatus.unauthenticated;
    if (previousUserId != null) {
      unawaited(_removeCachedProfile(previousUserId));
    }
    notifyListeners();
  }

  Future<void> _writeCachedProfile(
    String? userId,
    Map<String, dynamic> profile,
  ) async {
    if (userId == null || userId.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(
        '$_profileCachePrefix$userId',
        jsonEncode({
          'cached_at': DateTime.now().toUtc().toIso8601String(),
          'profile': profile,
        }),
      );
    } catch (e) {
      debugPrint('[SESSION] Profile cache write failed: $e');
    }
  }

  Future<Map<String, dynamic>?> _readCachedProfile(String? userId) async {
    if (userId == null || userId.isEmpty) return null;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('$_profileCachePrefix$userId');
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final cachedAt = DateTime.tryParse(decoded['cached_at']?.toString() ?? '');
      if (cachedAt == null ||
          DateTime.now().toUtc().difference(cachedAt) > _profileCacheMaxAge) {
        await prefs.remove('$_profileCachePrefix$userId');
        return null;
      }
      final profile = decoded['profile'];
      if (profile is! Map) return null;
      return Map<String, dynamic>.from(profile);
    } catch (e) {
      debugPrint('[SESSION] Profile cache read failed: $e');
      return null;
    }
  }

  Future<void> _removeCachedProfile(String userId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('$_profileCachePrefix$userId');
    } catch (e) {
      debugPrint('[SESSION] Profile cache clear failed: $e');
    }
  }

  @override
  void dispose() {
    if (_listenToAuth) {
      AuthService.isAuthenticatedNotifier.removeListener(_onAuthChanged);
    }
    super.dispose();
  }
}
