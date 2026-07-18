import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:camera/camera.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/face_verification_service.dart';

/// Single-selfie capture screen for identity verification.
///
/// Flow:
///   1. Initialize front camera
///   2. Show oval frame with guidance text
///   3. Driver taps to capture one selfie
///   4. Local brightness check (reject obviously bad images)
///   5. Processing indicator with status messages
///   6. POST /api/face/verify-image with selfie + enrollment reference
///   7. Show PASS/FAIL result, then Navigator.pop with the result
///
/// No multi-angle prompts, no video recording, no countdown.
class FaceCaptureScreen extends StatefulWidget {
  final String reason;

  const FaceCaptureScreen({
    super.key,
    this.reason = 'verification',
  });

  @override
  State<FaceCaptureScreen> createState() => _FaceCaptureScreenState();
}

class _FaceCaptureScreenState extends State<FaceCaptureScreen> {
  CameraController? _camera;
  Future<void>? _initFuture;
  bool _isCapturing = false;
  bool _isProcessing = false;
  String _processingMessage = '';
  bool _showResult = false;
  bool _captureSuccess = false;
  String _resultMessage = '';
  String _resultDetail = '';
  bool _hasError = false;
  XFile? _capturedImage;

  static const Color _cream = Color(0xFFF7F4EF);
  static const Color _sage = Color(0xFF5B7760);
  static const Color _terracotta = Color(0xFFC65A5A);
  static const Color _darkForest = Color(0xFF2F3A32);

  static const _processingMessages = [
    'Checking image quality...',
    'Detecting face...',
    'Validating selfie...',
    'Verifying identity...',
  ];

  @override
  void initState() {
    super.initState();
    _initFuture = _initializeCamera();
  }

  Future<void> _initializeCamera() async {
    final camPerm = await Permission.camera.request();
    if (!camPerm.isGranted) {
      if (!mounted) return;
      Navigator.pop(context, const FaceVerifyResult(
        passed: false,
        match: false,
        score: 0,
        reason: 'camera_permission_denied',
      ));
      return;
    }

    final cameras = await availableCameras();
    if (cameras.isEmpty) {
      if (!mounted) return;
      Navigator.pop(context, const FaceVerifyResult(
        passed: false,
        match: false,
        score: 0,
        reason: 'no_camera',
      ));
      return;
    }

    final preferred = cameras.firstWhere(
      (c) => c.lensDirection == CameraLensDirection.front,
      orElse: () => cameras.first,
    );
    final controller = CameraController(
      preferred,
      ResolutionPreset.medium,
      enableAudio: false,
    );
    await controller.initialize();
    if (!mounted) return;
    setState(() => _camera = controller);
  }

  @override
  void dispose() {
    _camera?.dispose();
    super.dispose();
  }

  Future<void> _captureSelfie() async {
    if (_camera == null || _isCapturing || _isProcessing) return;

    setState(() {
      _isCapturing = true;
      _hasError = false;
      _showResult = false;
    });

    try {
      final captured = await _camera!.takePicture();
      if (!mounted) return;

      // Basic client-side brightness check
      final brightnessCheck = await _checkBrightness(captured);
      if (!brightnessCheck.passed) {
        setState(() {
          _isCapturing = false;
          _hasError = true;
          _showResult = true;
          _captureSuccess = false;
          _resultMessage = brightnessCheck.message;
          _resultDetail = 'Please move to a better lit area and try again.';
        });
        return;
      }

      setState(() {
        _isCapturing = false;
        _isProcessing = true;
        _processingMessage = _processingMessages[0];
      });

      await _processVerification(captured);
    } catch (e) {
      setState(() {
        _isCapturing = false;
        _hasError = true;
        _showResult = true;
        _captureSuccess = false;
        _resultMessage = 'Failed to capture photo';
        _resultDetail = 'Please try again.';
      });
    }
  }

  Future<_BrightnessCheck> _checkBrightness(XFile image) async {
    try {
      final bytes = await image.readAsBytes();
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final bitmap = frame.image;
      final byteData = await bitmap.toByteData();
      codec.dispose();

      if (byteData == null) {
        return _BrightnessCheck(false, 'Could not analyze image');
      }

      final pixels = byteData.buffer.asUint8List();
      double totalBrightness = 0;
      int count = 0;

      for (int i = 0; i < pixels.length - 3; i += 4) {
        final r = pixels[i];
        final g = pixels[i + 1];
        final b = pixels[i + 2];
        totalBrightness += (0.299 * r + 0.587 * g + 0.114 * b);
        count++;
      }

      final avgBrightness = count > 0 ? totalBrightness / count : 128;

      if (avgBrightness < 40) {
        return _BrightnessCheck(false, 'Image too dark');
      }
      if (avgBrightness > 230) {
        return _BrightnessCheck(false, 'Image too bright');
      }

      return _BrightnessCheck(true, '');
    } catch (_) {
      return _BrightnessCheck(true, '');
    }
  }

  Future<void> _processVerification(XFile captured) async {
    setState(() => _processingMessage = _processingMessages[0]);
    await Future.delayed(const Duration(milliseconds: 500));

    if (!mounted) return;
    setState(() => _processingMessage = _processingMessages[1]);
    await Future.delayed(const Duration(milliseconds: 400));

    if (!mounted) return;
    setState(() => _processingMessage = _processingMessages[2]);
    await Future.delayed(const Duration(milliseconds: 400));

    if (!mounted) return;
    setState(() => _processingMessage = _processingMessages[3]);

    try {
      final result = await FaceVerificationService.verifyImage(
        selfieFile: File(captured.path),
      );

      if (!mounted) return;

      if (result.passed) {
        setState(() {
          _isProcessing = false;
          _showResult = true;
          _captureSuccess = true;
          _resultMessage = 'Verification successful!';
          _resultDetail = 'You can now go online.';
        });
        await Future.delayed(const Duration(milliseconds: 1500));
        if (mounted) {
          Navigator.pop(context, FaceVerifyResult(
            passed: true,
            match: true,
            score: result.score,
            reason: 'match',
            liveness: result.liveness,
            quality: result.quality,
          ));
        }
      } else {
        String message;
        String detail;

        switch (result.reason) {
          case 'quality_failed':
            message = 'Photo quality not sufficient';
            detail = _qualityFailureDetail(result);
            break;
          case 'liveness_failed':
            message = 'Liveness check failed';
            detail = 'Please ensure you are using a live photo of your face, not a picture or screen.';
            break;
          case 'face_mismatch':
            message = 'Face does not match your enrollment photo';
            detail = 'Please ensure good lighting and that your face is clearly visible.';
            break;
          case 'no_face_in_selfie':
            message = 'No face detected';
            detail = 'Please position your face inside the frame and try again.';
            break;
          case 'service_error':
            message = 'Verification service unavailable';
            detail = 'Please try again in a few moments.';
            break;
          default:
            message = 'Verification failed';
            detail = 'Please try again.';
        }

        setState(() {
          _isProcessing = false;
          _showResult = true;
          _captureSuccess = false;
          _hasError = true;
          _resultMessage = message;
          _resultDetail = detail;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isProcessing = false;
        _hasError = true;
        _showResult = true;
        _captureSuccess = false;
        _resultMessage = 'Verification failed';
        _resultDetail = _getNetworkErrorMessage(e);
      });
    }
  }

  String _qualityFailureDetail(FaceVerifyResult result) {
    final quality = result.quality;
    if (quality == null) return 'Please retake with better lighting.';
    final reasons = quality['reasons'] as List<dynamic>?;
    if (reasons == null || reasons.isEmpty) return 'Please retake with better lighting.';
    return reasons.join('\n');
  }

  String _getNetworkErrorMessage(dynamic e) {
    // Surface the backend's actual error message when present so the user
    // sees the real reason (e.g. "No reference image found…") instead of a
    // generic fallback.
    if (e is DioException && e.response?.data is Map) {
      final data = e.response!.data as Map;
      final serverMsg = data['error'] ?? data['message'];
      if (serverMsg is String && serverMsg.isNotEmpty) {
        return serverMsg;
      }
    }
    final msg = e.toString().toLowerCase();
    if (msg.contains('timeout')) return 'Request timed out. Please check your connection and try again.';
    if (msg.contains('connection') || msg.contains('network')) return 'Network error. Please check your internet connection.';
    return 'An unexpected error occurred. Please try again.';
  }

  void _retake() {
    setState(() {
      _showResult = false;
      _hasError = false;
      _captureSuccess = false;
      _resultMessage = '';
      _resultDetail = '';
      _capturedImage = null;
    });
  }

  void _exitWithError() {
    Navigator.pop(context, FaceVerifyResult(
      passed: false,
      match: false,
      score: 0,
      reason: 'client_error',
      quality: null,
      liveness: null,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: FutureBuilder(
          future: _initFuture,
          builder: (context, snap) {
            if (_camera == null) {
              return const Center(
                child: CircularProgressIndicator(color: _cream),
              );
            }
            return _buildCaptureUI();
          },
        ),
      ),
    );
  }

  Widget _buildCaptureUI() {
    final controller = _camera!;

    return LayoutBuilder(
      builder: (context, constraints) {
        final screenWidth = constraints.maxWidth;
        final screenHeight = constraints.maxHeight;
        
        final previewSize = controller.value.previewSize;
        final previewWidth = previewSize?.width ?? screenWidth;
        final previewHeight = previewSize?.height ?? screenHeight;
        
        final double previewAspectRatio = previewWidth / previewHeight;
        final double screenAspectRatio = screenWidth / screenHeight;
        
        final bool isPreviewPillarboxed = previewAspectRatio < screenAspectRatio;
        
        double previewVisibleWidth;
        double previewVisibleHeight;
        double previewStartX;
        double previewStartY;
        
        if (isPreviewPillarboxed) {
          previewVisibleWidth = screenHeight * previewAspectRatio;
          previewVisibleHeight = screenHeight;
          previewStartX = (screenWidth - previewVisibleWidth) / 2;
          previewStartY = 0;
        } else {
          previewVisibleWidth = screenWidth;
          previewVisibleHeight = screenWidth / previewAspectRatio;
          previewStartX = 0;
          previewStartY = (screenHeight - previewVisibleHeight) / 2;
        }
        
        // Visible camera preview region within the available (SafeArea) box.
        final double centerX = previewStartX + previewVisibleWidth / 2;
        final double centerY = previewStartY + previewVisibleHeight / 2;

        // Responsive oval sizing: scale to the visible preview, clamped so it
        // never overflows small screens nor looks tiny on tablets.
        final double ovalWidth = (previewVisibleWidth * 0.66).clamp(180.0, 420.0);
        final double ovalHeight = (ovalWidth * 1.3).clamp(234.0, 546.0);

        // Slightly above the vertical midpoint of the *visible preview*.
        final double ovalCenterX = centerX;
        final double ovalCenterY = centerY - (previewVisibleHeight * 0.22);

        return Stack(
          children: [
            Positioned.fill(
              child: ClipRect(
                child: OverflowBox(
                  alignment: Alignment.center,
                  child: FittedBox(
                    fit: BoxFit.cover,
                    child: SizedBox(
                      width: previewWidth,
                      height: previewHeight,
                      child: CameraPreview(controller),
                    ),
                  ),
                ),
              ),
            ),

            // Scrim + frame share the SAME coordinate space (the fill box) and
            // the SAME center/size, so they can never drift apart.
            Positioned.fill(
              child: CustomPaint(
                painter: _FaceOverlayPainter(
                  ovalSize: Size(ovalWidth, ovalHeight),
                  center: Offset(ovalCenterX, ovalCenterY),
                  scrimColor: Colors.black.withOpacity(0.55),
                  strokeColor: _cream,
                  cornerColor: _sage,
                ),
              ),
            ),

            Positioned(
              top: 12,
              left: 12,
              right: 12,
              child: Row(
                children: [
                  IconButton(
                    onPressed: _isProcessing ? null : () => Navigator.pop(context),
                    icon: const Icon(Icons.close, color: Colors.white),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Face Verification',
                      style: GoogleFonts.inter(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            if (_isProcessing)
              _buildProcessingOverlay()
            else if (_showResult)
              _buildResultCard()
            else
              _buildCapturePrompt(),
          ],
        );
      },
    );
  }

  Widget _buildCapturePrompt() {
    return Positioned(
      left: 16,
      right: 16,
      bottom: 28,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        decoration: BoxDecoration(
          color: _cream,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Position your face inside the frame',
              textAlign: TextAlign.center,
              style: GoogleFonts.inter(
                color: _darkForest,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Make sure you\'re in a well-lit area',
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.6),
                fontSize: 12,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Look directly at the camera',
              style: GoogleFonts.inter(
                color: _darkForest.withOpacity(0.5),
                fontSize: 11,
              ),
            ),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _isCapturing ? null : _captureSelfie,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _sage,
                  foregroundColor: Colors.white,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                ),
                child: _isCapturing
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : Text(
                        'TAKE SELFIE',
                        style: GoogleFonts.inter(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                        ),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildProcessingOverlay() {
    return Container(
      color: Colors.black.withOpacity(0.7),
      child: Center(
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 40),
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 32),
          decoration: BoxDecoration(
            color: _cream,
            borderRadius: BorderRadius.circular(24),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 48,
                height: 48,
                child: CircularProgressIndicator(
                  strokeWidth: 3,
                  color: _sage,
                ),
              ),
              const SizedBox(height: 20),
              Text(
                _processingMessage,
                style: GoogleFonts.inter(
                  color: _darkForest,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Please wait while we verify your identity',
                style: GoogleFonts.inter(
                  color: _darkForest.withOpacity(0.6),
                  fontSize: 12,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildResultCard() {
    return Positioned(
      left: 16,
      right: 16,
      bottom: 28,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
        decoration: BoxDecoration(
          color: _cream,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              _captureSuccess ? Icons.check_circle_outline : Icons.error_outline,
              color: _captureSuccess ? _sage : _terracotta,
              size: 40,
            ),
            const SizedBox(height: 12),
            Text(
              _resultMessage,
              textAlign: TextAlign.center,
              style: GoogleFonts.inter(
                color: _captureSuccess ? _sage : _terracotta,
                fontSize: 18,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (_resultDetail.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                _resultDetail,
                textAlign: TextAlign.center,
                style: GoogleFonts.inter(
                  color: _darkForest.withOpacity(0.7),
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
            ],
            const SizedBox(height: 16),
            if (!_captureSuccess)
              SizedBox(
                width: double.infinity,
                child: ElevatedButton(
                  onPressed: _retake,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: _sage,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(16),
                    ),
                  ),
                  child: Text(
                    'TRY AGAIN',
                    style: GoogleFonts.inter(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              )
            else
              const SizedBox.shrink(),
          ],
        ),
      ),
    );
  }
}

class _BrightnessCheck {
  final bool passed;
  final String message;

  _BrightnessCheck(this.passed, this.message);
}

class _FaceOverlayPainter extends CustomPainter {
  final Size ovalSize;
  final Offset center;
  final Color scrimColor;
  final Color strokeColor;
  final Color cornerColor;

  const _FaceOverlayPainter({
    required this.ovalSize,
    required this.center,
    required this.scrimColor,
    required this.strokeColor,
    required this.cornerColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: center,
      width: ovalSize.width,
      height: ovalSize.height,
    );

    // 1. Dim everything outside the oval.
    final path = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addOval(rect)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(path, Paint()..color = scrimColor);

    // 2. Oval outline (uses the SAME rect, same coordinate space).
    canvas.drawOval(
      rect,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = strokeColor.withOpacity(0.6),
    );

    // 3. Corner accents.
    final rx = ovalSize.width / 2;
    final ry = ovalSize.height / 2;
    const cl = 28.0;
    const inset = 6.0;
    final cornerPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round
      ..color = cornerColor;

    final corners = [
      Offset(center.dx - rx + inset, center.dy - ry + inset),
      Offset(center.dx + rx - inset, center.dy - ry + inset),
      Offset(center.dx + rx - inset, center.dy + ry - inset),
      Offset(center.dx - rx + inset, center.dy + ry - inset),
    ];

    for (final c in corners) {
      final dx = c.dx < center.dx ? 1.0 : -1.0;
      final dy = c.dy < center.dy ? 1.0 : -1.0;
      canvas.drawLine(c, Offset(c.dx + dx * cl, c.dy), cornerPaint);
      canvas.drawLine(c, Offset(c.dx, c.dy + dy * cl), cornerPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _FaceOverlayPainter old) =>
      old.ovalSize != ovalSize ||
      old.center != center ||
      old.scrimColor != scrimColor ||
      old.strokeColor != strokeColor ||
      old.cornerColor != cornerColor;
}
