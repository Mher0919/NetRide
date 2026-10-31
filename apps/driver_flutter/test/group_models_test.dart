import 'package:flutter_test/flutter_test.dart';
import 'package:driver_flutter/models/trip_models.dart' as models;

void main() {
  test('group offer payload is parsed for the incoming request card', () {
    final trip = models.Trip.fromJson({
      'id': 'ride-1',
      'rider_id': 'host',
      'status': 'REQUESTED',
      'pickup': {'lat': 34.0, 'lng': -118.0, 'address': 'First stop'},
      'destination': {'lat': 34.1, 'lng': -118.1, 'address': 'Destination'},
      'is_group': true,
      'group': {
        'id': 'group-1',
        'name': 'Saturday dinner',
        'participantCount': 4,
        'stopCount': 3,
        'pickupSummary': ['A', 'B', 'C'],
        'destinationAddress': 'Destination',
      },
    });
    expect(trip.isGroup, isTrue);
    expect(trip.group?.name, 'Saturday dinner');
    expect(trip.group?.participantCount, 4);
    expect(trip.group?.stopCount, 3);
  });

  test('driver group view exposes the current stop and passenger states', () {
    final view = models.DriverGroupRideView.fromJson({
      'rideId': 'ride-1',
      'groupId': 'group-1',
      'groupName': 'Saturday dinner',
      'groupStatus': 'DRIVER_ASSIGNED',
      'rideStatus': 'ACCEPTED',
      'stops': [
        {
          'sequence': 1,
          'lat': 34.0,
          'lng': -118.0,
          'address': 'Stop one',
          'completed': false,
          'passengers': [
            {'userId': 'host', 'name': 'Alex', 'status': 'JOINED'},
            {'userId': 'friend', 'name': 'Sarah', 'status': 'JOINED'},
          ],
        },
        {
          'sequence': 2,
          'lat': 34.02,
          'lng': -118.02,
          'address': 'Stop two',
          'completed': false,
          'passengers': [
            {'userId': 'friend2', 'name': 'Michael', 'status': 'JOINED'},
          ],
        },
      ],
      'currentStopIndex': 0,
      'destination': {'lat': 34.1, 'lng': -118.1, 'address': 'Destination'},
      'totalDistanceMeters': 12000,
      'totalDurationSeconds': 1800,
      'allPickedUp': false,
    });
    expect(view.currentStop?.sequence, 1);
    expect(view.currentStop?.passengers.length, 2);
    expect(view.currentStop?.passengers.first.isPickedUp, isFalse);
    expect(view.allPickedUp, isFalse);
  });
}
