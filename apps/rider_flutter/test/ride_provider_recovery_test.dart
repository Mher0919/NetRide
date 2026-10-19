// Rider production-hardening tests: authoritative trip application,
// ordering guards, idempotent request intent, and terminal-state recovery.
//
// These exercise the REAL provider code paths (not renders):
//   - applyTripUpdate: the shared reducer for socket + REST trip payloads.
//   - requestRide: one stable idempotency key per logical intent.
//   - reset/currentTripNone semantics: no stale resurrection.

import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:rider_flutter/models/trip_models.dart' as models;
import 'package:rider_flutter/providers/ride_provider.dart';
import 'package:rider_flutter/services/api_service.dart';
import 'package:rider_flutter/services/secure_token_store.dart';
import 'package:rider_flutter/services/sound_service.dart';

/// Offline adapter so the REST fallback in requestRide fails fast and never
/// reaches a real network from tests.
class _OfflineAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    throw DioException(
      requestOptions: options,
      type: DioExceptionType.connectionError,
      message: 'offline (test)',
    );
  }

  @override
  void close({bool force = false}) {}
}

/// Deterministic REST adapter: matches request paths by substring and serves
/// the configured JSON body. Unknown paths fail like a dead network.
class _JsonAdapter implements HttpClientAdapter {
  _JsonAdapter(this.routes);

  final Map<String, Object?> routes;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    for (final entry in routes.entries) {
      if (options.path.contains(entry.key)) {
        return ResponseBody.fromString(
          jsonEncode(entry.value),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      }
    }
    throw DioException(
      requestOptions: options,
      type: DioExceptionType.connectionError,
      message: 'no route (test)',
    );
  }

  @override
  void close({bool force = false}) {}
}

/// Raw server-shaped trip JSON (snake_case) for hydration tests.
Map<String, Object?> tripJson({
  required String id,
  required models.TripStatus status,
}) {
  return {
    'id': id,
    'rider_id': 'rider-1',
    'driver_id': 'driver-1',
    'status': status.toString().split('.').last,
    'pickup': {'lat': 1.0, 'lng': 2.0, 'address': 'A St'},
    'destination': {'lat': 3.0, 'lng': 4.0, 'address': 'B St'},
    'driver_info': {
      'id': 'driver-1',
      'name': 'Sam',
      'vehicle': 'Volvo',
      'plate': 'ABC123',
    },
    'updated_at': DateTime.utc(2026, 1, 1, 10, 0, 5).toIso8601String(),
  };
}

models.Trip trip({
  required String id,
  required models.TripStatus status,
  DateTime? updatedAt,
  String pickupAddress = 'A St',
  String destinationAddress = 'B St',
}) {
  return models.Trip(
    id: id,
    riderId: 'rider-1',
    driverId: 'driver-1',
    status: status,
    pickup: models.Location(lat: 1.0, lng: 2.0, address: pickupAddress),
    destination:
        models.Location(lat: 3.0, lng: 4.0, address: destinationAddress),
    driverInfo: models.DriverInfo(
      id: 'driver-1',
      name: 'Sam',
      vehicle: 'Volvo',
      plate: 'ABC123',
    ),
    updatedAt: updatedAt,
  );
}

models.Location loc(double lat, double lng) =>
    models.Location(lat: lat, lng: lng);

/// Puts the provider into the optimistic REQUESTED state exactly like the
/// real UI does before the server answers (applyTripUpdate intentionally
/// ignores every payload while IDLE — that guard is asserted separately).
void beginRequest(RideProvider p) => p.requestRide(loc(1, 2), loc(3, 4));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    dotenv.testLoad(fileInput: 'API_BASE_URL=https://example.invalid');
    await ApiService.init();
    ApiService.dio.httpClientAdapter = _OfflineAdapter();
    await SoundService.instance.setEnabled(false);
  });

  group('applyTripUpdate guards', () {
    test('IDLE state ignores stale resurrect payloads', () {
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip, isNull);
      expect(p.status, models.TripStatus.IDLE);
    });

    test('a different trip never replaces the tracked ride', () {
      final p = RideProvider();
      beginRequest(p);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      p.applyTripUpdate(trip(id: 't2', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip!.id, 't1');
      expect(p.tripId, 't1');
    });

    test('an older server version never overwrites a newer state', () {
      final p = RideProvider();
      beginRequest(p);
      final v2 = DateTime.utc(2026, 1, 1, 10, 0, 2);
      final v1 = DateTime.utc(2026, 1, 1, 10, 0, 1);
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.ACCEPTED, updatedAt: v2),
      );
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.DRIVER_ARRIVING, updatedAt: v1),
      );
      expect(p.status, models.TripStatus.ACCEPTED);
    });

    test('a newer server version is applied in order', () {
      final p = RideProvider();
      beginRequest(p);
      final v1 = DateTime.utc(2026, 1, 1, 10, 0, 1);
      final v2 = DateTime.utc(2026, 1, 1, 10, 0, 2);
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.ACCEPTED, updatedAt: v1),
      );
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.DRIVER_ARRIVING, updatedAt: v2),
      );
      expect(p.status, models.TripStatus.DRIVER_ARRIVING);
      expect(p.isPrePickup, isTrue);
    });

    test('terminal state clears the tracked trip id and blocks resurrection',
        () {
      final p = RideProvider();
      beginRequest(p);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.COMPLETED));
      expect(p.tripId, isNull);
      expect(p.currentTrip!.status, models.TripStatus.COMPLETED);

      // A late duplicate ACCEPTED for the settled trip must be ignored.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip!.status, models.TripStatus.COMPLETED);
      expect(p.status, models.TripStatus.COMPLETED);
    });

    test('isPrePickup covers ACCEPTED and DRIVER_ARRIVING, not IN_PROGRESS',
        () {
      final p = RideProvider();
      beginRequest(p);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.isPrePickup, isTrue);
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.DRIVER_ARRIVING),
      );
      expect(p.isPrePickup, isTrue);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS));
      expect(p.isPrePickup, isFalse);
    });
  });

  group('request intent idempotency', () {
    test('repeated requests for the same intent reuse one idempotency key',
        () async {
      final p = RideProvider();
      p.requestRide(loc(1, 2), loc(3, 4), promoCode: 'SAVE10');
      final firstKey = p.pendingRequestKey;
      expect(firstKey, isNotNull);

      // A retry (double tap / failure retry) must reuse the SAME key so the
      // server can never create a second ride from one intent.
      p.requestRide(loc(1, 2), loc(3, 4), promoCode: 'SAVE10');
      expect(p.pendingRequestKey, firstKey);

      p.retryPendingRequest();
      expect(p.pendingRequestKey, firstKey);
    });

    test('a new request after a terminal ride gets a fresh key', () {
      final p = RideProvider();
      p.requestRide(loc(1, 2), loc(3, 4));
      final firstKey = p.pendingRequestKey;

      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.COMPLETED));
      expect(p.pendingRequestKey, isNull);

      p.requestRide(loc(5, 6), loc(7, 8));
      expect(p.pendingRequestKey, isNotNull);
      expect(p.pendingRequestKey, isNot(firstKey));
    });

    test('requesting while a match is already running is ignored', () {
      final p = RideProvider();
      beginRequest(p);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.REQUESTED));
      expect(p.isSearchingForDriver, isTrue);

      p.requestRide(loc(9, 9), loc(8, 8));
      // Still the same matching ride — no second intent was created.
      expect(p.tripId, 't1');
      expect(p.pendingRequestKey, isNull);
    });
  });

  group('reset semantics', () {
    test('reset settles the trip and clears pending request tracking', () {
      final p = RideProvider();
      beginRequest(p);
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      p.reset();
      expect(p.status, models.TripStatus.IDLE);
      expect(p.tripId, isNull);
      expect(p.currentTrip, isNull);
      expect(p.pendingRequestKey, isNull);

      // Late events for the settled trip cannot resurrect it.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip, isNull);
    });
  });

  group('cold-start REST hydration (socket-independent recovery)', () {
    setUp(() async {
      // Seed an in-memory session: hydration refuses to run without a token
      // (it would otherwise adopt a stranger's ride). The secure-storage
      // plugin is unavailable in unit tests; init() hydrates the mirror from
      // the legacy prefs values and swallows the storage write failure.
      SharedPreferences.setMockInitialValues({
        'jwt_token': 'test-token',
        'user_id': 'rider-1',
        'user_role': 'RIDER',
      });
      await SecureTokenStore.init();
    });

    test('an IDLE provider adopts the authoritative active trip over REST',
        () async {
      ApiService.dio.httpClientAdapter = _JsonAdapter({
        '/ride/current': {'trip': tripJson(id: 't1', status: models.TripStatus.IN_PROGRESS)},
        '/navigation/cached': {'route': null},
      });
      final p = RideProvider();
      final adopted = await p.hydrateFromServer();

      expect(adopted, isTrue);
      expect(p.status, models.TripStatus.IN_PROGRESS);
      expect(p.tripId, 't1');
      expect(p.currentTrip!.id, 't1');
      expect(p.driver!.id, 'driver-1');
    });

    test('authoritative "no active trip" clears a stale local belief',
        () async {
      ApiService.dio.httpClientAdapter = _JsonAdapter({
        '/ride/current': {'trip': null},
      });
      final p = RideProvider();
      // Adopt a trip first (as a killed app would on restart).
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED), null, true);
      expect(p.tripId, 't1');

      final adopted = await p.hydrateFromServer();
      expect(adopted, isFalse);
      expect(p.status, models.TripStatus.IDLE);
      expect(p.tripId, isNull);
      expect(p.currentTrip, isNull);
    });

    test('hydration bypasses the IDLE guard only for authoritative payloads',
        () async {
      final p = RideProvider();
      // Ordinary socket payloads never resurrect IDLE state.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip, isNull);

      // Hydration is exactly the authoritative answer that ends IDLE.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED), null, true);
      expect(p.currentTrip!.id, 't1');
      expect(p.tripId, 't1');
    });

    test('a failing REST call keeps the local state untouched', () async {
      ApiService.dio.httpClientAdapter = _OfflineAdapter();
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED), null, true);

      final adopted = await p.hydrateFromServer();
      expect(adopted, isFalse);
      expect(p.currentTrip!.id, 't1');
    });
  });

  group('driver connectivity (mid-ride connection-lost signal)', () {
    test('offline/online events drive the banner state for the tracked trip',
        () {
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS), null, true);
      expect(p.driverOffline, isFalse);

      p.applyDriverConnectivity({'tripId': 't1', 'connected': false});
      expect(p.driverOffline, isTrue);

      p.applyDriverConnectivity({'tripId': 't1', 'connected': true});
      expect(p.driverOffline, isFalse);
    });

    test('duplicate events do not notify twice', () {
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS), null, true);
      var notifications = 0;
      p.addListener(() => notifications++);

      p.applyDriverConnectivity({'tripId': 't1', 'connected': false});
      p.applyDriverConnectivity({'tripId': 't1', 'connected': false});
      expect(notifications, 1);
      expect(p.driverOffline, isTrue);
    });

    test('events for a different trip are ignored', () {
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS), null, true);
      p.applyDriverConnectivity({'tripId': 'other', 'connected': false});
      expect(p.driverOffline, isFalse);
    });

    test('a settled trip clears the offline flag', () {
      final p = RideProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS), null, true);
      p.applyDriverConnectivity({'tripId': 't1', 'connected': false});
      expect(p.driverOffline, isTrue);

      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.COMPLETED));
      expect(p.driverOffline, isFalse);
    });
  });
}
