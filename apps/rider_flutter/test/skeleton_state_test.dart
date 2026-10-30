// Skeleton loading must be a temporary state, never a permanent fallback.
// This exercises the same StateContainer used by the rider's data screens.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/components/skeletons.dart';
import 'package:rider_flutter/components/state_container.dart';

void main() {
  testWidgets('loading skeleton is replaced by content and by error states',
      (tester) async {
    Widget build(ViewState state) => MaterialApp(
          home: Scaffold(
            body: StateContainer(
              state: state,
              loadingWidget: const ExploreSkeleton(),
              errorMessage: 'Could not load',
              onRetry: () {},
              successWidget: const Text('real content'),
            ),
          ),
        );

    await tester.pumpWidget(build(ViewState.loading));
    expect(find.byType(ExploreSkeleton), findsOneWidget);
    expect(find.text('real content'), findsNothing);

    await tester.pumpWidget(build(ViewState.success));
    expect(find.byType(ExploreSkeleton), findsNothing);
    expect(find.text('real content'), findsOneWidget);

    await tester.pumpWidget(build(ViewState.failure));
    expect(find.text('Something went wrong'), findsOneWidget);
    expect(find.text('RETRY ACTION'), findsOneWidget);
    expect(find.byType(ExploreSkeleton), findsNothing);
  });

  testWidgets('skeletons expose no interactive controls', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: ExploreSkeleton())),
    );

    expect(find.byType(ElevatedButton), findsNothing);
    expect(find.byType(TextButton), findsNothing);
    expect(find.byType(IconButton), findsNothing);
    expect(find.byType(InkWell), findsNothing);
  });
}
