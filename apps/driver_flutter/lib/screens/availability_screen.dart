import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../providers/driver_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/user_service.dart';
import '../services/auth_service.dart';
import '../services/api_service.dart';
import '../services/face_verification_service.dart';
import '../components/state_container.dart';
import '../components/driver_status_card.dart';
import '../services/sound_service.dart';
import 'face_capture_screen.dart';

class AvailabilityScreen extends StatefulWidget {
  const AvailabilityScreen({super.key});

  @override
  State<AvailabilityScreen> createState() => _AvailabilityScreenState();
}

class _AvailabilityScreenState extends State<AvailabilityScreen> {
  final MapController _mapController = MapController();
  StreamSubscription<Position>? _positionSubscription;
  Timer? _heartbeatTimer;
  Position? _lastPosition;
  bool _shouldFollowUser = true;
  ViewState _state = ViewState.loading;
  String? _errorMessage;
  bool _isMapReady = false;
  String _firstName = "";
  double? _tempPrice;
  bool _isDragging = false;
  String? _lastIncomingRequestId;
  bool _isTogglingOnline = false;
  bool _isConfirmingPrice = false;

  @override
  void initState() {
    super.initState();
    _checkPermissions();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!prefs.containsKey('jwt_token')) return;

      final profile = await UserService.getProfile();
      if (mounted) {
        setState(() {
          final fullName = profile['full_name'] ?? 'Driver';
          _firstName = fullName.split(' ')[0];
        });
      }

      // Pull the latest face-check gate so the banner reflects reality on
      // app open, not just on the offline-switch tap.
      final provider = Provider.of<DriverProvider>(context, listen: false);
      try {
        await provider.refreshFaceCheck(
          lat: _lastPosition?.latitude,
          lng: _lastPosition?.longitude,
        );
      } catch (_) {
        // Face-check failures are non-fatal — the gate stays in its last
        // known state.
      }

      // Also pull the latest profile-change gate (admin approval queue).
      // The provider ignores fields it already controls; calling this on
      // every boot keeps the offline-switch gate and the red banner in
      // sync with whatever the server has.
      try {
        await provider.refreshProfile();
      } catch (_) {
        // Refresh failures are non-fatal — the gate stays in its last
        // known state. The next socket-driven review will reconcile.
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        debugPrint('User not found (404), logging out...');
        await AuthService.logout();
        if (mounted) {
          Navigator.pushNamedAndRemoveUntil(context, '/login', (route) => false);
        }
        return;
      }
      debugPrint('Error fetching profile: $e');
    }
  }

  Future<void> _dismissFeedback() async {
    try {
      await ApiService.dio.patch('/ride/verification/dismiss');
      final provider = Provider.of<DriverProvider>(context, listen: false);
      // The provider will pick up the updated feedback_seen on next refreshProfile
      await provider.refreshProfile();
    } catch (e) {
      debugPrint('Error dismissing feedback: $e');
    }
  }

  void _showRejectionDetails() {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final reason = provider.rejectionReason;
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Rejection Feedback', style: TextStyle(fontWeight: FontWeight.bold)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Administrative feedback on your background check:', style: TextStyle(fontSize: 13, color: Colors.grey)),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(color: Colors.red.withOpacity(0.05), borderRadius: BorderRadius.circular(12), border: Border.all(color: Colors.red.withOpacity(0.1))),
              child: Text(
                reason ?? 'No specific reason provided. Please contact support.',
                style: const TextStyle(fontWeight: FontWeight.w600, height: 1.5),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('DISMISS')),
          ElevatedButton(
            onPressed: () {
              Navigator.pop(context);
              // Navigation to onboarding for document re-upload
            },
            style: ElevatedButton.styleFrom(backgroundColor: Colors.black, foregroundColor: Colors.white),
            child: const Text('RE-UPLOAD DOCUMENTS'),
          ),
        ],
      ),
    );
  }

  /// Show a bottom sheet listing the fields the driver submitted for admin
  /// review. Tapping the red card on the map opens this.
  void _showPendingChangeDetails() {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final summary = provider.pendingChangesSummary ?? const {};
    final since = provider.pendingSince;

    const labels = <String, String>{
      'full_name': 'Full name',
      'phone_number': 'Phone number',
      'date_of_birth': 'Date of birth',
      'profile_image_url': 'Profile photo',
      'license_number': 'License number',
      'make': 'Vehicle make',
      'model': 'Vehicle model',
      'year': 'Vehicle year',
      'color': 'Vehicle color',
      'license_plate_number': 'License plate',
      'license_plate_photo_url': 'Plate photo',
      'inspection_photo_url': 'Inspection photo',
      'car_photo_urls': 'Car photos',
      'payout_card': 'Payout card',
    };

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0xFFE0E0E0),
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Profile change under review',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 6),
                Text(
                  since == null
                      ? 'Our team is reviewing the changes below. You can\'t drive until they\'re approved.'
                      : 'Submitted ${_formatRelative(since)}. We\'ll email you once it\'s reviewed.',
                  style: const TextStyle(fontSize: 13, color: Color(0xFF6B6B6B), height: 1.4),
                ),
                const SizedBox(height: 16),
                if (summary.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('No fields to display.', style: TextStyle(color: Color(0xFF6B6B6B))),
                  )
                else
                  ...summary.entries.map((e) => Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              margin: const EdgeInsets.only(right: 10, top: 6),
                              decoration: const BoxDecoration(
                                color: Color(0xFFC65A5A),
                                shape: BoxShape.circle,
                              ),
                            ),
                            Expanded(
                              child: Text(
                                labels[e.key] ?? e.key,
                                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                              ),
                            ),
                            const Text(
                              'updated',
                              style: TextStyle(fontSize: 12, color: Color(0xFF6B6B6B), fontWeight: FontWeight.w600),
                            ),
                          ],
                        ),
                      )),
                const SizedBox(height: 8),
              ],
            ),
          ),
        );
      },
    );
  }

  String _formatRelative(DateTime dt) {
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }

  /// Build the stacked status cards at the top of the map. Driven by the
  /// single authoritative [DriverProvider.buildDriverComplianceStatus] so
  /// that every card renders with the same priority ordering.
  Widget _buildStatusCards(DriverProvider provider) {
    final status = provider.buildDriverComplianceStatus();

    // When there is no blocker and the driver is verified, show ready-to-drive.
    if (status == null) {
      if (provider.isVerified) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: DriverStatusCard(state: DriverStatus.readyToDrive),
            ),
          ],
        );
      }
      return const SizedBox.shrink();
    }

    // Map the compliance status to the corresponding DriverStatusCard.
    // The enum ordering already enforces priority; we render the
    // SINGLE highest-priority card only (no stacking).
    Widget card;
    switch (status) {
      case DriverComplianceStatus.profileChangePending:
        card = DriverStatusCard(
          state: DriverStatus.profileChangePending,
          onAction: _showPendingChangeDetails,
        );
      case DriverComplianceStatus.profileChangeApproved:
        card = DriverStatusCard(
          state: DriverStatus.profileChangeApproved,
          onDismiss: () => provider.markProfileChangeApprovedShown(),
        );
      case DriverComplianceStatus.backgroundCheckRejected:
        card = DriverStatusCard(
          state: DriverStatus.backgroundRejected,
          rejectionReason: provider.rejectionReason,
          onAction: () => _showRejectionDetails(),
        );
      case DriverComplianceStatus.backgroundCheckPending:
        card = const DriverStatusCard(state: DriverStatus.backgroundPending);
      case DriverComplianceStatus.backgroundCheckApproved:
        card = DriverStatusCard(
          state: DriverStatus.backgroundApproved,
          onDismiss: _dismissFeedback,
        );
      case DriverComplianceStatus.faceFlagged:
        card = const DriverStatusCard(state: DriverStatus.faceFlagged);
      case DriverComplianceStatus.faceCheckNeeded:
        final reason = provider.faceCheckReason;
        card = DriverStatusCard(
          state: reason != null
              ? DriverStatus.faceRequired(reason)
              : DriverStatus.faceRequired('first_time'),
          onStartFaceCheck: () => _runFaceCheck(reason: reason ?? 'first_time'),
        );
      case DriverComplianceStatus.documentActionRequired:
        card = DriverStatusCard(
          state: DriverStatus.documentActionRequired,
          onAction: () => Navigator.pushNamed(context, '/documents'),
        );
      case DriverComplianceStatus.documentSubmitted:
        card = const DriverStatusCard(
          state: DriverStatus.documentSubmittedForReview,
        );
      case DriverComplianceStatus.vehicleInspectionRequired:
        card = DriverStatusCard(
          state: DriverStatus.vehicleInspectionRequired,
          onAction: () => Navigator.pushNamed(context, '/vehicle-inspection'),
        );
      case DriverComplianceStatus.headshotActionRequired:
        card = DriverStatusCard(
          state: DriverStatus.headshotActionRequired,
          onStartFaceCheck: () =>
              _showHeadshotModal(reason: provider.faceCheckReason ?? 'first_time'),
        );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: card,
        ),
      ],
    );
  }

  /// Show the headshot requirement modal instead of immediately opening the camera.
  Future<void> _showHeadshotModal({required String reason}) async {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final choice = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        title: const Text(
          'Headshot Photo Required',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20),
        ),
        content: const Text(
          'A headshot verification is required before you can go online.',
          style: TextStyle(fontSize: 14, height: 1.4),
        ),
        actionsPadding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        actions: [
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => Navigator.pop(ctx, 'stay_offline'),
              style: OutlinedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: const Text(
                'Stay Offline',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
            ),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              onPressed: () => Navigator.pop(ctx, 'take_photo'),
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF5B7760),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: const Text(
                'Take Photo',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
            ),
          ),
        ],
      ),
    );

    if (choice == 'take_photo') {
      provider.setHeadshotActionRequired(false);
      await _runFaceCheck(reason: reason);
    } else if (choice == 'stay_offline') {
      provider.setHeadshotActionRequired(true);
      _showError('You\'ll need to complete face verification before going online.');
    }
  }

  /// Push the face capture screen, upload the result, and react.
  Future<void> _runFaceCheck({required String reason}) async {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final result = await Navigator.push<FaceVerifyResult>(
      context,
      MaterialPageRoute(builder: (_) => FaceCaptureScreen(reason: reason)),
    );
    if (result == null) return;
    if (result.passed) {
      provider.setHeadshotActionRequired(false);
      provider.markFaceCheckPassed();
      _showSuccess('Face check passed — you\'re cleared to drive.');
    } else if (result.reason == 'flagged' || result.match == false) {
      provider.markFaceCheckFlagged(reason);
      _showError('Face check flagged. Our team will review your capture.');
    } else if (result.reason == 'client_error' ||
        result.reason == 'camera_permission_denied' ||
        result.reason == 'no_camera') {
      _showError('Couldn\'t open the camera. Please try again.');
    }
  }

  void _showSuccess(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: const Color(0xFF5B7760)),
    );
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _heartbeatTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkPermissions() async {
    setState(() => _state = ViewState.loading);
    try {
      bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage = 'Location services are disabled. Please enable them to go online.';
        });
        return;
      }

      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
          setState(() {
            _state = ViewState.failure;
            _errorMessage = 'Location permissions are required to drive with NetRide.';
          });
          return;
        }
      }

      if (permission == LocationPermission.deniedForever) {
        setState(() {
          _state = ViewState.failure;
          _errorMessage = 'Location permissions are permanently denied. Please enable them in settings.';
        });
        return;
      }

      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.bestForNavigation,
      );
      if (mounted) {
        setState(() {
          _lastPosition = position;
          _state = ViewState.success;
        });
      }
    } catch (e) {
      setState(() {
        _state = ViewState.failure;
        _errorMessage = 'An error occurred while initializing location tracking.';
      });
    }
  }

  void _startTracking(DriverProvider provider) {
    _positionSubscription?.cancel();
    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 0, 
      ),
    ).listen((Position position) {
      if (!mounted) return;
      setState(() => _lastPosition = position);

      if (provider.status != models.DriverStatus.offline) {
        provider.updateLocation(position.latitude, position.longitude);
      }
      
      if (_shouldFollowUser && _isMapReady) {
        _mapController.move(LatLng(position.latitude, position.longitude), 15.0);
      }
    });

    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 10), (timer) {
      if (_lastPosition != null && provider.status != models.DriverStatus.offline) {
        provider.updateLocation(_lastPosition!.latitude, _lastPosition!.longitude);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final driverProvider = Provider.of<DriverProvider>(context);
    
    if (driverProvider.currentTrip != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          bool isTripScreenOpen = false;
          Navigator.popUntil(context, (route) {
            if (route.settings.name == '/trip') isTripScreenOpen = true;
            return true;
          });
          if (!isTripScreenOpen) Navigator.pushNamed(context, '/trip');
        }
      });
    }

    if (_positionSubscription == null && _state == ViewState.success) {
      _startTracking(driverProvider);
    }

    // Auto-fit camera when a new incoming ride request arrives
    final incomingRequest = driverProvider.incomingRequest;
    if (incomingRequest != null && incomingRequest.id != _lastIncomingRequestId) {
      _lastIncomingRequestId = incomingRequest.id;
      _shouldFollowUser = false;
      
      // Parse route points
      List<LatLng> routePoints = [];
      if (incomingRequest.routeGeometry != null) {
        final geom = incomingRequest.routeGeometry!;
        if (geom['coordinates'] is List) {
          final coords = geom['coordinates'] as List;
          for (var c in coords) {
            if (c is List && c.length >= 2) {
              routePoints.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
            }
          }
        }
      }
      
      if (routePoints.isEmpty) {
        routePoints = [
          LatLng(incomingRequest.pickup.lat, incomingRequest.pickup.lng),
          LatLng(incomingRequest.destination.lat, incomingRequest.destination.lng),
        ];
      }

      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_isMapReady && routePoints.isNotEmpty) {
          try {
            _mapController.fitCamera(
              CameraFit.bounds(
                bounds: LatLngBounds.fromPoints(routePoints),
                padding: const EdgeInsets.only(top: 80, bottom: 380, left: 50, right: 50),
              ),
            );
          } catch (e) {
            _mapController.move(routePoints.first, 13.0);
          }
        }
      });
    } else if (incomingRequest == null && _lastIncomingRequestId != null) {
      _lastIncomingRequestId = null;
      _shouldFollowUser = true;
    }

    // Parse current route geometry points to highlight on map
    List<LatLng> mapRoutePoints = [];
    if (incomingRequest != null && incomingRequest.routeGeometry != null) {
      final geom = incomingRequest.routeGeometry!;
      if (geom['coordinates'] is List) {
        final coords = geom['coordinates'] as List;
        for (var c in coords) {
          if (c is List && c.length >= 2) {
            mapRoutePoints.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
          }
        }
      }
    }

    LatLng initialCenter = _lastPosition != null 
        ? LatLng(_lastPosition!.latitude, _lastPosition!.longitude)
        : const LatLng(0, 0); 

    final bool isOnline = driverProvider.status != models.DriverStatus.offline;

    return Scaffold(
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _checkPermissions,
        successWidget: Stack(
          children: [
            FlutterMap(
              mapController: _mapController,
              options: MapOptions(
                initialCenter: initialCenter,
                initialZoom: 15.0,
                onMapReady: () => setState(() => _isMapReady = true),
                onPositionChanged: (pos, hasGesture) {
                  if (hasGesture) setState(() => _shouldFollowUser = false);
                },
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                  subdomains: const ['a', 'b', 'c', 'd'],
                  userAgentPackageName: 'com.NetRide.driver',
                  tileBuilder: (context, tileWidget, tile) {
                    return ColorFiltered(
                      colorFilter: const ColorFilter.matrix(<double>[
                        0.937, 0, 0, 0, 0,
                        0, 0.922, 0, 0, 0,
                        0, 0, 0.902, 0, 0,
                        0, 0, 0, 1, 0,
                      ]),
                      child: ColorFiltered(
                        colorFilter: ColorFilter.mode(
                          const Color(0xFFEEEBE6).withOpacity(0.3),
                          BlendMode.multiply,
                        ),
                        child: tileWidget,
                      ),
                    );
                  },
                ),
                if (mapRoutePoints.isNotEmpty)
                  PolylineLayer(
                    polylines: [
                      Polyline(
                        points: mapRoutePoints,
                        strokeWidth: 6.0,
                        color: const Color(0xFF5B7760),
                      ),
                    ],
                  ),
                MarkerLayer(
                  markers: [
                    if (_lastPosition != null)
                      Marker(
                        point: LatLng(_lastPosition!.latitude, _lastPosition!.longitude),
                        width: 50,
                        height: 50,
                        child: _buildUserLocationMarker(isOnline),
                      ),
                    if (incomingRequest != null) ...[
                      Marker(
                        point: LatLng(incomingRequest.pickup.lat, incomingRequest.pickup.lng),
                        width: 40,
                        height: 40,
                        child: Container(
                          decoration: const BoxDecoration(
                            color: Color(0xFF5B7760),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.location_on, color: Colors.white, size: 20),
                        ),
                      ),
                      Marker(
                        point: LatLng(incomingRequest.destination.lat, incomingRequest.destination.lng),
                        width: 40,
                        height: 40,
                        child: Container(
                          decoration: const BoxDecoration(
                            color: Color(0xFF2F3A32),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.flag, color: Colors.white, size: 20),
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),

            SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                child: Column(
                  children: [
                    _buildStatusCards(driverProvider),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(24),
                        boxShadow: [
                          BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 20, offset: const Offset(0, 8)),
                        ],
                      ),
                      child: Row(
                        children: [
                          const CircleAvatar(
                            radius: 20,
                            backgroundColor: Color(0xFFF7F4EF),
                            child: Icon(Icons.person, color: Color(0xFF5B7760), size: 20),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  isOnline ? 'ONLINE' : 'OFFLINE',
                                  style: TextStyle(
                                    color: isOnline ? const Color(0xFF5B7760) : const Color(0xFF2F3A32).withOpacity(0.4),
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 1,
                                  ),
                                ),
                                Text(
                                  _firstName.isNotEmpty ? 'Hello, $_firstName' : 'Welcome',
                                  style: const TextStyle(color: Color(0xFF2F3A32), fontSize: 16, fontWeight: FontWeight.w700),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: isOnline && driverProvider.canGoOnline,
                            onChanged: _isTogglingOnline
                                ? null
                                : (val) async {
                                    setState(() => _isTogglingOnline = true);
                                    try {
                                      if (!driverProvider.canGoOnline) {
                                        final cs = driverProvider.buildDriverComplianceStatus();
                                        if (cs == DriverComplianceStatus.backgroundCheckRejected ||
                                            cs == DriverComplianceStatus.backgroundCheckPending) {
                                          _showError('Your account is under review. We\'re reviewing your documents.');
                                          return;
                                        }
                                        if (cs == DriverComplianceStatus.profileChangePending) {
                                          _showError('Your profile change is awaiting admin review.');
                                          _showPendingChangeDetails();
                                          return;
                                        }
                                        // Face check or document requirements — route
                                        // the user into the capture screen or documents.
                                        if (cs == DriverComplianceStatus.faceCheckNeeded) {
                                          _showHeadshotModal(reason: driverProvider.faceCheckReason ?? 'first_time');
                                          return;
                                        }
                                        if (cs == DriverComplianceStatus.headshotActionRequired) {
                                          _showHeadshotModal(reason: driverProvider.faceCheckReason ?? 'first_time');
                                          return;
                                        }
                                        if (cs == DriverComplianceStatus.documentActionRequired) {
                                          Navigator.pushNamed(context, '/documents');
                                          return;
                                        }
                                        _showError('You\'re not eligible to go online at this time.');
                                        return;
                                      }
                                      if (val) {
                                        final ok = await driverProvider.setOnline(
                                          lat: _lastPosition?.latitude,
                                          lng: _lastPosition?.longitude,
                                        );
                                        if (ok) {
                                          SoundService.instance.playOnline();
                                        }
                                        if (!ok && mounted) {
                                          _showHeadshotModal(reason: driverProvider.faceCheckReason ?? 'first_time');
                                        }
                                      } else {
                                        driverProvider.setOffline();
                                        SoundService.instance.playOffline();
                                      }
                                    } finally {
                                      if (mounted) setState(() => _isTogglingOnline = false);
                                    }
                                  },
                            activeColor: Colors.white,
                            activeTrackColor: const Color(0xFF5B7760),
                            inactiveTrackColor: const Color(0xFFD8D2CA),
                            inactiveThumbColor: Colors.white,
                          ),
                        ],
                      ),
                    ),
                    if (isOnline && driverProvider.incomingRequest == null)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: _buildPricingBar(driverProvider),
                      ),
                  ],
                ),
              ),
            ),

            if (!_shouldFollowUser)
              Positioned(
                right: 20,
                bottom: driverProvider.incomingRequest != null ? 360 : 40,
                child: FloatingActionButton(
                  heroTag: 'location_fab',
                  backgroundColor: Colors.white,
                  foregroundColor: const Color(0xFF2F3A32),
                  elevation: 4,
                  shape: const CircleBorder(),
                  onPressed: () {
                    setState(() => _shouldFollowUser = true);
                    if (_lastPosition != null) {
                      _mapController.move(LatLng(_lastPosition!.latitude, _lastPosition!.longitude), 15.0);
                    }
                  },
                  child: const Icon(Icons.my_location),
                ),
              ),

            if (driverProvider.incomingRequest != null)
              Positioned(
                bottom: 40,
                left: 20,
                right: 20,
                child: _IncomingRequestCard(request: driverProvider.incomingRequest!),
              ),
            
            if (isOnline && driverProvider.incomingRequest == null)
              Positioned(
                top: 140,
                left: 0,
                right: 0,
                child: Column(
                  children: [
                    Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                        decoration: BoxDecoration(
                          color: const Color(0xFF5B7760),
                          borderRadius: BorderRadius.circular(20),
                          boxShadow: [
                            BoxShadow(color: const Color(0xFF5B7760).withOpacity(0.3), blurRadius: 15, offset: const Offset(0, 8)),
                          ],
                        ),
                        child: const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
                            SizedBox(width: 12),
                            Text('SEARCHING', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 1)),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    if (driverProvider.recommendation != null)
                      GestureDetector(
                        onTap: () => _showModeSelector(driverProvider),
                        child: Container(
                          margin: const EdgeInsets.symmetric(horizontal: 40),
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                          decoration: BoxDecoration(
                            color: const Color(0xFFC79A4A),
                            borderRadius: BorderRadius.circular(16),
                            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10)],
                          ),
                          child: Row(
                            children: [
                              const Icon(Icons.bolt_rounded, color: Colors.white, size: 20),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  driverProvider.recommendation!['reason'],
                                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
                                ),
                              ),
                              const Icon(Icons.chevron_right_rounded, color: Colors.white),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),

            if (isOnline)
              Positioned(
                bottom: driverProvider.incomingRequest != null ? 360 : 40,
                left: 20,
                child: GestureDetector(
                  onTap: () => _showModeSelector(driverProvider),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: const Color(0xFFD8D2CA)),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 10)],
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.layers_outlined, size: 18, color: Color(0xFF5B7760)),
                        const SizedBox(width: 10),
                        Text(
                          'MODE: ${driverProvider.activeClass.toString().split('.').last}',
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  void _showModeSelector(DriverProvider provider) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (context) => Container(
        padding: const EdgeInsets.all(32),
        decoration: const BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(32)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Operating Mode',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
            ),
            const SizedBox(height: 8),
            Text(
              'Choose which service class you want to drive for. Some modes require specific vehicle eligibility.',
              style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.6), fontSize: 14),
            ),
            const SizedBox(height: 32),
            _buildModeOption(provider, 'CORE', 'Standard standard rides', models.VehicleClass.CORE),
            const SizedBox(height: 12),
            _buildModeOption(provider, 'ELITE', 'Luxury sedan rides', models.VehicleClass.ELITE),
            const SizedBox(height: 12),
            _buildModeOption(provider, 'PRESTIGE', 'Premium large SUV rides', models.VehicleClass.PRESTIGE),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _buildModeOption(DriverProvider provider, String title, String sub, models.VehicleClass vClass) {
    final isSelected = provider.activeClass == vClass;
    return GestureDetector(
      onTap: () async {
        try {
          await provider.updateOperatingClass(vClass);
          if (mounted) Navigator.pop(context);
        } catch (e) {
          if (mounted) {
            Navigator.pop(context);
            _showError(e.toString().replaceAll('Exception: ', ''));
          }
        }
      },
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: isSelected ? const Color(0xFF5B7760).withOpacity(0.05) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: isSelected ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA)),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 2),
                  Text(sub, style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.5))),
                ],
              ),
            ),
            if (isSelected)
              const Icon(Icons.check_circle, color: Color(0xFF5B7760))
            else
              const Icon(Icons.circle_outlined, color: Color(0xFFD8D2CA)),
          ],
        ),
      ),
    );
  }

  Widget _buildUserLocationMarker(bool isOnline) {
    final color = isOnline ? const Color(0xFF5B7760) : Colors.grey;
    return Container(
      decoration: BoxDecoration(color: color.withOpacity(0.15), shape: BoxShape.circle),
      child: Center(
        child: Container(
          width: 14, height: 14,
          decoration: BoxDecoration(
            color: color, shape: BoxShape.circle,
            border: Border.all(color: Colors.white, width: 2),
            boxShadow: [BoxShadow(blurRadius: 8, color: color.withOpacity(0.3))],
          ),
        ),
      ),
    );
  }

  void _confirmPriceChange(double value, DriverProvider provider) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: const Text('Confirm Price Change', style: TextStyle(fontWeight: FontWeight.bold)),
        content: Text(
          'You chose your driving price to be \$${value.toStringAsFixed(2)} dollars per mile. '
          'You will be able to change your price again after 4 hours. '
          'Are you sure you want to change?'
        ),
        actions: [
          TextButton(
            onPressed: () {
              setState(() {
                _tempPrice = null;
              });
              Navigator.pop(context);
            },
            child: const Text('CANCEL', style: TextStyle(color: Colors.grey, fontWeight: FontWeight.bold)),
          ),
          ElevatedButton(
            onPressed: _isConfirmingPrice
                ? null
                : () async {
                    setState(() => _isConfirmingPrice = true);
                    Navigator.pop(context);
                    try {
                      await provider.updatePrice(value);
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text('Driving price successfully set to \$${value.toStringAsFixed(2)}/mi.'),
                            backgroundColor: const Color(0xFF5B7760),
                            behavior: SnackBarBehavior.floating,
                          ),
                        );
                      }
                    } catch (e) {
                      if (mounted) {
                        showDialog(
                          context: context,
                          builder: (context) => AlertDialog(
                            title: const Text('Error'),
                            content: Text(e.toString().replaceAll('Exception: ', '')),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context),
                                child: const Text('OK'),
                              )
                            ],
                          ),
                        );
                      }
                    } finally {
                      setState(() {
                        _isConfirmingPrice = false;
                        _tempPrice = null;
                      });
                    }
                  },
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF5B7760), foregroundColor: Colors.white),
            child: _isConfirmingPrice
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('CONFIRM', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  Widget _buildPricingBar(DriverProvider driverProvider) {
    final min = driverProvider.priceRangeMin;
    final max = driverProvider.priceRangeMax;
    final current = _tempPrice ?? driverProvider.pricePerMile;
    final rec = driverProvider.recommendedPrice;

    final double recFraction = (max - min) > 0 ? (rec - min) / (max - min) : 0.5;

    final durationSinceChange = driverProvider.priceLastChanged != null 
        ? DateTime.now().difference(driverProvider.priceLastChanged!) 
        : const Duration(hours: 5);
    final bool isCooldown = durationSinceChange < const Duration(hours: 4);

    String cooldownText = "";
    if (isCooldown) {
      final remaining = const Duration(hours: 4) - durationSinceChange;
      final hours = remaining.inHours;
      final minutes = remaining.inMinutes % 60;
      cooldownText = "Locked for ${hours}h ${minutes}m";
    }

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.95),
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 20, offset: const Offset(0, 8)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'YOUR RIDE FARE RANGE',
                style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Color(0xFF5B7760), letterSpacing: 1.2),
              ),
              if (isCooldown)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(color: const Color(0xFFC65A5A).withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.lock_clock, size: 12, color: Color(0xFFC65A5A)),
                      const SizedBox(width: 4),
                      Text(cooldownText, style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w700, color: Color(0xFFC65A5A))),
                    ],
                  ),
                )
              else
                Text(
                  'Active Rate: \$${driverProvider.pricePerMile.toStringAsFixed(2)}/mi',
                  style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Center(
            child: Text(
              '\$${current.toStringAsFixed(2)}/mi',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w900,
                color: _isDragging 
                    ? const Color(0xFF8FA894).withOpacity(0.7) // Lighter green color while dragging
                    : const Color(0xFF2F3A32),
                letterSpacing: -0.5,
              ),
            ),
          ),
          const SizedBox(height: 2),
          LayoutBuilder(
            builder: (context, constraints) {
              final trackWidth = constraints.maxWidth - 32;
              final recLeftOffset = 16 + (recFraction * trackWidth);
              
              return Stack(
                clipBehavior: Clip.none,
                children: [
                  SliderTheme(
                    data: SliderTheme.of(context).copyWith(
                      activeTrackColor: const Color(0xFF5B7760),
                      inactiveTrackColor: const Color(0xFFD8D2CA),
                      thumbColor: isCooldown ? Colors.grey : const Color(0xFF5B7760),
                      overlayColor: const Color(0xFF5B7760).withOpacity(0.12),
                      valueIndicatorColor: const Color(0xFF5B7760).withOpacity(0.9),
                      valueIndicatorTextStyle: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
                      showValueIndicator: ShowValueIndicator.always,
                    ),
                    child: Slider(
                      min: min,
                      max: max,
                      divisions: ((max - min) / 0.25).round(),
                      value: current,
                      onChanged: isCooldown ? null : (val) {
                        setState(() {
                          _tempPrice = val;
                          _isDragging = true;
                        });
                      },
                      onChangeEnd: (val) {
                        setState(() {
                          _isDragging = false;
                        });
                        _confirmPriceChange(val, driverProvider);
                      },
                    ),
                  ),
                  Positioned(
                    left: recLeftOffset,
                    top: 36,
                    child: FractionalTranslation(
                      translation: const Offset(-0.5, 0),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.arrow_drop_up_rounded, size: 14, color: Color(0xFFC79A4A)),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF7F4EF),
                              borderRadius: BorderRadius.circular(6),
                              border: Border.all(color: const Color(0xFFC79A4A), width: 0.5),
                            ),
                            child: Text(
                              'Rec: \$${rec.toStringAsFixed(2)}',
                              style: const TextStyle(fontSize: 8, fontWeight: FontWeight.bold, color: Color(0xFFC79A4A)),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 20),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Min: \$${min.toStringAsFixed(2)}/mi', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: const Color(0xFF2F3A32).withOpacity(0.5))),
              Text('Max: \$${max.toStringAsFixed(2)}/mi', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: const Color(0xFF2F3A32).withOpacity(0.5))),
            ],
          ),
        ],
      ),
    );
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: const Color(0xFFC65A5A), behavior: SnackBarBehavior.floating),
    );
  }
}

class _IncomingRequestCard extends StatefulWidget {
  final models.Trip request;
  const _IncomingRequestCard({required this.request});

  @override
  State<_IncomingRequestCard> createState() => _IncomingRequestCardState();
}

class _IncomingRequestCardState extends State<_IncomingRequestCard>
    with SingleTickerProviderStateMixin {
  static const Duration kAcceptWindow = Duration(seconds: 15);
  // Sage-family colors matching the rest of the app's palette.
  static const Color kAcceptFill = Color(0xFF5B7760); // primary sage
  static const Color kAcceptTrack = Color(0xFFC9D6CC); // desaturated light sage

  late final AnimationController _controller;
  bool _accepted = false;
  bool _declined = false;

  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    SoundService.instance.play(SoundEffect.incomingRequest);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!_accepted && !_declined && mounted) {
        SoundService.instance.play(SoundEffect.countdownTick);
      } else {
        timer.cancel();
      }
    });
    _controller = AnimationController(vsync: this, duration: kAcceptWindow)
      ..addStatusListener(_onStatus)
      ..forward();
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted && !_accepted && !_declined) {
      _onTimeout();
    }
  }

  void _onTimeout() {
    if (_accepted || _declined) return;
    _declined = true;
    _countdownTimer?.cancel();
    final driverProvider =
        Provider.of<DriverProvider>(context, listen: false);
    driverProvider.declineTrip(widget.request.id);
  }

  void _onAcceptTap() {
    if (_accepted || _declined) return;
    _accepted = true;
    _countdownTimer?.cancel();
    _controller.stop();
    SoundService.instance.play(SoundEffect.orderAccepted);
    final driverProvider =
        Provider.of<DriverProvider>(context, listen: false);
    driverProvider.acceptTrip(widget.request.id);
    Navigator.pushNamed(context, '/trip');
  }

  void _onDeclineTap() {
    if (_accepted || _declined) return;
    _declined = true;
    _countdownTimer?.cancel();
    _controller.stop();
    SoundService.instance.play(SoundEffect.orderCancelled);
    final driverProvider =
        Provider.of<DriverProvider>(context, listen: false);
    driverProvider.declineTrip(widget.request.id);
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _controller.removeStatusListener(_onStatus);
    _controller.dispose();
    super.dispose();
  }

  // ---- Formatters ------------------------------------------------------------

  String _formatEta(double? seconds) {
    if (seconds == null) return '—';
    final s = seconds.round();
    if (s < 60) return '$s sec';
    final m = (s / 60).round();
    return '$m min';
  }

  String _formatDistanceMeters(double? meters) {
    if (meters == null) return '—';
    final mi = meters / 1609.34;
    return '${mi.toStringAsFixed(1)} mi';
  }

  // ---- Geometry --------------------------------------------------------------

  List<LatLng> _parseRoutePoints() {
    final pts = <LatLng>[];
    final geom = widget.request.routeGeometry;
    if (geom == null) return pts;
    final coords = geom['coordinates'];
    if (coords is! List) return pts;
    for (final c in coords) {
      if (c is List && c.length >= 2) {
        pts.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
      }
    }
    return pts;
  }

  @override
  Widget build(BuildContext context) {
    final req = widget.request;

    final price = req.calculatedPrice ?? req.fareAmount ?? 0.0;
    final etaSec = req.driverToPickupEta;
    final distMeters = req.tripDistanceMeters;
    final rider = req.riderInfo;

    return Container(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(0.12),
            blurRadius: 30,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // ---- Header: tag + price -----------------------------------------
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text(
                'NEW RIDE REQUEST',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF5B7760),
                  letterSpacing: 1.5,
                ),
              ),
              Text(
                '\$${price.toStringAsFixed(2)}',
                style: const TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF2F3A32),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // ---- Route thumbnail + addresses --------------------------------
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              _RouteThumbnail(
                routePoints: _parseRoutePoints(),
                pickup: LatLng(req.pickup.lat, req.pickup.lng),
                destination:
                    LatLng(req.destination.lat, req.destination.lng),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _buildAddressRow(
                      Icons.circle,
                      const Color(0xFF5B7760),
                      req.pickup.address ?? 'Pickup',
                    ),
                    const SizedBox(height: 10),
                    _buildAddressRow(
                      Icons.square,
                      const Color(0xFF2F3A32),
                      req.destination.address ?? 'Destination',
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),

          // ---- Info chips (ETA / distance / rider rating) ------------------
          Row(
            children: [
              Expanded(
                child: _InfoChip(
                  icon: Icons.timer_outlined,
                  label: 'TO PICKUP',
                  value: _formatEta(etaSec),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _InfoChip(
                  icon: Icons.route_outlined,
                  label: 'TRIP',
                  value: _formatDistanceMeters(distMeters),
                ),
              ),
              const SizedBox(width: 8),
              if (rider != null)
                Expanded(
                  child: _InfoChip(
                    icon: Icons.star_rounded,
                    iconColor: const Color(0xFFC79A4A),
                    label: 'RIDER',
                    value: rider.rating.toStringAsFixed(1),
                  ),
                )
              else
                const Expanded(child: SizedBox.shrink()),
            ],
          ),
          const SizedBox(height: 14),

          // ---- Bottom action row: ✕  |  shrinking green Accept bar ----------
          Row(
            children: [
              _DeclineButton(onTap: _onDeclineTap),
              const SizedBox(width: 12),
              Expanded(
                child: _AcceptCountdownBar(
                  controller: _controller,
                  onTap: _onAcceptTap,
                  disabled: _declined || _accepted,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildAddressRow(IconData icon, Color color, String text) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Icon(icon, size: 10, color: color),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: Color(0xFF2F3A32),
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

/// Square decline button — static, independent of the timer.
class _DeclineButton extends StatelessWidget {
  final VoidCallback onTap;
  const _DeclineButton({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 56,
        height: 56,
        decoration: BoxDecoration(
          color: const Color(0xFFF7F4EF),
          shape: BoxShape.circle,
          border: Border.all(color: const Color(0xFFD8D2CA)),
        ),
        child: const Icon(Icons.close, color: Color(0xFF2F3A32), size: 26),
      ),
    );
  }
}

/// Uber-style shrinking green Accept bar with right→left countdown wipe
/// and centered remaining-seconds label.
class _AcceptCountdownBar extends StatelessWidget {
  final AnimationController controller;
  final VoidCallback onTap;
  final bool disabled;
  const _AcceptCountdownBar({
    required this.controller,
    required this.onTap,
    required this.disabled,
  });

  @override
  Widget build(BuildContext context) {
    final progress = controller.value; // 0 → 1
    final remaining = (controller.duration!.inMilliseconds *
            (1 - progress))
        .ceil();
    final seconds = (remaining / 1000).ceil();
    // When the fill has mostly drained, switch to dark text on the light
    // track so the label stays readable.
    final filled = progress < 0.55;
    return GestureDetector(
      onTap: disabled ? null : onTap,
      child: SizedBox(
        height: 56,
        child: AnimatedBuilder(
          animation: controller,
          builder: (context, _) {
            return Stack(
              alignment: Alignment.center,
              children: [
                // Base pill (full button) — the "empty" sage track.
                Container(
                  decoration: BoxDecoration(
                    color: _IncomingRequestCardState.kAcceptTrack,
                    borderRadius: BorderRadius.circular(28),
                  ),
                ),
                // Shrinking sage fill, anchored right, wiping left.
                Align(
                  alignment: Alignment.centerRight,
                  child: FractionallySizedBox(
                    widthFactor: (1 - progress).clamp(0.0, 1.0),
                    heightFactor: 1,
                    child: Container(
                      decoration: BoxDecoration(
                        color: _IncomingRequestCardState.kAcceptFill,
                        borderRadius: BorderRadius.circular(28),
                      ),
                    ),
                  ),
                ),
                // Label + countdown badge.
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      'ACCEPT',
                      style: TextStyle(
                        color: filled
                            ? Colors.white
                            : const Color(0xFF2F3A32),
                        fontWeight: FontWeight.w800,
                        fontSize: 16,
                        letterSpacing: 1.2,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: filled
                            ? Colors.white.withOpacity(0.85)
                            : const Color(0xFFF7F4EF),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Text(
                        '${seconds}s',
                        style: TextStyle(
                          fontFeatures: const [FontFeature.tabularFigures()],
                          fontWeight: FontWeight.w700,
                          fontSize: 12,
                          color: filled
                              ? const Color(0xFF2F3A32)
                              : const Color(0xFF5B7760),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Single info chip in the request card (icon + label + value).
class _InfoChip extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String label;
  final String value;
  const _InfoChip({
    required this.icon,
    required this.label,
    required this.value,
    this.iconColor = const Color(0xFF5B7760),
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFFF7F4EF),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: iconColor),
          const SizedBox(height: 4),
          Text(
            label,
            style: const TextStyle(
              fontSize: 9,
              fontWeight: FontWeight.w800,
              color: Color(0xFF5B7760),
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
            ),
          ),
        ],
      ),
    );
  }
}

/// Mini static route map used inside the request card.
class _RouteThumbnail extends StatelessWidget {
  final List<LatLng> routePoints;
  final LatLng pickup;
  final LatLng destination;
  const _RouteThumbnail({
    required this.routePoints,
    required this.pickup,
    required this.destination,
  });

  @override
  Widget build(BuildContext context) {
    final allPoints = routePoints.isNotEmpty
        ? routePoints
        : <LatLng>[pickup, destination];

    return ClipRRect(
      borderRadius: BorderRadius.circular(14),
      child: Container(
        width: 110,
        height: 86,
        decoration: BoxDecoration(
          color: const Color(0xFFEEEBE6),
          borderRadius: BorderRadius.circular(14),
        ),
        child: FlutterMap(
          options: MapOptions(
            initialCenter: allPoints.first,
            initialZoom: 13,
            interactionOptions: const InteractionOptions(
              flags: InteractiveFlag.none,
            ),
          ),
          children: [
            TileLayer(
              urlTemplate:
                  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
              subdomains: const ['a', 'b', 'c', 'd'],
              userAgentPackageName: 'com.NetRide.driver',
              tileBuilder: (context, tileWidget, tile) {
                return ColorFiltered(
                  colorFilter: const ColorFilter.matrix(<double>[
                    0.937, 0, 0, 0, 0,
                    0, 0.922, 0, 0, 0,
                    0, 0, 0.902, 0, 0,
                    0, 0, 0, 1, 0,
                  ]),
                  child: tileWidget,
                );
              },
            ),
            if (routePoints.length >= 2)
              PolylineLayer(
                polylines: [
                  Polyline(
                    points: routePoints,
                    strokeWidth: 4.0,
                    color: const Color(0xFF5B7760),
                  ),
                ],
              ),
            MarkerLayer(
              markers: [
                Marker(
                  point: pickup,
                  width: 16,
                  height: 16,
                  child: Container(
                    decoration: const BoxDecoration(
                      color: Color(0xFF5B7760),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
                Marker(
                  point: destination,
                  width: 14,
                  height: 14,
                  child: Container(
                    decoration: const BoxDecoration(
                      color: Color(0xFF2F3A32),
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
