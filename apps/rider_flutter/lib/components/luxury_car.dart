// lib/components/luxury_car.dart
//
// Premium "3D-style" luxury car visual drawn with CustomPainter — no image
// assets, no external packages. Layered gradients + highlights + ground
// shadow give a render-like look (Uber Black / Lyft Lux feel).

import 'package:flutter/material.dart';

class LuxuryCarVisual extends StatelessWidget {
  const LuxuryCarVisual({
    super.key,
    this.width = 96,
    this.height = 52,
    this.bodyColor = const Color(0xFF2F3A32),
  });

  final double width;
  final double height;
  final Color bodyColor;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      height: height,
      child: Transform.rotate(
        angle: -0.015,
        child: CustomPaint(painter: _LuxuryCarPainter(bodyColor: bodyColor)),
      ),
    );
  }
}

class _LuxuryCarPainter extends CustomPainter {
  _LuxuryCarPainter({required this.bodyColor});

  final Color bodyColor;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;

    // ---- ground shadow --------------------------------------------------
    final shadowPaint = Paint()
      ..shader = RadialGradient(
        colors: [
          Colors.black.withOpacity(0.28),
          Colors.black.withOpacity(0.10),
          Colors.transparent,
        ],
        stops: const [0.1, 0.55, 1.0],
      ).createShader(
        Rect.fromCenter(
          center: Offset(w / 2, h - 2),
          width: w * 0.96,
          height: h * 0.30,
        ),
      );
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(w / 2, h - 2),
        width: w * 0.92,
        height: h * 0.22,
      ),
      shadowPaint,
    );

    final bodyTop = h * 0.20;
    final bodyBottom = h * 0.86;

    // ---- wheels ---------------------------------------------------------
    final wheelCenters = [Offset(w * 0.24, bodyBottom), Offset(w * 0.74, bodyBottom)];
    for (final c in wheelCenters) {
      final arch = Paint()..color = const Color(0xFF1A1F1B);
      canvas.drawCircle(c + const Offset(0, 1.5), h * 0.17, arch);
      final tire = Paint()
        ..shader = RadialGradient(
          colors: const [Color(0xFF3A3F3B), Color(0xFF10130F)],
          stops: const [0.0, 1.0],
        ).createShader(Rect.fromCircle(center: c, radius: h * 0.14));
      canvas.drawCircle(c, h * 0.14, tire);
      final hub = Paint()
        ..shader = RadialGradient(
          colors: const [Color(0xFFD9D4CA), Color(0xFF9A9489)],
          stops: const [0.0, 1.0],
        ).createShader(Rect.fromCircle(center: c, radius: h * 0.06));
      canvas.drawCircle(c, h * 0.06, hub);
      final hubRing = Paint()
        ..color = Colors.white.withOpacity(0.55)
        ..style = PaintingStyle.stroke
        ..strokeWidth = h * 0.018;
      canvas.drawCircle(c, h * 0.035, hubRing);
    }

    // ---- body -----------------------------------------------------------
    final bodyPath = Path()
      ..moveTo(w * 0.06, bodyBottom)
      ..lineTo(w * 0.06, bodyTop + h * 0.22)
      ..quadraticBezierTo(w * 0.07, bodyTop + h * 0.06, w * 0.16, bodyTop + h * 0.03)
      ..lineTo(w * 0.42, bodyTop)
      ..quadraticBezierTo(w * 0.50, bodyTop - h * 0.06, w * 0.56, bodyTop + h * 0.02)
      ..lineTo(w * 0.80, bodyTop + h * 0.10)
      ..quadraticBezierTo(w * 0.92, bodyTop + h * 0.16, w * 0.93, bodyTop + h * 0.30)
      ..lineTo(w * 0.95, bodyBottom)
      ..close();

    final bodyPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Color.lerp(bodyColor, Colors.white, 0.22)!,
          bodyColor,
          Color.lerp(bodyColor, Colors.black, 0.45)!,
        ],
        stops: const [0.0, 0.45, 1.0],
      ).createShader(Rect.fromLTWH(0, bodyTop, w, bodyBottom - bodyTop));
    canvas.drawPath(bodyPath, bodyPaint);

    // gloss highlight along the shoulder line
    final gloss = Paint()
      ..color = Colors.white.withOpacity(0.30)
      ..style = PaintingStyle.stroke
      ..strokeWidth = h * 0.028
      ..strokeCap = StrokeCap.round;
    final glossPath = Path()
      ..moveTo(w * 0.085, bodyTop + h * 0.10)
      ..quadraticBezierTo(w * 0.40, bodyTop - h * 0.02, w * 0.80, bodyTop + h * 0.16);
    canvas.drawPath(glossPath, gloss);

    // lower trim reflection
    final trim = Paint()
      ..color = Colors.white.withOpacity(0.10)
      ..style = PaintingStyle.stroke
      ..strokeWidth = h * 0.022
      ..strokeCap = StrokeCap.round;
    final trimPath = Path()
      ..moveTo(w * 0.09, bodyBottom - h * 0.07)
      ..quadraticBezierTo(w * 0.5, bodyBottom - h * 0.11, w * 0.92, bodyBottom - h * 0.07);
    canvas.drawPath(trimPath, trim);

    // ---- cabin glass -----------------------------------------------------
    final glassPath = Path()
      ..moveTo(w * 0.30, bodyTop + h * 0.045)
      ..lineTo(w * 0.46, bodyTop - h * 0.015)
      ..lineTo(w * 0.58, bodyTop + h * 0.02)
      ..lineTo(w * 0.58, bodyTop + h * 0.24)
      ..lineTo(w * 0.30, bodyTop + h * 0.24)
      ..close();
    final glassPaint = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [
          Color.lerp(bodyColor, Colors.black, 0.55)!,
          Color.lerp(bodyColor, Colors.black, 0.25)!,
        ],
      ).createShader(Rect.fromLTWH(w * 0.30, bodyTop, w * 0.30, h * 0.30));
    canvas.drawPath(glassPath, glassPaint);

    // glass reflection streak
    final streak = Paint()
      ..color = Colors.white.withOpacity(0.35)
      ..style = PaintingStyle.stroke
      ..strokeWidth = h * 0.02
      ..strokeCap = StrokeCap.round;
    final streakPath = Path()
      ..moveTo(w * 0.335, bodyTop + h * 0.055)
      ..lineTo(w * 0.46, bodyTop + h * 0.005);
    canvas.drawPath(streakPath, streak);

    // headlight + taillight
    final headlight = Paint()..color = const Color(0xFFFFF4D6);
    canvas.drawCircle(Offset(w * 0.92, bodyTop + h * 0.28), h * 0.035, headlight);
    final taillight = Paint()..color = const Color(0xFFB34040);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(w * 0.045, bodyTop + h * 0.16, w * 0.028, h * 0.12),
        Radius.circular(h * 0.02),
      ),
      taillight,
    );
  }

  @override
  bool shouldRepaint(_LuxuryCarPainter oldDelegate) =>
      oldDelegate.bodyColor != bodyColor;
}

/// Convenience math exposure for the optional parallax tilt used by callers.
double luxuryCarTilt(double parallax) => parallax * 0.03 - 0.015;
