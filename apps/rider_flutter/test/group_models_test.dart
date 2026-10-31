import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/models/group_models.dart';
import 'package:rider_flutter/widgets/vehicle_selection_card.dart';

void main() {
  group('group model parsing', () {
    test('group detail exposes the current share and payment gate', () {
      final detail = GroupDetail.fromJson({
        'id': 'g1',
        'name': 'Saturday dinner',
        'status': 'AWAITING_PAYMENT',
        'hostId': 'host',
        'hostName': 'Alex',
        'isHost': false,
        'destination': {
          'lat': 34.0,
          'lng': -118.0,
          'address': 'The restaurant',
        },
        'splitMethod': 'DISTANCE',
        'participants': [
          {
            'userId': 'host',
            'fullName': 'Alex',
            'role': 'HOST',
            'status': 'JOINED',
            'paymentStatus': 'SUCCEEDED',
            'pickup': {'lat': 34.01, 'lng': -118.01, 'address': 'Home'},
            'isMe': false,
          },
          {
            'userId': 'me',
            'fullName': 'Sarah',
            'role': 'MEMBER',
            'status': 'JOINED',
            'paymentStatus': 'PENDING',
            'pickup': {'lat': 34.02, 'lng': -118.02, 'address': 'Office'},
            'isMe': true,
          },
        ],
        'pendingInvitations': [],
        'quote': {
          'id': 'q1',
          'version': 2,
          'status': 'ACTIVE',
          'splitMethod': 'DISTANCE',
          'vehicleCategory': 'CORE',
          'originalFareCents': 6000,
          'promoDiscountCents': 600,
          'discountedTotalCents': 5400,
          'shares': [
            {
              'userId': 'host',
              'fullName': 'Alex',
              'amountCents': 3240,
              'distanceMeters': 6000,
              'weight': 0.6,
              'required': true,
            },
            {
              'userId': 'me',
              'fullName': 'Sarah',
              'amountCents': 2160,
              'distanceMeters': 4000,
              'weight': 0.4,
              'required': true,
            },
          ],
        },
        'payments': [
          {
            'id': 'p1',
            'participantId': 'host',
            'amountCents': 3240,
            'status': 'SUCCEEDED',
            'method': 'CARD',
          },
          {
            'id': 'p2',
            'participantId': 'me',
            'amountCents': 2160,
            'status': 'PENDING',
            'method': 'CARD',
          },
        ],
        'myShare': {'amountCents': 2160, 'distanceMeters': 4000, 'required': true},
        'canRequest': false,
        'canConfigure': true,
      });

      expect(detail.me?.fullName, 'Sarah');
      expect(detail.host?.fullName, 'Alex');
      expect(detail.allPickupsSet, isTrue);
      expect(detail.myAmountCents, 2160);
      expect(detail.requiredCount, 2);
      expect(detail.paidCount, 1);
      expect(detail.quote?.discountedTotalCents, 5400);
      expect(detail.canRequest, isFalse);
    });

    test('summary exposes an active ride badge flag', () {
      final summary = GroupSummary.fromJson({
        'id': 'g1',
        'name': 'Group',
        'status': 'DRIVER_ASSIGNED',
        'hostId': 'h',
        'hostName': 'Host',
        'participantCount': 4,
        'unreadCount': 3,
        'rideStatus': 'ACCEPTED',
        'rideId': 'r1',
      });
      expect(summary.hasActiveRide, isTrue);
      expect(summary.unreadCount, 3);
    });
  });

  testWidgets('shared vehicle card renders the host-controlled read-only badge',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: VehicleSelectionCard(
            fareCents: 5400,
            finalCents: 5400,
            etaMinutes: 18,
            readOnly: true,
          ),
        ),
      ),
    );
    expect(find.text('HOST CONTROLS BOOKING'), findsOneWidget);
    expect(find.text('NetRide Premium'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);
  });
}
