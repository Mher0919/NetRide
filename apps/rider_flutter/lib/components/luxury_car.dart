// lib/components/luxury_car.dart
//
// Premium luxury-SUV visual, rendered as a 3/4 front view facing the rider:
// the front-left corner of the vehicle is angled toward the viewer so the
// grille, headlight and near-side wheel read clearly. No image assets — the
// whole silhouette is hand-painted with layered paths, gradients and specular
// highlights so it scales crisply at any size.
//
// Performance notes:
// - Wrapped in RepaintBoundary at call sites (map sheet / wallet screen).
// - `_LuxuryCarPainter.shouldRepaint` only returns true when size or tint
//   changes, so drag / expansion frames reuse the rasterized layer instead
//   of re-painting the canvas.
// - The settle entrance animation runs once on first mount (fade + scale).

import 'dart:math';
import 'package:flutter/material.dart';

class LuxuryCarVisual extends StatefulWidget {
  final double width;
  final double height;
  final Color? bodyColor;

  const LuxuryCarVisual({
    super.key,
    this.width = 96,
    this.height = 50,
    this.bodyColor,
  });

  @override
  State<LuxuryCarVisual> createState() => _LuxuryCarVisualState();
}

class _LuxuryCarVisualState extends State<LuxuryCarVisual>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  late final Animation<double> _progress;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 560),
    ).. forward(from: 0);
    _progress = CurvedAnimation(parent: _ctrl, curve: Curves.easeOutCubic);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bodyColor = widget.bodyColor ?? const Color(0xFF1E2230);
    return AnimatedBuilder(
      animation: _progress,
      builder: (context, child) {
        final p = _progress.value;
        // Settle: scale up from 0.82 and lift up by 6px, fade in.
        final scale = 0.82 + 0.18 * p;
        final lift = (1 - p) * 6;
        final opacity = p;
        return Opacity(
          opacity: opacity,
          child: Transform.translate(
            offset: Offset(0, -lift),
            child: Transform.scale(
              scale: scale,
              child: child,
            ),
          ),
        );
      },
      child: SizedBox(
        width: widget.width,
        height: widget.height,
        child: CustomPaint(
          painter: _LuxuryCarPainter(bodyColor: bodyColor),
        ),
      ),
    );
  }
}

class _LuxuryCarPainter extends CustomPainter {
  final Color bodyColor;

  const _LuxuryCarPainter({required this.bodyColor});

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;

    // -- Ground shadow (elliptical, rear-weighted) --------------------------
    final shadowPaint = Paint()
      ..isAntiAlias = true
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 2.5);
    final shadowRect = Rect.fromLTWH(
      w * 0.10, h * 0.82, w * 0.72, h * 0.10,
    );
    final shadowShader = const LinearGradient(
      begin: Alignment.topCenter,
      end: Alignment.bottomCenter,
      colors: [Color(0x33000000), Color(0x00000000)],
    ).createShader(shadowRect);
    shadowPaint.shader = shadowShader;
    canvas.drawOval(shadowRect, shadowPaint);

    // Helper palette.
    final bodyGrad = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill;
    bodyGrad.shader = LinearGradient(
      begin: Alignment(-0.2, -0.7),
      end: Alignment(0.5, 0.6),
      colors: [
        bodyColor.withOpacity(1.0),
        bodyColor.withOpacity(0.78),
      ],
    ).createShader(Rect.fromLTWH(0, 0, w, h));

    final chrome = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0xFFE8D9B5);

    final chromeDark = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0xFF9CA8AE);

    final glassPaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill;
    glassPaint.shader = const LinearGradient(
      begin: Alignment(-0.1, -0.6),
      end: Alignment(0.4, 0.4),
      colors: [Color(0x70E8F0FF), Color(0x55C2D1FF), Color(0x80B3C6FF)],
    ).createShader(Rect.fromLTWH(0, 0, w, h));

    final highlight = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0x55FFFFFF);

    // -- Tires / wheels ----------------------------------------------------
    // Front wheel (near viewer): large, slightly tilted.
    _drawWheel(canvas, w * 0.30, h * 0.70, w * 0.13, h * 0.08, rotate: 0.18);
    // Rear wheel (foreshortened by perspective).
    _drawWheel(canvas, w * 0.72, h * 0.72, w * 0.10, h * 0.062, rotate: 0.12);

    // -- Body: front fascia (hood + grille opening) -----------------------
    final grilleLeft = w * 0.36;
    final grilleRight = w * 0.48;
    final grilleTop = h * 0.56;
    final grilleBottom = h * 0.72;
    final frontTop = h * 0.34; // windshield base / hood apex

    final hoodPath = Path()
      ..moveTo(grilleLeft, grilleBottom)
      ..lineTo(grilleRight, grilleBottom)
      ..lineTo(w * 0.52, frontTop)
      ..lineTo(w * 0.34, frontTop)
      ..close();
    canvas.drawPath(hoodPath, bodyGrad);

    // Chromed grille surround (vertical bars).
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTRB(grilleLeft + w * 0.012, grilleTop, grilleRight - w * 0.012, grilleBottom - h * 0.03),
        Radius.circular(w * 0.03),
      ),
      chromeDark,
    );
    final barWidth = w * 0.018;
    for (var i = 0; i < 5; i++) {
      final x = grilleLeft + w * 0.04 + i * (w * 0.034);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, grilleTop + w * 0.02, barWidth, grilleBottom - grilleTop - w * 0.06),
          Radius.circular(barWidth / 2),
        ),
        chrome,
      );
    }

    // -- Headlight (front-right) -------------------------------------------
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(w * 0.50, grilleTop + h * 0.08, w * 0.10, h * 0.07),
        Radius.circular(w * 0.022),
      ),
      chrome,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(w * 0.51, grilleTop + h * 0.09, w * 0.04, h * 0.045),
        Radius.circular(w * 0.008),
      ),
      Paint()..color = const Color(0x88FFFFFF),
    );

    // -- Side + roof silhouette -------------------------------------------
    final sidePath = Path()
      ..moveTo(grilleRight, grilleBottom) // front fender base
      ..lineTo(grilleRight + w * 0.02, grilleBottom - h * 0.02)
      ..lineTo(w * 0.86, h * 0.58) // rear C-pillar base (roof rear)
      ..lineTo(w * 0.89, h * 0.56) // rear roof peak / spoiler
      ..lineTo(w * 0.86, grilleBottom) // rear fender tail
      ..lineTo(w * 0.56, grilleBottom) // rocker sill back half
      ..lineTo(w * 0.48, grilleBottom + h * 0.02) // just below sill for thickness
      ..lineTo(w * 0.48, grilleBottom)
      ..lineTo(grilleRight, grilleBottom)
      ..close();
    canvas.drawPath(sidePath, bodyGrad);

    // -- Windshield + side window (glass) ----------------------------------
    canvas.save();
    canvas.clipRect(Rect.fromLTWH(0, 0, w, h * 0.82));
    final glassPath = Path()
      ..moveTo(grilleRight - w * 0.03, grilleBottom - h * 0.18) // A-pillar base
      ..lineTo(w * 0.46, frontTop - h * 0.24) // windshield top
      ..lineTo(w * 0.82, h * 0.56) // rear glass top (C-pillar)
      ..lineTo(w * 0.82, grilleBottom) // rear glass bottom
      ..lineTo(grilleRight, grilleBottom - h * 0.10)
      ..close();
    canvas.drawPath(glassPath, glassPaint);
    canvas.restore();

    // -- Chrome roof strip (shark antenna / roof rail) ---------------------
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(w * 0.74, h * 0.40, w * 0.16, h * 0.03),
        Radius.circular(h * 0.015),
      ),
      chromeDark,
    );

    // -- Specular highlights -----------------------------------------------
    final hoodHighlight = Path()
      ..moveTo(w * 0.36, frontTop)
      ..lineTo(w * 0.50, frontTop)
      ..lineTo(w * 0.49, frontTop + h * 0.16)
      ..lineTo(w * 0.37, frontTop + h * 0.10)
      ..close();
    canvas.drawPath(hoodHighlight, highlight);

    final roofHighlight = Path()
      ..moveTo(w * 0.50, frontTop - h * 0.10)
      ..lineTo(w * 0.74, h * 0.42)
      ..lineTo(w * 0.72, h * 0.46)
      ..lineTo(w * 0.52, frontTop - h * 0.06)
      ..close();
    canvas.drawPath(roofHighlight, highlight);
  }

  void _drawWheel(
    Canvas canvas,
    double cx,
    double cy,
    double rx,
    double ry, {
    double rotate = 0,
  }) {
    final tirePaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0xFF0A0A0C);

    final rimPaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0xFF5A6472);

    final hubPaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.fill
      ..color = const Color(0xFF1F2937);

    final chromeRingPaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.stroke
      ..strokeWidth = 0.6
      ..color = const Color(0xFFD1D5DB);

    canvas.save();
    canvas.translate(cx, cy);
    canvas.rotate(rotate);

    // Tire (outer ellipse).
    canvas.drawOval(Rect.fromLTWH(-rx, -ry, rx * 2, ry * 2), tirePaint);

    // Rim.
    final rimW = rx * 0.60;
    final rimH = ry * 0.60;
    canvas.drawOval(Rect.fromLTWH(-rimW, -rimH, rimW * 2, rimH * 2), rimPaint);

    // Spinner hub.
    canvas.drawCircle(const Offset(0, 0), rx * 0.18, hubPaint);

    // Chrome ring + spoke highlights.
    canvas.drawOval(Rect.fromLTWH(-rx, -ry, rx * 2, ry * 2), chromeRingPaint);

    // Spokes (three, 120° apart).
    final spokePaint = Paint()
      ..isAntiAlias = true
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = const Color(0x40FFFFFF);
    for (var i = 0; i < 3; i++) {
      final angle = (i / 3) * pi * 2;
      final ex = (rimW - 1) * cos(angle);
      final ey = (rimH - 1) * sin(angle);
      canvas.drawLine(Offset.zero, Offset(ex, ey), spokePaint);
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _LuxuryCarPainter old) {
    return old.bodyColor != bodyColor;
  }

  @override
  bool shouldRebuildSemantics(covariant _LuxuryCarPainter old) => false;
}
