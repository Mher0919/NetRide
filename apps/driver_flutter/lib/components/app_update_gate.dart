import 'dart:async';

import 'package:flutter/material.dart';

import '../services/app_update_events.dart';
import '../services/app_version_service.dart';

class AppUpdateGate extends StatefulWidget {
  const AppUpdateGate({super.key, required this.child});

  final Widget child;

  @override
  State<AppUpdateGate> createState() => _AppUpdateGateState();
}

class _AppUpdateGateState extends State<AppUpdateGate>
    with WidgetsBindingObserver {
  static const Duration _foregroundCheckInterval = Duration(minutes: 15);

  bool _checking = false;
  bool _redirected = false;
  DateTime? _lastCheckedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    appUpdateEnforcementSignal.addListener(_handleEnforcementSignal);
    _scheduleCheck();
  }

  @override
  void dispose() {
    appUpdateEnforcementSignal.removeListener(_handleEnforcementSignal);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _handleEnforcementSignal() {
    if (!mounted) return;
    _lastCheckedAt = null;
    _scheduleCheck();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;

    final last = _lastCheckedAt;
    if (last == null ||
        DateTime.now().difference(last) >= _foregroundCheckInterval) {
      _scheduleCheck();
    }
  }

  void _scheduleCheck() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_checkForUpdate());
    });
  }

  Future<void> _checkForUpdate() async {
    if (_checking || _redirected) return;
    _checking = true;

    try {
      final policy = await AppVersionService.instance.check();
      _lastCheckedAt = DateTime.now();
      if (!mounted || policy == null || !policy.isRequired) return;

      _redirected = true;
      final result = await AppVersionService.instance.openStore(policy);
      if (result == AppUpdateLaunchResult.missingStoreUrl ||
          result == AppUpdateLaunchResult.failed) {
        _redirected = false;
      }
    } finally {
      _checking = false;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
