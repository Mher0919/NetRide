// Rider deterministic session-initialization tests.
//
// These cover the states that previously made a freshly registered rider
// indistinguishable from an unverified/failed account:
//   - profile still loading is not treated as a final state,
//   - a failed first load is retryable,
//   - a response for a previous user can never overwrite the current one,
//   - a missing profile (404) signs the stale session out,
//   - no credentials resolve to the unauthenticated state.

import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/providers/session_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> profileFor(String name) => {
      'full_name': name,
      'verification_status': 'PENDING',
      'is_verified': false,
    };

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  test('authoritative profile resolves the session to ready', () async {
    String? token = 'token-a';
    String? userId = 'user-a';
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => token,
      readUserId: () => userId,
      signOut: () async {},
      loadProfile: () async => profileFor('Ada'),
    );

    await provider.initialize();

    expect(provider.status, SessionStatus.ready);
    expect(provider.profile?['full_name'], 'Ada');
    expect(provider.errorMessage, isNull);
  });

  test('profile remains loading until the request completes', () async {
    final completer = Completer<Map<String, dynamic>>();
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async {},
      loadProfile: () => completer.future,
    );

    final pending = provider.initialize();
    expect(provider.status, SessionStatus.loadingProfile);

    completer.complete(profileFor('Ada'));
    await pending;

    expect(provider.status, SessionStatus.ready);
  });

  test('initial failure is retryable and preserves the authenticated session',
      () async {
    var attempt = 0;
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async {},
      loadProfile: () async {
        attempt++;
        if (attempt == 1) throw StateError('offline');
        return profileFor('Ada');
      },
    );

    await provider.initialize();
    expect(provider.status, SessionStatus.failed);
    expect(provider.errorMessage, isNotEmpty);

    await provider.retry();
    expect(provider.status, SessionStatus.ready);
    expect(provider.profile?['full_name'], 'Ada');
    expect(attempt, 2);
  });

  test('a stale response for a previous user is discarded', () async {
    String? token = 'token-a';
    String? userId = 'user-a';
    final first = Completer<Map<String, dynamic>>();
    final second = Completer<Map<String, dynamic>>();
    var call = 0;

    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => token,
      readUserId: () => userId,
      signOut: () async {},
      loadProfile: () {
        call++;
        return call == 1 ? first.future : second.future;
      },
    );

    final firstAttempt = provider.initialize();
    expect(provider.status, SessionStatus.loadingProfile);

    token = 'token-b';
    userId = 'user-b';
    final secondAttempt = provider.initialize(force: true);

    // The previous account finishes late and must not overwrite user B.
    first.complete(profileFor('Old User'));
    await firstAttempt;
    expect(provider.profile, isNull);
    expect(provider.status, SessionStatus.loadingProfile);

    second.complete(profileFor('New User'));
    await secondAttempt;
    expect(provider.profile?['full_name'], 'New User');
    expect(provider.status, SessionStatus.ready);
  });

  test('a returning rider starts from the last authoritative profile offline',
      () async {
    final online = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async {},
      loadProfile: () async => profileFor('Ada'),
    );
    await online.initialize();
    expect(online.status, SessionStatus.ready);

    final offline = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async {},
      loadProfile: () async => throw StateError('offline'),
    );
    await offline.initialize();

    expect(offline.status, SessionStatus.ready);
    expect(offline.profile?['full_name'], 'Ada');
    expect(offline.errorMessage, isNotEmpty);
  });

  test('a brand-new account has no cache fallback and stays retryable',
      () async {
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-new',
      readUserId: () => 'user-new',
      signOut: () async {},
      loadProfile: () async => throw StateError('offline'),
    );

    await provider.initialize();

    expect(provider.status, SessionStatus.failed);
    expect(provider.profile, isNull);
  });

  test('a missing profile (404) signs the stale session out', () async {
    var signedOut = false;
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async => signedOut = true,
      loadProfile: () async {
        throw DioException(
          requestOptions: RequestOptions(path: '/user/profile'),
          response: Response(
            requestOptions: RequestOptions(path: '/user/profile'),
            statusCode: 404,
          ),
        );
      },
    );

    await provider.initialize();

    expect(signedOut, isTrue);
    expect(provider.status, SessionStatus.unauthenticated);
    expect(provider.profile, isNull);
  });

  test('no credentials resolve to unauthenticated without a request',
      () async {
    var calls = 0;
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => null,
      readUserId: () => null,
      signOut: () async {},
      loadProfile: () async {
        calls++;
        return profileFor('Never');
      },
    );

    await provider.initialize();

    expect(provider.status, SessionStatus.unauthenticated);
    expect(calls, 0);
  });

  test('concurrent initialize calls share one attempt', () async {
    var calls = 0;
    final completer = Completer<Map<String, dynamic>>();
    final provider = SessionProvider(
      listenToAuth: false,
      readToken: () => 'token-a',
      readUserId: () => 'user-a',
      signOut: () async {},
      loadProfile: () {
        calls++;
        return completer.future;
      },
    );

    final a = provider.initialize();
    final b = provider.initialize();
    completer.complete(profileFor('Ada'));
    await Future.wait([a, b]);

    expect(calls, 1);
    expect(provider.status, SessionStatus.ready);
  });
}
