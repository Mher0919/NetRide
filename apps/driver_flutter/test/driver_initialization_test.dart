// Driver session-initialization tests.
//
// Regression coverage for the post-registration failure mode where unresolved
// profile data was rendered as a definitive "pending/unverified" driver:
//   - authoritative profile fields drive readiness,
//   - a missing verification field is NOT defaulted to PENDING,
//   - a failed first load is retryable and blocks online eligibility,
//   - stale responses for previous identities are discarded,
//   - logout clears all user-scoped state,
//   - a validated cache entry keeps a returning driver usable offline.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_flutter/cache/cache_service.dart';
import 'package:driver_flutter/providers/driver_provider.dart';

Map<String, dynamic> driverProfile({
  String name = 'Ada',
  String? backgroundCheckStatus,
  bool isActive = true,
}) {
  return {
    'full_name': name,
    'is_active': isActive,
    'background_check_status': backgroundCheckStatus,
    'has_pending_profile_change': false,
  };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await CacheService.instance.init(prefs);
    await CacheService.instance.clearAll();
  });

  test('authoritative profile resolves the driver session to ready', () async {
    final provider = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async => driverProfile(
        backgroundCheckStatus: 'APPROVED',
        isActive: true,
      ),
    );

    await provider.initialize();

    expect(provider.initState, DriverInitState.ready);
    expect(provider.profileReady, isTrue);
    expect(provider.isVerified, isTrue);
    expect(provider.verificationStatus, 'APPROVED');
    expect(provider.canGoOnline, isTrue);
    expect(provider.profile?['full_name'], 'Ada');
  });

  test('missing verification data stays unresolved instead of PENDING',
      () async {
    final provider = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async => driverProfile(isActive: false),
    );

    await provider.initialize();

    expect(provider.initState, DriverInitState.ready);
    expect(provider.verificationStatus, isNull);
    expect(provider.buildDriverComplianceStatus(), isNull);
    expect(provider.canGoOnline, isFalse);
  });

  test('initial failure is retryable and never enables online eligibility',
      () async {
    var attempt = 0;
    final provider = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async {
        attempt++;
        if (attempt == 1) throw StateError('offline');
        return driverProfile(
          backgroundCheckStatus: 'APPROVED',
          isActive: true,
        );
      },
    );

    await provider.initialize();
    expect(provider.initState, DriverInitState.failed);
    expect(provider.initErrorMessage, isNotEmpty);
    expect(provider.canGoOnline, isFalse);
    expect(provider.buildDriverComplianceStatus(), isNull);

    await provider.initialize(forceRefresh: true);
    expect(provider.initState, DriverInitState.ready);
    expect(provider.canGoOnline, isTrue);
  });

  test('stale responses for a previous driver are discarded', () async {
    String? token = 'token-a';
    String? userId = 'driver-a';
    final first = Completer<Map<String, dynamic>>();
    final second = Completer<Map<String, dynamic>>();
    var call = 0;

    final provider = DriverProvider(
      tokenReader: () => token,
      userIdReader: () => userId,
      documentLoader: () async => {'requirements': []},
      profileLoader: () {
        call++;
        return call == 1 ? first.future : second.future;
      },
    );

    final firstAttempt = provider.initialize();
    token = 'token-b';
    userId = 'driver-b';
    final secondAttempt = provider.initialize(forceRefresh: true);

    first.complete(driverProfile(name: 'Old Driver'));
    await firstAttempt;
    expect(provider.profile, isNull);
    expect(provider.initState, DriverInitState.loading);

    second.complete(driverProfile(name: 'New Driver'));
    await secondAttempt;
    expect(provider.profile?['full_name'], 'New Driver');
    expect(provider.initState, DriverInitState.ready);
  });

  test('logout reset clears every user-scoped value', () async {
    final provider = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async => driverProfile(
        backgroundCheckStatus: 'APPROVED',
        isActive: true,
      ),
    );

    await provider.initialize();
    expect(provider.canGoOnline, isTrue);

    provider.resetSession();

    expect(provider.initState, DriverInitState.uninitialized);
    expect(provider.profile, isNull);
    expect(provider.isVerified, isFalse);
    expect(provider.verificationStatus, isNull);
    expect(provider.canGoOnline, isFalse);
  });

  test('validated cache keeps a returning driver usable when offline',
      () async {
    final online = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async => driverProfile(
        name: 'Cached Driver',
        backgroundCheckStatus: 'APPROVED',
        isActive: true,
      ),
    );
    await online.initialize();

    final offline = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () async => throw StateError('offline'),
    );
    await offline.initialize();

    expect(offline.initState, DriverInitState.ready);
    expect(offline.profile?['full_name'], 'Cached Driver');
    expect(offline.isVerified, isTrue);
  });

  test('concurrent initialize calls share one attempt', () async {
    var calls = 0;
    final completer = Completer<Map<String, dynamic>>();
    final provider = DriverProvider(
      tokenReader: () => 'token-a',
      userIdReader: () => 'driver-a',
      documentLoader: () async => {'requirements': []},
      profileLoader: () {
        calls++;
        return completer.future;
      },
    );

    final a = provider.initialize();
    final b = provider.initialize();
    completer.complete(driverProfile());
    await Future.wait([a, b]);

    expect(calls, 1);
    expect(provider.initState, DriverInitState.ready);
  });
}
