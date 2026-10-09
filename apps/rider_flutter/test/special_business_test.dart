// test/special_business_test.dart
//
// Unit tests for the Google business models and the single-source-of-truth
// selected-Special state. No network: Google is only ever contacted through
// the backend in production (spec §37 — mocks belong in tests).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:rider_flutter/models/google_business.dart';
import 'package:rider_flutter/models/special_models.dart';
import 'package:rider_flutter/providers/specials_provider.dart';
import 'package:rider_flutter/widgets/special_card.dart';

void main() {
  group('GoogleBusiness.fromJson', () {
    test('parses a fully populated business', () {
      final business = GoogleBusiness.fromJson({
        'placeId': 'ChIJN1t_tDeuEmsRUsoyG83frY4',
        'name': 'Blue Bottle Coffee',
        'category': 'Coffee Shop',
        'address': '300 Webster St, Oakland, CA 94607, USA',
        'shortAddress': '300 Webster St',
        'latitude': 37.7964,
        'longitude': -122.2735,
        'rating': 4.53,
        'reviewCount': 1284,
        'priceLevel': r'$$',
        'businessStatus': 'OPERATIONAL',
        'googleMapsUri': 'https://maps.google.com/?cid=1',
        'openNow': true,
        'weekdayDescriptions': ['Monday: 7–5', 'Tuesday: 7–5'],
        'phone': '+1 510-555-0100',
        'website': 'https://bluebottlecoffee.com',
        'photos': [
          {
            'name': 'places/x/photos/y',
            'url': '/api/places/photo?name=x&w=1200&sig=1',
            'thumbUrl': '/api/places/photo?name=x&w=400&sig=1',
            'attribution': {'displayName': 'Jane', 'uri': null},
          },
        ],
        'reviews': [
          {
            'authorName': 'Alex',
            'rating': 5,
            'relativeTime': '2 weeks ago',
            'text': 'Great coffee',
          },
        ],
        'level': 'full',
        'attribution': 'Powered by Google',
      });

      expect(business.placeId, 'ChIJN1t_tDeuEmsRUsoyG83frY4');
      expect(business.rating, closeTo(4.53, 0.001));
      expect(business.hasRating, isTrue);
      expect(business.hasReviews, isTrue);
      expect(business.hasHours, isTrue);
      expect(business.isFull, isTrue);
      expect(business.photos.single.attributionName, 'Jane');
      expect(business.reviews.single.authorName, 'Alex');
      expect(business.openNow, isTrue);
    });

    test('degrades gracefully when fields are missing', () {
      final business = GoogleBusiness.fromJson({'placeId': 'x', 'name': 'Manual'});
      expect(business.hasRating, isFalse);
      expect(business.hasReviews, isFalse);
      expect(business.hasHours, isFalse);
      expect(business.phone, isNull);
      expect(business.rating, isNull);
      expect(business.photos, isEmpty);
      expect(business.isFull, isFalse);
      expect(business.attribution, 'Powered by Google');
    });
  });

  group('GoogleBusinessResult', () {
    test('manual businesses carry no Google payload', () {
      final result = GoogleBusinessResult.fromJson({
        'business': null,
        'googleAvailable': true,
        'manual': true,
      });
      expect(result.business, isNull);
      expect(result.manual, isTrue);
      expect(result.googleAvailable, isTrue);
    });

    test('google outage keeps the cached business usable', () {
      final result = GoogleBusinessResult.fromJson({
        'business': {'placeId': 'p', 'name': 'Cached Cafe'},
        'googleAvailable': false,
        'error': 'Business information is currently unavailable.',
      });
      expect(result.business, isNotNull);
      expect(result.business!.name, 'Cached Cafe');
      expect(result.googleAvailable, isFalse);
    });
  });

  test('reviewCountLabel groups thousands', () {
    expect(reviewCountLabel(12), '12 reviews');
    expect(reviewCountLabel(1284), '1,284 reviews');
    expect(reviewCountLabel(1000000), '1,000,000 reviews');
  });

  group('SpecialsProvider selection (single source of truth)', () {
    test('select / clear drive listeners', () {
      final provider = SpecialsProvider();
      var notifications = 0;
      provider.addListener(() => notifications++);

      expect(provider.selectedSpecialId, isNull);
      provider.selectSpecial('special-1');
      expect(provider.selectedSpecialId, 'special-1');
      expect(notifications, 1);

      // Selecting the same id again is a no-op.
      provider.selectSpecial('special-1');
      expect(notifications, 1);

      provider.selectSpecial('special-2');
      expect(provider.selectedSpecialId, 'special-2');
      expect(notifications, 2);

      provider.clearSelection();
      expect(provider.selectedSpecialId, isNull);
      expect(notifications, 3);

      provider.clearSelection();
      expect(notifications, 3);
    });

    test('business cache is empty until a fetch succeeds', () {
      final provider = SpecialsProvider();
      expect(provider.businessFor('special-1'), isNull);
      expect(provider.businessLoading('special-1'), isFalse);
    });
  });

  group('SpecialCard', () {
    final sponsor = SponsorSpecial(
      id: 'special-1',
      businessName: 'Blue Bottle Coffee',
      businessType: 'CAFE',
      address: '300 Webster St',
      latitude: 37.7964,
      longitude: -122.2735,
      discount: const SponsorDiscount(
        type: 'PERCENT',
        percent: 20,
        label: '20%',
      ),
      kmAway: 0.3,
      status: 'ACTIVE',
    );

    testWidgets('renders the deal and fires onTap (sheet entry point A)',
        (tester) async {
      var tapped = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChangeNotifierProvider(
              create: (_) => SpecialsProvider(),
              child: SpecialCard(sponsor: sponsor, onTap: () => tapped = true),
            ),
          ),
        ),
      );

      expect(find.text('Blue Bottle Coffee'), findsOneWidget);
      expect(find.text('20% OFF'), findsOneWidget);
      expect(find.textContaining('Cafe'), findsOneWidget);
      expect(find.text('View Special'), findsOneWidget);

      await tester.tap(find.byType(SpecialCard));
      expect(tapped, isTrue);
    });
  });

  test('discount and distance copy come from backend values', () {
    final sponsor = SponsorSpecial(
      id: 's',
      businessName: 'Cafe',
      businessType: 'CAFE',
      discount: const SponsorDiscount(type: 'PERCENT', percent: 25, label: ''),
      kmAway: 1.609344,
      status: 'ACTIVE',
    );
    expect(specialDiscountLabel(sponsor), '25% off');
    expect(specialDistanceLabel(sponsor), '1.0 mi');
  });
}
