import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rider_flutter/components/app_update_dialogs.dart';
import 'package:rider_flutter/services/app_update_policy.dart';

AppUpdatePolicy _policy() {
  return const AppUpdatePolicy(
    currentVersion: '1.0.0',
    currentBuild: 1,
    latestVersion: '2.1.0',
    minimumVersion: '2.0.0',
    latestBuild: 21,
    minimumBuild: 20,
    storeUrl:
        'https://play.google.com/store/apps/details?id=com.netride.rider.rider_flutter',
    releaseNotes: null,
    popupTitle: 'Update required',
    popupMessage: 'Please update to continue using NetRide.',
    buttonText: 'Update Now',
    supportingText: 'This version is no longer supported.',
    announcementLabel: 'IMPORTANT UPDATE',
    accentColor: '#5B7760',
    urgency: UpdateUrgency.required,
    enabled: true,
  );
}

void main() {
  testWidgets('mandatory popup shows configured content and cannot be dismissed',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: RequiredUpdateDialog(
          policy: _policy(),
          onUpdate: () async => AppUpdateLaunchResult.missingStoreUrl,
        ),
      ),
    );

    expect(find.text('IMPORTANT UPDATE'), findsOneWidget);
    expect(find.text('Update required'), findsOneWidget);
    expect(find.text('Please update to continue using NetRide.'), findsOneWidget);
    expect(find.text('Version 2.0.0 or newer required'), findsOneWidget);
    expect(find.text('Update Now'), findsOneWidget);
    expect(find.text('Maybe later'), findsNothing);
    expect(find.byIcon(Icons.close), findsNothing);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsOneWidget);
  });

  testWidgets('missing store URL produces a clear error without a fake success',
      (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: RequiredUpdateDialog(
          policy: _policy(),
          onUpdate: () async => AppUpdateLaunchResult.missingStoreUrl,
        ),
      ),
    );

    await tester.tap(find.text('Update Now'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('update link is not configured'),
      findsOneWidget,
    );
  });

  testWidgets('a policy release signal closes the mandatory popup',
      (tester) async {
    final signal = ValueNotifier<bool>(false);
    addTearDown(signal.dispose);

    await tester.pumpWidget(
      MaterialApp(
        home: RequiredUpdateDialog(
          policy: _policy(),
          dismissSignal: signal,
          onUpdate: () async => AppUpdateLaunchResult.storeOpened,
        ),
      ),
    );

    expect(find.text('Update required'), findsOneWidget);
    signal.value = true;
    await tester.pumpAndSettle();
    expect(find.text('Update required'), findsNothing);
  });
}
