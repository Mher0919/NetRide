// Skeleton loading must be a temporary state, never a permanent fallback.
// This exercises the same StateContainer used by the driver's data screens.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_flutter/components/skeletons.dart';
import 'package:driver_flutter/components/state_container.dart';

void main() {
  testWidgets('loading skeleton is replaced by content and by error states',
      (tester) async {
    Widget build(ViewState state) => MaterialApp(
          home: Scaffold(
            body: StateContainer(
              state: state,
              loadingWidget: const DriverDashboardSkeleton(),
              errorMessage: 'Could not load',
              onRetry: () {},
              successWidget: const Text('real content'),
            ),
          ),
        );

    await tester.pumpWidget(build(ViewState.loading));
    expect(find.byType(DriverDashboardSkeleton), findsOneWidget);
    expect(find.text('real content'), findsNothing);

    await tester.pumpWidget(build(ViewState.success));
    expect(find.byType(DriverDashboardSkeleton), findsNothing);
    expect(find.text('real content'), findsOneWidget);

    await tester.pumpWidget(build(ViewState.failure));
    expect(find.text('Connection Issue'), findsOneWidget);
    expect(find.text('RETRY SYNC'), findsOneWidget);
    expect(find.byType(DriverDashboardSkeleton), findsNothing);
  });

  testWidgets('skeletons expose no interactive controls', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: DriverDashboardSkeleton())),
    );

    expect(find.byType(ElevatedButton), findsNothing);
    expect(find.byType(TextButton), findsNothing);
    expect(find.byType(IconButton), findsNothing);
    expect(find.byType(InkWell), findsNothing);
  });
}
