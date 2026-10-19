// Driver production-hardening tests: authoritative trip application with
// stale/duplicate/out-of-order guards, terminal-outcome capture, and
// first-class cancelled state.
//
// These exercise the REAL provider reducer (applyTripUpdate) that the
// socket listener delegates to.

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_flutter/models/trip_models.dart' as models;
import 'package:driver_flutter/providers/driver_provider.dart';

models.Trip trip({
  required String id,
  required models.TripStatus status,
  DateTime? updatedAt,
  String? offerId,
}) {
  return models.Trip(
    id: id,
    riderId: 'rider-1',
    driverId: 'driver-1',
    status: status,
    pickup: models.Location(lat: 1.0, lng: 2.0, address: 'A St'),
    destination: models.Location(lat: 3.0, lng: 4.0, address: 'B St'),
    updatedAt: updatedAt,
    offerId: offerId,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('driver tripUpdate guards', () {
    test('an active trip is never replaced by a different trip id', () {
      final p = DriverProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.status, models.DriverStatus.onTrip);
      expect(p.currentTrip!.id, 't1');

      // Delayed terminal event for a PREVIOUS ride must not pop the driver
      // out of the live ride.
      p.applyTripUpdate(trip(id: 't0', status: models.TripStatus.CANCELLED));
      expect(p.currentTrip!.id, 't1');
      expect(p.status, models.DriverStatus.onTrip);
    });

    test('an older updated_at never regresses a newer state', () {
      final p = DriverProvider();
      final v2 = DateTime.utc(2026, 1, 1, 10, 0, 2);
      final v1 = DateTime.utc(2026, 1, 1, 10, 0, 1);
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.DRIVER_ARRIVING, updatedAt: v2),
      );
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.ACCEPTED, updatedAt: v1),
      );
      expect(p.currentTrip!.status, models.TripStatus.DRIVER_ARRIVING);
    });

    test('DRIVER_ARRIVING is an active state with trip context intact', () {
      final p = DriverProvider();
      p.applyTripUpdate(
        trip(id: 't1', status: models.TripStatus.DRIVER_ARRIVING),
      );
      expect(p.status, models.DriverStatus.onTrip);
      expect(p.currentTrip!.status, models.TripStatus.DRIVER_ARRIVING);
    });

    test('completion captures the terminal payload and clears the trip once',
        () {
      final p = DriverProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS));
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.COMPLETED));
      expect(p.currentTrip, isNull);
      expect(p.lastCompletedTrip!.id, 't1');

      // Duplicate terminal event is ignored (settled id).
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      expect(p.currentTrip, isNull);
    });

    test('cancellation becomes a first-class state with who/why', () {
      final p = DriverProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.ACCEPTED));
      final cancelled = models.Trip(
        id: 't1',
        riderId: 'rider-1',
        driverId: 'driver-1',
        status: models.TripStatus.CANCELLED,
        pickup: models.Location(lat: 1.0, lng: 2.0),
        destination: models.Location(lat: 3.0, lng: 4.0),
        cancelledBy: 'rider-1',
        cancellationReasonCode: 'changed_plans',
      );
      p.applyTripUpdate(cancelled);
      expect(p.currentTrip, isNull);
      expect(p.lastCancelledTrip!.id, 't1');
      expect(p.lastCancelledTrip!.cancellationReasonCode, 'changed_plans');

      // ackCancelled clears the notice; the id stays settled.
      p.ackCancelled();
      expect(p.lastCancelledTrip, isNull);
    });
  });

  group('cold-start REST hydration (socket-independent recovery)', () {
    test('an idle driver adopts the authoritative trip via the shared reducer',
        () {
      final p = DriverProvider();
      expect(p.currentTrip, isNull);
      expect(p.status, models.DriverStatus.offline);

      // hydrateFromServer() funnels REST payloads through this exact reducer
      // path — the app may have been killed before the first tripUpdate, so
      // recovery must work from a completely idle provider.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS));
      expect(p.currentTrip!.id, 't1');
      expect(p.status, models.DriverStatus.onTrip);
    });

    test('a settled trip is never resurrected by hydration', () {
      final p = DriverProvider();
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.COMPLETED));
      expect(p.currentTrip, isNull);

      // A late REST hydration of the same settled ride (e.g. a stale read)
      // must not put the driver back on trip.
      p.applyTripUpdate(trip(id: 't1', status: models.TripStatus.IN_PROGRESS));
      expect(p.currentTrip, isNull);
    });
  });
}
