// lib/widgets/referral_code_dialog.dart
//
// Shared "Enter referral code" dialog used by both the first-time referral
// onboarding screen and the account page (Refer & Earn). Returns the
// normalized 10-char code, or null when the rider cancels.

import 'package:flutter/material.dart';

Future<String?> promptForReferralCode(BuildContext context) async {
  final controller = TextEditingController();
  final code = await showDialog<String>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, setDialogState) {
        String? error;
        String? validate(String v) {
          final t = v.trim().toUpperCase();
          if (t.isEmpty) return 'Enter the referral code.';
          if (!RegExp(r'^[A-Z2-9]{10}$').hasMatch(t)) {
            return 'That referral code doesn\'t look valid. Please check the code and try again.';
          }
          return null;
        }

        void submit() {
          error = validate(controller.text);
          setDialogState(() {});
          if (error == null) Navigator.pop(ctx, controller.text.trim().toUpperCase());
        }

        return AlertDialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: const Text('Enter referral code', textAlign: TextAlign.center),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Ask a friend for their NetRide referral code.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: controller,
                textCapitalization: TextCapitalization.characters,
                maxLength: 10,
                autofocus: true,
                onSubmitted: (_) => submit(),
                decoration: InputDecoration(
                  counterText: '',
                  hintText: 'AB12CD34EF',
                  hintStyle: const TextStyle(letterSpacing: 3, color: Color(0xFFB7B0A6)),
                  errorText: error,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                ),
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 4,
                ),
                onChanged: (v) {
                  if (v.length == 10 && RegExp(r'^[A-Za-z2-9]{10}$').hasMatch(v)) submit();
                },
              ),
            ],
          ),
          actionsAlignment: MainAxisAlignment.center,
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: submit,
              child: const Text('Link referral'),
            ),
          ],
        );
      },
    ),
  );
  return code;
}