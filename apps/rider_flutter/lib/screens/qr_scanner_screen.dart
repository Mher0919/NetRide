// lib/screens/qr_scanner_screen.dart
//
// Scans a friend's referral QR (signed payload) and links the relationship
// via POST /api/referral/scan. All fraud checks run server-side.

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../services/rewards_service.dart';

class QrScannerScreen extends StatefulWidget {
  const QrScannerScreen({super.key});

  @override
  State<QrScannerScreen> createState() => _QrScannerScreenState();
}

class _QrScannerScreenState extends State<QrScannerScreen> {
  final MobileScannerController _controller = MobileScannerController();
  bool _processing = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_processing) return;
    final barcode = capture.barcodes.isEmpty ? null : capture.barcodes.first;
    final payload = barcode?.rawValue;
    if (payload == null || payload.isEmpty) return;

    _processing = true;
    await _controller.stop();
    if (!mounted) return;

    try {
      final result = await RewardsService.scanReferral(payload: payload);
      if (!mounted) return;
      await _showResultDialog(
        success: true,
        title: 'Referral linked!',
        message: result['referrer_name'] != null
            ? 'You\'re now connected to ${result['referrer_name']}. Both of you earn \$5 in ride credits after your first completed ride.'
            : 'You\'re now linked. Both of you earn \$5 in ride credits after your first completed ride.',
      );
    } catch (e) {
      if (!mounted) return;
      await _showResultDialog(
        success: false,
        title: 'Could not link referral',
        message: _friendlyError(e),
      );
    }
  }

  String _friendlyError(Object e) {
    final s = e.toString();
    if (s.contains('own referral')) return 'You cannot use your own referral code.';
    if (s.contains('already linked')) return 'You have already linked a referral code.';
    if (s.contains('expired')) return 'This referral code has expired.';
    if (s.contains('not exist')) return 'This referral code does not exist.';
    return 'That QR code is not a valid NetRide referral.';
  }

  Future<void> _showResultDialog({
    required bool success,
    required String title,
    required String message,
  }) async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        icon: Icon(
          success ? Icons.check_circle_rounded : Icons.error_outline_rounded,
          size: 48,
          color: success ? const Color(0xFF6E8B74) : const Color(0xFFC65A5A),
        ),
        title: Text(title, textAlign: TextAlign.center),
        content: Text(message, textAlign: TextAlign.center),
        actionsAlignment: MainAxisAlignment.center,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('OK'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF11140F),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        foregroundColor: Colors.white,
        title: const Text('Scan referral QR'),
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
          ),
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 3),
                borderRadius: BorderRadius.circular(24),
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 60,
            child: Column(
              children: [
                if (_processing)
                  const CircularProgressIndicator(color: Colors.white, strokeWidth: 2.5)
                else
                  const Icon(Icons.qr_code_scanner_rounded, color: Colors.white70, size: 28),
                const SizedBox(height: 10),
                const Text(
                  'Point your camera at a friend\'s NetRide referral QR',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white70, fontSize: 14),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
