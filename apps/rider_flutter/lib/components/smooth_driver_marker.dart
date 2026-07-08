import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

class SmoothDriverMarker extends StatefulWidget {
  final LatLng position;
  final double heading;
  final String driverId;

  const SmoothDriverMarker({
    super.key,
    required this.position,
    this.heading = 0,
    required this.driverId,
  });

  @override
  State<SmoothDriverMarker> createState() => _SmoothDriverMarkerState();
}

class _SmoothDriverMarkerState extends State<SmoothDriverMarker> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _latAnimation;
  late Animation<double> _lngAnimation;
  late Animation<double> _headingAnimation;
  
  LatLng _oldPosition = const LatLng(0, 0);
  double _oldHeading = 0;

  @override
  void initState() {
    super.initState();
    _oldPosition = widget.position;
    _oldHeading = widget.heading;
    
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3000), // Match update interval
    );

    _initAnimations();
  }

  void _initAnimations() {
    _latAnimation = Tween<double>(begin: _oldPosition.latitude, end: widget.position.latitude).animate(_controller);
    _lngAnimation = Tween<double>(begin: _oldPosition.longitude, end: widget.position.longitude).animate(_controller);
    _headingAnimation = Tween<double>(begin: _oldHeading, end: widget.heading).animate(_controller);
  }

  @override
  void didUpdateWidget(SmoothDriverMarker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.position != widget.position) {
      _oldPosition = oldWidget.position;
      _oldHeading = oldWidget.heading;
      
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
              child: Transform.rotate(
                angle: (_headingAnimation.value * (3.14159 / 180)),
                child: Container(
                  decoration: BoxDecoration(
                    color: Colors.white,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(color: Colors.black.withOpacity(0.2), blurRadius: 4),
                    ],
                  ),
                  child: const Icon(Icons.navigation, color: Color(0xFF2F3A32), size: 24),
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}
