import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import '../models/trip_models.dart' as models;
import '../providers/driver_provider.dart';
import '../services/gps_tracker.dart';
import '../theme/app_theme.dart';

/// Multi-stop navigation for group rides.
///
/// The stop sequence and route geometry are server-generated (group route
/// plan) and never reordered locally. Each passenger is confirmed
/// individually; the backend advances the stop and only flips the trip to
/// IN_PROGRESS when every pickup is complete.
class GroupNavigationScreen extends StatefulWidget {
  const GroupNavigationScreen({
    super.key,
    required this.trip,
    required this.onCompleteTrip,
    this.actionPending = false,
  });

  final models.Trip trip;
  final VoidCallback onCompleteTrip;
  final bool actionPending;

  @override
  State<GroupNavigationScreen> createState() => _GroupNavigationScreenState();
}

class _GroupNavigationScreenState extends State<GroupNavigationScreen> {
  final MapController _map = MapController();
  Timer? _fitTimer;
  bool _confirming = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<DriverProvider>().loadGroupRide(widget.trip.id);
    });
    GpsTracker.instance.addListener(_onGps);
  }

  @override
  void dispose() {
    _fitTimer?.cancel();
    GpsTracker.instance.removeListener(_onGps);
    super.dispose();
  }

  void _onGps() {
    if (mounted) setState(() {});
  }

  List<LatLng> _routePoints(models.DriverGroupRideView view) {
    final coords = view.geometry is Map ? view.geometry!['coordinates'] as List? : null;
    if (coords == null) return const [];
    final out = <LatLng>[];
    for (final c in coords) {
      if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
        out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
      }
    }
    return out;
  }

  void _scheduleFit(models.DriverGroupRideView view) {
    _fitTimer?.cancel();
    _fitTimer = Timer(const Duration(milliseconds: 250), () {
      if (!mounted) return;
      final points = <LatLng>[
        ..._routePoints(view),
        ...view.stops.map((s) => LatLng(s.lat, s.lng)),
        if (view.destination != null)
          LatLng(view.destination!.lat, view.destination!.lng),
      ];
      if (points.length < 2) return;
      try {
        _map.fitCamera(CameraFit.bounds(
          bounds: LatLngBounds.fromPoints(points),
          padding: const EdgeInsets.all(56),
        ));
      } catch (_) {}
    });
  }

  Future<void> _confirm(models.DriverGroupRideView view, models.DriverGroupPassenger passenger) async {
    if (_confirming) return;
    setState(() => _confirming = true);
    final error = await context.read<DriverProvider>().confirmGroupPickup(
          widget.trip.id,
          passenger.userId,
        );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  Future<void> _markNoShow(
    models.DriverGroupRideView view,
    models.DriverGroupPassenger passenger,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('${passenger.name} is not here?'),
        content: const Text(
          'Mark this passenger as a no-show? Their prepaid share is kept and the group can continue.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Mark no-show', style: TextStyle(color: Color(0xFFC65A5A))),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    if (_confirming) return;
    setState(() => _confirming = true);
    final error = await context.read<DriverProvider>().markGroupNoShow(
          widget.trip.id,
          passenger.userId,
        );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (error != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(error)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<DriverProvider>();
    final view = provider.groupRide;
    if (view == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen)),
      );
    }
    _scheduleFit(view);
    final fix = GpsTracker.instance.lastFix;
    final driverLatLng = fix != null ? fix.position : null;
    final points = _routePoints(view);
    final center = driverLatLng ??
        (view.stops.isNotEmpty
            ? LatLng(view.stops.first.lat, view.stops.first.lng)
            : (view.destination != null
                ? LatLng(view.destination!.lat, view.destination!.lng)
                : const LatLng(34.0522, -118.2437)));
    final inProgress = view.rideStatus == 'IN_PROGRESS' || view.allPickedUp;

    return Scaffold(
      backgroundColor: const Color(0xFFF3F0EB),
      body: SafeArea(
        child: Column(
          children: [
            Container(
              color: Colors.white,
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
              child: Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: AppTheme.primaryBrandGreen.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: const Text(
                      'GROUP RIDE',
                      style: TextStyle(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.5,
                        color: AppTheme.primaryBrandGreen,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          view.groupName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                        ),
                        Text(
                          inProgress
                              ? 'Heading to the shared destination'
                              : 'Pickup ${view.currentStopIndex + 1} of ${view.stops.length} · ${view.stops.fold<int>(0, (sum, s) => sum + s.passengers.length)} passengers',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w600,
                            color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: FlutterMap(
                mapController: _map,
                options: MapOptions(initialCenter: center, initialZoom: 15, minZoom: 6, maxZoom: 18),
                children: [
                  TileLayer(
                    urlTemplate:
                        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 16,
                    userAgentPackageName: 'com.NetRide.driver',
                  ),
                  if (points.length >= 2)
                    PolylineLayer(
                      polylines: [
                        Polyline(
                          points: points,
                          strokeWidth: 5,
                          color: AppTheme.primaryBrandGreen,
                        ),
                      ],
                    ),
                  MarkerLayer(
                    markers: [
                      for (final stop in view.stops)
                        Marker(
                          point: LatLng(stop.lat, stop.lng),
                          width: 34,
                          height: 34,
                          child: _StopPin(
                            sequence: stop.sequence,
                            active: !stop.completed &&
                                stop.sequence == view.currentStopIndex + 1,
                            completed: stop.completed,
                          ),
                        ),
                      if (view.destination != null)
                        Marker(
                          point: LatLng(view.destination!.lat, view.destination!.lng),
                          width: 36,
                          height: 36,
                          child: _DestPin(),
                        ),
                      if (driverLatLng != null)
                        Marker(
                          point: driverLatLng,
                          width: 42,
                          height: 42,
                          child: _DriverPin(),
                        ),
                    ],
                  ),
                ],
              ),
            ),
            _bottomSheet(view, inProgress),
          ],
        ),
      ),
    );
  }

  Widget _bottomSheet(models.DriverGroupRideView view, bool inProgress) {
    final current = view.currentStop;
    final totalPassengers = view.stops.fold<int>(0, (sum, s) => sum + s.passengers.length);
    final pickedPassengers = view.stops.fold<int>(
      0,
      (sum, s) => sum + s.passengers.where((p) => p.isPickedUp).length,
    );
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.48,
      ),
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        boxShadow: [
          BoxShadow(color: Colors.black12, blurRadius: 18, offset: Offset(0, -4)),
        ],
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    inProgress
                        ? 'On the way'
                        : 'Pickup stop ${view.currentStopIndex + 1} of ${view.stops.length}',
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                  ),
                  const Spacer(),
                  Text(
                    '$pickedPassengers/$totalPassengers picked up',
                    style: TextStyle(
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              if (inProgress) ...[
                _AddressRow(
                  icon: Icons.flag_rounded,
                  color: AppTheme.primaryBrandGreen,
                  label: 'Shared destination',
                  address: view.destination?.address ?? 'Destination',
                ),
                const SizedBox(height: 8),
                Text(
                  '${(view.totalDistanceMeters / 1609.344).toStringAsFixed(1)} mi · ${(view.totalDurationSeconds / 60).round()} min',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 14),
                SizedBox(
                  width: double.infinity,
                  height: 52,
                  child: ElevatedButton(
                    onPressed: widget.actionPending ? null : widget.onCompleteTrip,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppTheme.primaryBrandGreen,
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                    ),
                    child: const Text(
                      'COMPLETE TRIP',
                      style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 0.5),
                    ),
                  ),
                ),
              ] else if (current != null) ...[
                _AddressRow(
                  icon: Icons.location_on_rounded,
                  color: AppTheme.primaryBrandGreen,
                  label: 'Current pickup',
                  address: current.address.isEmpty ? 'Pickup point' : current.address,
                ),
                const SizedBox(height: 10),
                ...current.passengers.map(
                  (p) => Container(
                    margin: const EdgeInsets.only(bottom: 7),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    decoration: BoxDecoration(
                      color: p.isPickedUp
                          ? AppTheme.successGreen.withValues(alpha: 0.10)
                          : const Color(0xFFF7F4EF),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(
                        color: p.isPickedUp
                            ? AppTheme.successGreen.withValues(alpha: 0.5)
                            : AppTheme.softBorderColor,
                      ),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          p.isPickedUp
                              ? Icons.check_circle_rounded
                              : Icons.person_outline_rounded,
                          color: p.isPickedUp ? AppTheme.successGreen : AppTheme.primaryBrandGreen,
                          size: 20,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            p.name,
                            style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                          ),
                        ),
                        if (!p.isPickedUp) ...[
                          TextButton(
                            onPressed: _confirming ? null : () => _markNoShow(view, p),
                            style: TextButton.styleFrom(
                              padding: const EdgeInsets.symmetric(horizontal: 8),
                              minimumSize: const Size(0, 34),
                            ),
                            child: const Text(
                              'No-show',
                              style: TextStyle(fontSize: 10.5, color: Color(0xFFC65A5A)),
                            ),
                          ),
                          SizedBox(
                            height: 34,
                            child: ElevatedButton(
                              onPressed: _confirming ? null : () => _confirm(view, p),
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppTheme.primaryBrandGreen,
                                padding: const EdgeInsets.symmetric(horizontal: 14),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(10),
                                ),
                              ),
                              child: _confirming
                                  ? const SizedBox(
                                      width: 14,
                                      height: 14,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Text(
                                      'Confirm pickup',
                                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700),
                                    ),
                            ),
                          ),
                        ] else
                          Text(
                            p.status == 'NO_SHOW' ? 'No-show' : 'Picked up',
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w700,
                              color: p.status == 'NO_SHOW'
                                  ? const Color(0xFFC65A5A)
                                  : AppTheme.successGreen,
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                if (view.stops.length > 1) ...[
                  const SizedBox(height: 6),
                  const Text(
                    'UPCOMING STOPS',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.9,
                      color: Color(0xFF7C847D),
                    ),
                  ),
                  const SizedBox(height: 4),
                  ...view.stops.where((s) => s.sequence > current.sequence).map(
                        (s) => Padding(
                          padding: const EdgeInsets.symmetric(vertical: 3),
                          child: Row(
                            children: [
                              _StopPin(sequence: s.sequence, small: true),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  s.address,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 12),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AddressRow extends StatelessWidget {
  const _AddressRow({
    required this.icon,
    required this.color,
    required this.label,
    required this.address,
  });
  final IconData icon;
  final Color color;
  final String label;
  final String address;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 18, color: color),
        const SizedBox(width: 7),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700,
                  color: AppTheme.secondaryDarkText.withValues(alpha: 0.5),
                ),
              ),
              Text(
                address,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.3),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _StopPin extends StatelessWidget {
  const _StopPin({
    required this.sequence,
    this.active = false,
    this.completed = false,
    this.small = false,
  });
  final int sequence;
  final bool active;
  final bool completed;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final size = small ? 20.0 : 34.0;
    final color = completed
        ? AppTheme.successGreen
        : active
            ? const Color(0xFFC79A4A)
            : AppTheme.primaryBrandGreen;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
      ),
      alignment: Alignment.center,
      child: completed
          ? Icon(Icons.check, size: small ? 11 : 16, color: Colors.white)
          : Text(
              '$sequence',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w800,
                fontSize: small ? 9 : 13,
              ),
            ),
    );
  }
}

class _DestPin extends StatelessWidget {
  const _DestPin();
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 36,
      height: 36,
      decoration: BoxDecoration(
        color: const Color(0xFF2F3A32),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
      ),
      alignment: Alignment.center,
      child: const Icon(Icons.flag_rounded, size: 18, color: Colors.white),
    );
  }
}

class _DriverPin extends StatelessWidget {
  const _DriverPin();
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 42,
      height: 42,
      decoration: BoxDecoration(
        color: Colors.white,
        shape: BoxShape.circle,
        border: Border.all(color: AppTheme.primaryBrandGreen, width: 2),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 8)],
      ),
      alignment: Alignment.center,
      child: const Icon(Icons.navigation_rounded, color: AppTheme.primaryBrandGreen, size: 21),
    );
  }
}
