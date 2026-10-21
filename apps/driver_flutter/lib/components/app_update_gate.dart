import 'package:flutter/material.dart';

import '../services/api_service.dart';
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
  DateTime? _lastCheckedAt;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scheduleCheck();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;

    AppVersionService.instance.completePendingFlexibleUpdate();

    final last = _lastCheckedAt;
    if (last == null ||
        DateTime.now().difference(last) >= _foregroundCheckInterval) {
      _scheduleCheck();
    }
  }

  void _scheduleCheck() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkWhenReady();
    });
  }

  Future<void> _checkWhenReady([int attempt = 0]) async {
    final navigator = ApiService.navigatorKey.currentState;
    if (navigator == null || navigator.overlay == null) {
      if (attempt < 20) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        if (mounted) await _checkWhenReady(attempt + 1);
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
      if (!mounted || policy == null) return;

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

  Future<void> _showRequired(AppUpdatePolicy policy) async {
    final dialogContext = ApiService.navigatorKey.currentState?.overlay?.context;
    if (dialogContext == null) return;

    _requiredDialogVisible = true;
    try {
      await showDialog<void>(
        context: dialogContext,
        barrierDismissible: false,
        useRootNavigator: true,
        builder: (_) => RequiredUpdateDialog(
          policy: policy,
          onUpdate: () => AppVersionService.instance.openStore(
            policy,
            immediate: true,
          ),
        ),
      );
    } finally {
      _requiredDialogVisible = false;
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
      await AppVersionService.instance.openStore(policy, immediate: false);
      return;
    }

    await AppVersionService.instance.dismissOptional(policy);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
