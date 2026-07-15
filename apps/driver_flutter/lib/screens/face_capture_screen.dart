import 'dart:async';
import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import '../services/face_verification_service.dart';

/// Live-capture screen with the dashed head outline overlay (Uber-style).
///
/// Flow:
///   1. Initialize camera (rear-camera first, fallback to any available).
///   2. Show dashed head outline + "TAP TO START" pill.
///   3. On tap → countdown 3-2-1, then start recording.
///   4. During recording, show each liveness prompt ("Look left"…) for 3 seconds
///      with a visible countdown and progress bar.
///   5. Stop early if the user taps "STOP" or auto-stop after all prompts.
///   6. POST /api/face/verify with the clip + the cached enrollment image.
///   7. Show inline PASS / FAIL, then `Navigator.pop` with the result.
class FaceCaptureScreen extends StatefulWidget {
  final String reason;

  const FaceCaptureScreen({
    super.key,
    this.reason = 'verification',
  });

  @override
  State<FaceCaptureScreen> createState() => _FaceCaptureScreenState();
}

class _FaceCaptureScreenState extends State<FaceCaptureScreen>
    with TickerProviderStateMixin {
  CameraController? _camera;
  Future<void>? _initFuture;
  bool _isRecording = false;
  bool _isCountingDown = false;
  bool _isStarting = false;
  bool _isSubmitting = false;
  int _countdownValue = 3;

  // Sequential prompt state.
  static const int _secondsPerPrompt = 3;
  int _currentPromptStep = 0;
  int _promptSecondsRemaining = _secondsPerPrompt;
  Timer? _promptTimer;

  Timer? _countdownTimer;

  // Animation for the dashed outline pulse.
  late final AnimationController _pulseController;

  // App palette (kept consistent with the rest of the app).
  static const Color _cream = Color(0xFFF7F4EF);
  static const Color _sage = Color(0xFF5B7760);
  static const Color _terracotta = Color(0xFFC65A5A);
  static const Color _darkForest = Color(0xFF2F3A32);

  static const _prompts = [
    'Look left',
    'Look right',
    'Smile',
    'Blink twice',
  ];

  @override
  void initState() {
    super.initState();
    _pulseController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
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
    // Prefer the front camera (selfie). Fall back to whatever's there.
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
    _countdownTimer?.cancel();
    _promptTimer?.cancel();
    _pulseController.dispose();
    _camera?.dispose();
    super.dispose();
  }

  Future<void> _startCaptureFlow() async {
    if (_camera == null || _isRecording || _isCountingDown || _isStarting) return;

    setState(() {
      _isStarting = true;
      _isCountingDown = true;
      _countdownValue = 3;
    });
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) async {
      if (!mounted) return;
      if (_countdownValue <= 1) {
        timer.cancel();
        setState(() {
          _isStarting = false;
          _isCountingDown = false;
          _countdownValue = 3;
          _currentPromptStep = 0;
          _promptSecondsRemaining = _secondsPerPrompt;
        });
        await _startRecording();
      } else {
        setState(() => _countdownValue -= 1);
      }
    });
  }

  Future<void> _startRecording() async {
    if (_camera == null) return;

    setState(() => _isRecording = true);

    try {
      await _camera!.startVideoRecording();
    } catch (e) {
      _showErrorAndExit('Failed to start camera: $e');
      return;
    }

    _advancePrompt();
  }

  /// Show the current prompt for [_secondsPerPrompt] seconds, then advance
  /// to the next prompt or stop when all prompts are complete.
  void _advancePrompt() {
    if (!mounted || _camera == null) return;
    _promptTimer?.cancel();

    if (_currentPromptStep >= _prompts.length) {
      _stopAndSubmit();
      return;
    }

    setState(() {
      _promptSecondsRemaining = _secondsPerPrompt;
    });

    _promptTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (_promptSecondsRemaining <= 1) {
        timer.cancel();
        setState(() {
          _currentPromptStep++;
        });
        _advancePrompt();
      } else {
        setState(() => _promptSecondsRemaining--);
      }
    });
  }

  Future<void> _stopAndSubmit() async {
    if (_camera == null || !_isRecording || _isSubmitting) return;
    _isSubmitting = true;
    _promptTimer?.cancel();

    XFile? captured;
    try {
      captured = await _camera!.stopVideoRecording();
    } catch (e) {
      _showErrorAndExit('Recording failed: $e');
      return;
    }

    if (!mounted) return;
    setState(() => _isRecording = false);

    // Move the captured clip into a permanent location so it survives the
    // platform's tmp cleanup, then upload it together with the user's
    // cached enrollment photo.
    try {
      final dir = await getTemporaryDirectory();
      final savedPath = p.join(dir.path, 'face_capture_${DateTime.now().millisecondsSinceEpoch}.mp4');
      final capturedFile = captured;
      if (capturedFile == null) {
        _showErrorAndExit('Recording returned no file.');
        return;
      }
      await File(capturedFile.path).copy(savedPath);

      final prefs = await _loadCachedReference();
      if (prefs == null) {
        _showErrorAndExit('No reference image found. Please re-enroll your face from your profile.');
        return;
      }

      final result = await FaceVerificationService.verify(
        clipFile: File(savedPath),
        referenceFile: prefs,
      );

      if (!mounted) return;
      _isSubmitting = false;
      Navigator.pop(context, result);
    } catch (e) {
      _isSubmitting = false;
      _showErrorAndExit('Upload failed: $e');
    }
  }

  Future<File?> _loadCachedReference() async {
    // The reference image is whatever the user uploaded as their profile
    // photo at onboarding. We stored it locally in shared_prefs (path).
    // Falls back to the platform's files dir if needed.
    final dir = await getApplicationDocumentsDirectory();
    final refPath = p.join(dir.path, 'face_enrollment.jpg');
    final f = File(refPath);
    return f.existsSync() ? f : null;
  }

  void _showErrorAndExit(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: _terracotta),
    );
    Navigator.pop(context, FaceVerifyResult(
      passed: false,
      match: false,
      score: 0,
      reason: 'client_error',
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
    final size = MediaQuery.of(context).size;

    return Stack(
      children: [
        // Camera preview (mirrored for selfie)
        Positioned.fill(
          child: ClipRect(
            child: OverflowBox(
              alignment: Alignment.center,
              child: FittedBox(
                fit: BoxFit.cover,
                child: SizedBox(
                  width: controller.value.previewSize?.height ?? size.width,
                  height: controller.value.previewSize?.width ?? size.height,
                  child: CameraPreview(controller),
                ),
              ),
            ),
          ),
        ),

        // Dark scrim around the cutout so the dashed outline pops
        Positioned.fill(
          child: CustomPaint(
            painter: _CutoutScrimPainter(
              ovalSize: const Size(240, 320),
              color: Colors.black.withOpacity(0.55),
            ),
          ),
        ),

        // Animated dashed head outline
        Center(
          child: AnimatedBuilder(
            animation: _pulseController,
            builder: (context, _) {
              return CustomPaint(
                size: const Size(240, 320),
                painter: _DashedHeadOutlinePainter(
                  progress: _pulseController.value,
                  strokeColor: _cream,
                  dashColor: _sage,
                ),
              );
            },
          ),
        ),

        // Top bar with title + close
        Positioned(
          top: 12,
          left: 12,
          right: 12,
          child: Row(
            children: [
              IconButton(
                onPressed: () => Navigator.pop(context),
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

        // Bottom instruction card
        Positioned(
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
                if (_isCountingDown) ...[
                  Text(
                    '$_countdownValue',
                    style: GoogleFonts.inter(
                      color: _sage,
                      fontSize: 56,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Get ready…',
                    style: GoogleFonts.inter(
                      color: _darkForest,
                      fontSize: 14,
                    ),
                  ),
                ] else if (_isRecording) ...[
                  Text(
                    _prompts[_currentPromptStep < _prompts.length ? _currentPromptStep : _prompts.length - 1],
                    style: GoogleFonts.inter(
                      color: _sage,
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Step ${(_currentPromptStep < _prompts.length ? _currentPromptStep : _prompts.length - 1) + 1} of ${_prompts.length}',
                    style: GoogleFonts.inter(
                      color: _darkForest.withOpacity(0.6),
                      fontSize: 12,
                    ),
                  ),
                  const SizedBox(height: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: _promptSecondsRemaining / _secondsPerPrompt,
                      backgroundColor: _darkForest.withOpacity(0.1),
                      valueColor: const AlwaysStoppedAnimation<Color>(_sage),
                      minHeight: 4,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${_promptSecondsRemaining}s',
                    style: GoogleFonts.inter(
                      color: _darkForest,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: _isSubmitting ? null : _stopAndSubmit,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: _terracotta,
                        foregroundColor: Colors.white,
                      ),
                      child: _isSubmitting
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Text('STOP'),
                    ),
                  ),
                ] else ...[
                  Text(
                    'Position your face inside the outline',
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
                  const SizedBox(height: 14),
                  SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: _isStarting ? null : _startCaptureFlow,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: _sage,
                        foregroundColor: Colors.white,
                      ),
                      child: _isStarting
                          ? const SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : const Text('TAP TO START'),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// Scrim with a transparent oval cutout so the face is the only well-lit
/// region on the screen.
class _CutoutScrimPainter extends CustomPainter {
  final Size ovalSize;
  final Color color;

  _CutoutScrimPainter({required this.ovalSize, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final oval = Rect.fromCenter(
      center: Offset(size.width / 2, size.height / 2),
      width: ovalSize.width,
      height: ovalSize.height,
    );
    final path = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addOval(oval)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(covariant _CutoutScrimPainter old) =>
      old.ovalSize != ovalSize || old.color != color;
}

/// Dashed head-shaped outline that pulses softly to invite the driver
/// inside.
class _DashedHeadOutlinePainter extends CustomPainter {
  final double progress; // 0..1
  final Color strokeColor;
  final Color dashColor;

  _DashedHeadOutlinePainter({
    required this.progress,
    required this.strokeColor,
    required this.dashColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final pulse = 1.0 + (progress * 0.04);
    final w = size.width * pulse;
    final h = size.height * pulse;

    final rect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height / 2),
      width: w,
      height: h,
    );

    final paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..color = dashColor.withOpacity(0.85);

    final path = Path()..addOval(rect);
    _drawDashedPath(canvas, path, paint, dashWidth: 8, gapWidth: 6);
  }

  void _drawDashedPath(
    Canvas canvas,
    Path path,
    Paint paint, {
    required double dashWidth,
    required double gapWidth,
  }) {
    for (final metric in path.computeMetrics()) {
      double dist = 0;
      while (dist < metric.length) {
        final next = dist + dashWidth;
        canvas.drawPath(metric.extractPath(dist, next.clamp(0, metric.length)), paint);
        dist = next + gapWidth;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedHeadOutlinePainter old) =>
      old.progress != progress || old.dashColor != dashColor;
}