import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

/// Smoothly animated rider marker for the driver's map.
///
/// Same adaptive-tween technique as the rider app's driver marker: the
/// animation length tracks the ACTUAL incoming update cadence (~1 Hz
/// socket pushes) and mid-tween updates resume from the marker's
/// current position, so the pin glides continuously instead of
/// snapping or lagging behind.
class SmoothRiderMarker extends StatefulWidget {
  final LatLng position;

  const SmoothRiderMarker({
    super.key,
    required this.position,
  });

  @override
  State<SmoothRiderMarker> createState() => _SmoothRiderMarkerState();
}

class _SmoothRiderMarkerState extends State<SmoothRiderMarker>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _latAnimation;
  late Animation<double> _lngAnimation;

  LatLng _oldPosition = const LatLng(0, 0);
  DateTime? _lastUpdateAt;

  /// Tween length tuned to the observed update interval, clamped so a
  /// cadence blip never makes the marker crawl or teleport.
  Duration _durationFor() {
    final last = _lastUpdateAt;
    final delta = last == null
        ? const Duration(milliseconds: 1000)
        : DateTime.now().difference(last);
    final ms = delta.inMilliseconds.clamp(600, 2000);
    return Duration(milliseconds: ms);
  }

  @override
  void initState() {
    super.initState();
    _oldPosition = widget.position;
    _lastUpdateAt = DateTime.now();

    _controller = AnimationController(
      vsync: this,
      duration: _durationFor(),
    );

    _initAnimations();
  }

  void _initAnimations() {
    _latAnimation = Tween<double>(
      begin: _oldPosition.latitude,
      end: widget.position.latitude,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.linear));
    _lngAnimation = Tween<double>(
      begin: _oldPosition.longitude,
      end: widget.position.longitude,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.linear));
  }

  @override
  void didUpdateWidget(SmoothRiderMarker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.position != widget.position) {
      // Resume from the CURRENT interpolated position so a mid-tween
      // update never snaps the marker backwards.
      _oldPosition = LatLng(_latAnimation.value, _lngAnimation.value);
      _lastUpdateAt = DateTime.now();

      _controller.duration = _durationFor();
      _controller.reset();
      _initAnimations();
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        final currentPos = LatLng(_latAnimation.value, _lngAnimation.value);
        return MarkerLayer(
          markers: [
            Marker(
              point: currentPos,
              width: 40,
              height: 40,
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFF5B7760).withOpacity(0.2),
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: Colors.white,
                    width: 2,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(0.15),
                      blurRadius: 4,
                    ),
                  ],
                ),
                child: const Icon(
                  Icons.person_pin_circle,
                  color: Color(0xFF5B7760),
                  size: 30,
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}