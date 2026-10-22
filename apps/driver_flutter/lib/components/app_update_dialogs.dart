import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../services/app_version_service.dart';
import '../theme/app_theme.dart';

class RequiredUpdateDialog extends StatefulWidget {
  const RequiredUpdateDialog({
    super.key,
    required this.policy,
    required this.onUpdate,
    this.dismissSignal,
  });

  final AppUpdatePolicy policy;
  final Future<AppUpdateLaunchResult> Function() onUpdate;
  final ValueListenable<bool>? dismissSignal;

  @override
  State<RequiredUpdateDialog> createState() => _RequiredUpdateDialogState();
}

class _RequiredUpdateDialogState extends State<RequiredUpdateDialog> {
  bool _openingStore = false;
  AppUpdateLaunchResult? _lastResult;

  @override
  void initState() {
    super.initState();
    widget.dismissSignal?.addListener(_handleDismissSignal);
  }

  @override
  void dispose() {
    widget.dismissSignal?.removeListener(_handleDismissSignal);
    super.dispose();
  }

  void _handleDismissSignal() {
    if (widget.dismissSignal?.value != true || !mounted) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) Navigator.of(context).pop();
    });
  }

  Future<void> _handleUpdate() async {
    if (_openingStore) return;
    setState(() {
      _openingStore = true;
      _lastResult = null;
    });

    final result = await widget.onUpdate();
    if (!mounted) return;

    setState(() {
      _openingStore = false;
      _lastResult = result;
    });
  }

  Color get _accent {
    final raw = widget.policy.accentColor;
    if (raw == null || !RegExp(r'^#[0-9A-Fa-f]{6}$').hasMatch(raw)) {
      return AppTheme.primaryBrandGreen;
    }
    return Color(int.parse('FF${raw.substring(1)}', radix: 16));
  }

  String? get _errorMessage {
    switch (_lastResult) {
      case AppUpdateLaunchResult.missingStoreUrl:
        return 'The update link is not configured yet. Please contact support.';
      case AppUpdateLaunchResult.failed:
        return 'We could not open the store. Please try again.';
      default:
        return null;
    }
  }

  bool get _showVersionChip =>
      RegExp(r'^\d+(\.\d+){1,3}$').hasMatch(widget.policy.minimumVersion);

  @override
  Widget build(BuildContext context) {
    final policy = widget.policy;
    final accent = _accent;
    final error = _errorMessage;

    return PopScope(
      canPop: false,
      child: Dialog.fullscreen(
        backgroundColor: AppTheme.primaryBackground,
        child: SafeArea(
          child: Stack(
            children: [
              Positioned(
                top: -110,
                right: -80,
                child: Container(
                  width: 260,
                  height: 260,
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.10),
                    shape: BoxShape.circle,
                  ),
                ),
              ),
              Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 28,
                    vertical: 28,
                  ),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 430),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 34,
                              height: 34,
                              decoration: BoxDecoration(
                                color: accent,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(
                                Icons.directions_car_rounded,
                                size: 19,
                                color: Colors.white,
                              ),
                            ),
                            const SizedBox(width: 10),
                            const Text(
                              'NetRide Driver',
                              style: TextStyle(
                                fontSize: 17,
                                fontWeight: FontWeight.w900,
                                letterSpacing: -0.4,
                                color: AppTheme.secondaryDarkText,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 34),
                        if (policy.announcementLabel != null) ...[
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 12,
                              vertical: 6,
                            ),
                            decoration: BoxDecoration(
                              color: accent.withValues(alpha: 0.12),
                              borderRadius: BorderRadius.circular(999),
                            ),
                            child: Text(
                              policy.announcementLabel!.toUpperCase(),
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.1,
                                color: accent,
                              ),
                            ),
                          ),
                          const SizedBox(height: 18),
                        ],
                        Semantics(
                          image: true,
                          label: 'Update available',
                          child: Container(
                            width: 86,
                            height: 86,
                            decoration: BoxDecoration(
                              color: Colors.white,
                              shape: BoxShape.circle,
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.06),
                                  blurRadius: 24,
                                  offset: const Offset(0, 8),
                                ),
                              ],
                            ),
                            child: Icon(
                              Icons.system_update_alt_rounded,
                              size: 42,
                              color: accent,
                            ),
                          ),
                        ),
                        const SizedBox(height: 22),
                        Text(
                          policy.popupTitle,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 27,
                            height: 1.15,
                            fontWeight: FontWeight.w900,
                            letterSpacing: -0.6,
                            color: AppTheme.secondaryDarkText,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          policy.popupMessage,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 15,
                            height: 1.55,
                            color: AppTheme.secondaryDarkText,
                          ),
                        ),
                        if (policy.supportingText != null) ...[
                          const SizedBox(height: 18),
                          Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(16),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(
                                color: AppTheme.softBorderColor,
                              ),
                            ),
                            child: Text(
                              policy.supportingText!,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 13,
                                height: 1.5,
                                color: AppTheme.secondaryDarkText,
                              ),
                            ),
                          ),
                        ],
                        if (_showVersionChip) ...[
                          const SizedBox(height: 18),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 9,
                            ),
                            decoration: BoxDecoration(
                              color: AppTheme.lightCardBackground,
                              borderRadius: BorderRadius.circular(11),
                              border: Border.all(
                                color: AppTheme.softBorderColor,
                              ),
                            ),
                            child: Text(
                              'Version ${policy.minimumVersion} or newer required',
                              style: const TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w700,
                                color: AppTheme.secondaryBrandGreen,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 30),
                        SizedBox(
                          width: double.infinity,
                          child: FilledButton.icon(
                            onPressed: _openingStore ? null : _handleUpdate,
                            icon: _openingStore
                                ? const SizedBox(
                                    width: 18,
                                    height: 18,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                      color: Colors.white,
                                    ),
                                  )
                                : const Icon(Icons.download_rounded),
                            label: Text(
                              _openingStore
                                  ? 'Opening store...'
                                  : policy.buttonText,
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            style: FilledButton.styleFrom(
                              backgroundColor: accent,
                              disabledBackgroundColor:
                                  accent.withValues(alpha: 0.6),
                              foregroundColor: Colors.white,
                              padding: const EdgeInsets.symmetric(vertical: 17),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(14),
                              ),
                            ),
                          ),
                        ),
                        if (error != null) ...[
                          const SizedBox(height: 12),
                          Text(
                            error,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: AppTheme.errorColor,
                            ),
                          ),
                        ],
                        const SizedBox(height: 16),
                        Text(
                          'Installed version: ${policy.currentVersion}',
                          style: const TextStyle(
                            fontSize: 12,
                            color: AppTheme.secondaryDarkText,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class OptionalUpdateDialog extends StatelessWidget {
  const OptionalUpdateDialog({super.key, required this.policy});

  final AppUpdatePolicy policy;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(24),
      ),
      title: Column(
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppTheme.primaryBrandGreen.withValues(alpha: 0.12),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.system_update_alt_rounded,
              size: 32,
              color: AppTheme.primaryBrandGreen,
            ),
          ),
          const SizedBox(height: 14),
          const Text(
            'Update available',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 20,
              fontWeight: FontWeight.w900,
              color: AppTheme.secondaryDarkText,
            ),
          ),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'A new version of NetRide Driver is ready with the latest fixes and improvements.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14,
              height: 1.5,
              color: AppTheme.secondaryDarkText,
            ),
          ),
          const SizedBox(height: 12),
          Text(
            '${policy.currentVersion}  →  ${policy.latestVersion}',
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: AppTheme.secondaryBrandGreen,
            ),
          ),
          if (policy.releaseNotes != null) ...[
            const SizedBox(height: 14),
            Text(
              policy.releaseNotes!,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
                color: AppTheme.secondaryDarkText,
              ),
            ),
          ],
        ],
      ),
      actionsAlignment: MainAxisAlignment.center,
      actions: [
        TextButton(
          onPressed: () =>
              Navigator.of(context).pop(AppUpdateChoice.later),
          child: const Text('Maybe later'),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.of(context).pop(AppUpdateChoice.update),
          style: FilledButton.styleFrom(
            backgroundColor: AppTheme.primaryBrandGreen,
            foregroundColor: Colors.white,
          ),
          child: const Text('Update'),
        ),
      ],
    );
  }
}
