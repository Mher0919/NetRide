// test/animated_price_test.dart
//
// Regression tests for the ride-price display:
//   * with a discount, the struck-through ORIGINAL price sits ABOVE the final
//     price (never beside it) so tight layouts cannot overflow horizontally;
//   * a plain ride shows a single price.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/components/animated_price.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(width: 110, child: child),
          ),
        ),
      );

  testWidgets('struck original price renders above the final price',
      (tester) async {
    await tester.pumpWidget(
      wrap(
        const AnimatedPriceReduction(
          originalCents: 2500,
          finalCents: 1750,
          savedCents: 750,
          duration: Duration(milliseconds: 1),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // $25 -> $17.50 countdown lands on the final value.
    expect(find.text(r'$17.50'), findsOneWidget);
    expect(find.text(r'$25'), findsOneWidget);

    final struck = tester.getRect(find.text(r'$25'));
    final finalPrice = tester.getRect(find.text(r'$17.50'));

    // Struck price is ABOVE (strictly above on the vertical axis) — a Row
    // layout (the old bug) would place them at the same y and overflow.
    expect(struck.bottom, lessThanOrEqualTo(finalPrice.top + 0.01));

    final decorated = tester.widget<Text>(find.text(r'$25'));
    expect(decorated.style?.decoration, TextDecoration.lineThrough);

    // Narrow layout must not overflow.
    expect(tester.takeException(), isNull);
  });

  testWidgets('no discount renders a single price with no strikethrough',
      (tester) async {
    await tester.pumpWidget(
      wrap(
        const AnimatedPriceReduction(
          originalCents: 1200,
          finalCents: 1200,
          savedCents: 0,
          duration: Duration(milliseconds: 1),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text(r'$12'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
