import 'dart:async';

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../services/app_update_events.dart';
import '../services/app_version_service.dart';
import '../theme/app_theme.dart';
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
  bool _bootCheckPending = true;
  bool _storeOpened = false;
  DateTime? _lastCheckedAt;
  ValueNotifier<bool>? _dismissRequiredSignal;
  Timer? _bootTimeout;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    appUpdateEnforcementSignal.addListener(_handleEnforcementSignal);
    _bootTimeout = Timer(const Duration(seconds: 8), () {
      if (mounted && _bootCheckPending) {
        setState(() => _bootCheckPending = false);
      }
    });
    _scheduleCheck(initial: true);
  }

  @override
  void dispose() {
    appUpdateEnforcementSignal.removeListener(_handleEnforcementSignal);
    _bootTimeout?.cancel();
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

  void _scheduleCheck({bool initial = false}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_checkWhenReady(initial: initial));
    });
  }

  Future<void> _checkWhenReady({
    bool initial = false,
    int attempt = 0,
  }) async {
    final navigator = ApiService.navigatorKey.currentState;
    if (navigator == null || navigator.overlay == null) {
      if (attempt < 20) {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        if (mounted) {
          await _checkWhenReady(initial: initial, attempt: attempt + 1);
        }
      } else if (initial && mounted) {
        setState(() => _bootCheckPending = false);
      }
      return;
    }
    await _checkForUpdate(initial: initial);
  }

  Future<void> _checkForUpdate({bool initial = false}) async {
    if (_checking || _requiredDialogVisible) {
      if (initial && mounted) {
        setState(() => _bootCheckPending = false);
      }
      return;
    }
    _checking = true;

    try {
      final policy = await AppVersionService.instance.check();
      _lastCheckedAt = DateTime.now();
      if (!mounted) return;

      if (initial) {
        setState(() => _bootCheckPending = false);
      }

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
      if (initial && mounted && _bootCheckPending) {
        setState(() => _bootCheckPending = false);
      }
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
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        if (_bootCheckPending) const _UpdateBootOverlay(),
      ],
    );
  }
}

class _UpdateBootOverlay extends StatelessWidget {
  const _UpdateBootOverlay();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: AppTheme.primaryBackground,
      child: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Image.asset(
                'assets/images/logo-noBackground.png',
                height: 84,
              ),
              const SizedBox(height: 24),
              const SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(
                  strokeWidth: 2.4,
                  color: AppTheme.primaryBrandGreen,
                ),
              ),
              const SizedBox(height: 14),
              const Text(
                'Checking for updates...',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: AppTheme.secondaryDarkText,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
