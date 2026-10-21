import 'package:flutter/material.dart';

import '../services/app_version_service.dart';
import '../theme/app_theme.dart';

class RequiredUpdateDialog extends StatefulWidget {
  const RequiredUpdateDialog({
    super.key,
    required this.policy,
    required this.onUpdate,
  });

  final AppUpdatePolicy policy;
  final Future<AppUpdateLaunchResult> Function() onUpdate;

  @override
  State<RequiredUpdateDialog> createState() => _RequiredUpdateDialogState();
}

class _RequiredUpdateDialogState extends State<RequiredUpdateDialog> {
  bool _openingStore = false;
  bool _failed = false;

  Future<void> _handleUpdate() async {
    if (_openingStore) return;
    setState(() {
      _openingStore = true;
      _failed = false;
    });

    final result = await widget.onUpdate();
    if (!mounted) return;

    setState(() {
      _openingStore = false;
      _failed = result == AppUpdateLaunchResult.failed;
    });
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      child: Dialog.fullscreen(
        backgroundColor: AppTheme.primaryBackground,
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Image.asset(
                      'assets/images/logo-noBackground.png',
                      height: 96,
                    ),
                    const SizedBox(height: 28),
                    Container(
                      padding: const EdgeInsets.all(18),
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.system_update_alt_rounded,
                        size: 40,
                        color: AppTheme.primaryBrandGreen,
                      ),
                    ),
                    const SizedBox(height: 20),
                    const Text(
                      'Update required',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 26,
                        fontWeight: FontWeight.w900,
                        color: AppTheme.secondaryDarkText,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'A required update is ready. Please update to the latest version to continue using NetRide.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 15,
                        height: 1.5,
                        color: AppTheme.secondaryDarkText,
                      ),
                    ),
                    const SizedBox(height: 20),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 10,
                      ),
                      decoration: BoxDecoration(
                        color: AppTheme.lightCardBackground,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppTheme.softBorderColor),
                      ),
                      child: Text(
                        'Version ${widget.policy.latestVersion} is required',
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          color: AppTheme.secondaryBrandGreen,
                        ),
                      ),
                    ),
                    if (widget.policy.releaseNotes != null) ...[
                      const SizedBox(height: 18),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(color: AppTheme.softBorderColor),
                        ),
                        child: Text(
                          widget.policy.releaseNotes!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 13,
                            height: 1.5,
                            color: AppTheme.secondaryDarkText,
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: 28),
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
                          _openingStore ? 'Opening store...' : 'Update now',
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        style: FilledButton.styleFrom(
                          backgroundColor: AppTheme.primaryBrandGreen,
                          disabledBackgroundColor:
                              AppTheme.primaryBrandGreen.withValues(alpha: 0.6),
                          foregroundColor: Colors.white,
                          padding: const EdgeInsets.symmetric(vertical: 17),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                        ),
                      ),
                    ),
                    if (_failed) ...[
                      const SizedBox(height: 14),
                      const Text(
                        'We could not open the store. Please try again.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: AppTheme.errorColor,
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    Text(
                      'Installed version: ${widget.policy.currentVersion}',
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
            'A new version of NetRide is ready with the latest fixes and improvements.',
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
