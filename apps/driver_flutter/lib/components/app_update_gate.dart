import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../services/app_update_events.dart';
import '../services/app_version_service.dart';
import 'app_update_dialogs.dart';

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
  bool _requiredDialogVisible = false;
  bool _optionalDialogShown = false;
  bool _storeOpened = false;
  DateTime? _lastCheckedAt;
  ValueNotifier<bool>? _dismissRequiredSignal;

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
    _dismissRequiredSignal?.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  void _handleEnforcementSignal() {
    if (!mounted) return;
    if (_requiredDialogVisible) {
      unawaited(_recheckRequiredPolicy());
      return;
    }
    _lastCheckedAt = null;
    _scheduleCheck();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;

    AppVersionService.instance.completePendingFlexibleUpdate();

    if (_storeOpened) {
      _storeOpened = false;
      if (_requiredDialogVisible) {
        unawaited(_recheckRequiredPolicy());
      } else {
        _lastCheckedAt = null;
        _scheduleCheck();
      }
      return;
    }

    final last = _lastCheckedAt;
    if (last == null ||
        DateTime.now().difference(last) >= _foregroundCheckInterval) {
      _scheduleCheck();
    }
  }

  void _scheduleCheck() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_checkWhenReady());
    });
  }

  Future<void> _checkWhenReady([int attempt = 0]) async {
    final navigator = ApiService.navigatorKey.currentState;
    if (navigator == null || navigator.overlay == null) {
      if (attempt < 20) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        if (mounted) {
          await _checkWhenReady(attempt + 1);
        }
      }
      return;
    }
    await _checkForUpdate();
  }

  Future<void> _checkForUpdate() async {
    if (_checking || _requiredDialogVisible) return;
    _checking = true;

    try {
      final policy = await AppVersionService.instance.check();
      _lastCheckedAt = DateTime.now();
      if (!mounted) return;

      if (policy == null) return;

      if (policy.urgency == UpdateUrgency.required) {
        await _showRequired(policy);
        return;
      }

      if (policy.urgency != UpdateUrgency.optional || _optionalDialogShown) {
        return;
      }

      final shouldPrompt =
          await AppVersionService.instance.shouldPromptOptional(policy);
      if (!mounted || !shouldPrompt) return;

      _optionalDialogShown = true;
      await _showOptional(policy);
    } finally {
      _checking = false;
    }
  }

  Future<AppUpdateLaunchResult> _openStore(
    AppUpdatePolicy policy, {
    required bool immediate,
  }) async {
    _storeOpened = true;
    final result = await AppVersionService.instance.openStore(
      policy,
      immediate: immediate,
    );
    if (result == AppUpdateLaunchResult.missingStoreUrl ||
        result == AppUpdateLaunchResult.failed) {
      _storeOpened = false;
    }
    return result;
  }

  Future<void> _recheckRequiredPolicy() async {
    final policy = await AppVersionService.instance.check();
    if (!mounted) return;
    if (policy == null) return;
    _lastCheckedAt = DateTime.now();
    if (policy.urgency != UpdateUrgency.required) {
      _dismissRequiredSignal?.value = true;
    }
  }

  Future<void> _showRequired(AppUpdatePolicy policy) async {
    final dialogContext = ApiService.navigatorKey.currentState?.overlay?.context;
    if (dialogContext == null) return;

    final dismissSignal = ValueNotifier<bool>(false);
    _dismissRequiredSignal = dismissSignal;
    _requiredDialogVisible = true;
    try {
      await showDialog<void>(
        context: dialogContext,
        barrierDismissible: false,
        useRootNavigator: true,
        builder: (_) => RequiredUpdateDialog(
          policy: policy,
          dismissSignal: dismissSignal,
          onUpdate: () => _openStore(policy, immediate: true),
        ),
      );
    } finally {
      _requiredDialogVisible = false;
      _dismissRequiredSignal = null;
      dismissSignal.dispose();
    }
  }

  Future<void> _showOptional(AppUpdatePolicy policy) async {
    final dialogContext = ApiService.navigatorKey.currentState?.overlay?.context;
    if (dialogContext == null) return;

    final choice = await showDialog<AppUpdateChoice>(
      context: dialogContext,
      barrierDismissible: false,
      useRootNavigator: true,
      builder: (_) => OptionalUpdateDialog(policy: policy),
    );

    if (choice == AppUpdateChoice.update) {
      await _openStore(policy, immediate: false);
      return;
    }

    await AppVersionService.instance.dismissOptional(policy);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
