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
import '../components/state_container.dart';
import '../components/driver_status_card.dart';
import '../services/sound_service.dart';
import '../services/heatmap_service.dart';
import '../models/demand_zone.dart';

/// NetRide driver dashboard.
///
/// Offline mode shows a compact dashboard (greeting, compliance status,
/// weekly earnings, contained map card) with a circular GO ONLINE control
/// floating above the map card's bottom edge. Going online confirms with
/// the backend first, then the map card smoothly expands to full screen
/// and the driver enters operational mode with a GO OFFLINE control.
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
  String? _lastIncomingRequestId;
  bool _isTogglingOnline = false;

  // Weekly earnings (computed client-side from /ride/history).
  bool _earningsLoading = true;
  double _weeklyFare = 0;
  double _weeklyTips = 0;
  int _weeklyRides = 0;

  // Demand heatmap (server-computed from real rider activity).
  List<DemandZone> _demandZones = [];
  Timer? _demandTimer;
  bool _demandLastFailed = false;

  @override
  void initState() {
    super.initState();
    _checkPermissions();
    _fetchProfile();
    _loadWeeklyEarnings();
  }

  // ── Earnings ──────────────────────────────────────────────────────

  /// Pull-to-refresh: re-fetches profile + document requirements
  /// (bypassing cache) and refreshes the weekly earnings rollup.
  Future<void> _handleRefresh() async {
    try {
      final provider = Provider.of<DriverProvider>(context, listen: false);
      await Future.wait([
        provider.refreshAll(),
        _loadWeeklyEarnings(),
      ]);
    } catch (_) {
      // Refresh failures are non-fatal; cached/current state stays visible.
    }
  }

  /// Pulls the driver's completed rides from the history API and rolls up
  /// fares + tips for the trailing 7 days ("This Week").
  Future<void> _loadWeeklyEarnings() async {
    try {
      final res = await ApiService.dio.get('/ride/history');
      final raw = res.data;
      if (raw is! List) throw Exception('Unexpected history payload');
      final weekStart = DateTime.now().subtract(const Duration(days: 7));
      double fare = 0, tips = 0;
      int rides = 0;
      for (final item in raw) {
        if (item is! Map) continue;
        try {
          final t = models.Trip.fromJson(Map<String, dynamic>.from(item));
          if (t.status != models.TripStatus.COMPLETED) continue;
          final ts = t.requestedAt;
          if (ts == null || !ts.isAfter(weekStart)) continue;
          fare += t.fareAmount ?? 0;
          tips += t.tipAmount ?? 0;
          rides++;
        } catch (_) {
          // Skip malformed history rows — never let a UI summary crash.
        }
      }
      if (mounted) {
        setState(() {
          _weeklyFare = fare;
          _weeklyTips = tips;
          _weeklyRides = rides;
          _earningsLoading = false;
        });
      }
    } catch (e) {
      debugPrint('Error loading weekly earnings: $e');
      if (mounted) setState(() => _earningsLoading = false);
    }
  }

  // ── Profile / compliance ──────────────────────────────────────────

  Future<void> _fetchProfile() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (!prefs.containsKey('jwt_token')) return;

      // Use cache-first fetch via DriverProvider
      final provider = Provider.of<DriverProvider>(context, listen: false);
      Map<String, dynamic> profile;
      try {
        profile = await provider.fetchProfile();
      } catch (_) {
        // Fallback: direct fetch if provider cache isn't ready
        profile = await UserService.getProfile();
      }

      if (mounted) {
        setState(() {
          final fullName = profile['full_name'] ?? 'Driver';
          _firstName = fullName.split(' ')[0];
        });
      }

      // Revalidate profile in background (cache-first already returned data,
      // this ensures the provider refreshes its state).
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

  Widget _buildStatusCards(DriverProvider provider) {
    final List<Widget> cards = [];

    // 1. Non-document, mutually exclusive compliance items
    final status = provider.buildDriverComplianceStatus();
    Widget? singleCard;
    switch (status) {
      case DriverComplianceStatus.profileChangePending:
        singleCard = DriverStatusCard(
          state: DriverStatus.profileChangePending,
          onAction: _showPendingChangeDetails,
        );
      case DriverComplianceStatus.profileChangeApproved:
        singleCard = DriverStatusCard(
          state: DriverStatus.profileChangeApproved,
          onDismiss: () => provider.markProfileChangeApprovedShown(),
        );
      case DriverComplianceStatus.backgroundCheckRejected:
        singleCard = DriverStatusCard(
          state: DriverStatus.backgroundRejected,
          rejectionReason: provider.rejectionReason,
          onAction: () => _showRejectionDetails(),
        );
      case DriverComplianceStatus.backgroundCheckPending:
        singleCard = const DriverStatusCard(state: DriverStatus.backgroundPending);
      case DriverComplianceStatus.backgroundCheckApproved:
        singleCard = DriverStatusCard(
          state: DriverStatus.backgroundApproved,
          onDismiss: _dismissFeedback,
        );
      case DriverComplianceStatus.headshotActionRequired:
        singleCard = DriverStatusCard(
          state: DriverStatus.headshotActionRequired,
          onAction: () => _showHeadshotModal(reason: 'headshot'),
        );
      case DriverComplianceStatus.documentSubmitted:
        singleCard = const DriverStatusCard(state: DriverStatus.documentSubmittedForReview);
      default:
        singleCard = null;
    }

    if (singleCard != null) {
      cards.add(singleCard);
    }

    // 2. Vehicle inspection request (specific navigation to /vehicle-inspection)
    if (provider.hasVehicleInspectionRequired) {
      cards.add(
        DriverStatusCard(
          state: DriverStatus.vehicleInspectionRequired,
          onAction: () => Navigator.pushNamed(context, '/vehicle-inspection'),
        ),
      );
    }

    // 3. Document action required — single card for all doc types
    final hasDocAction = provider.documentRequirements.any(
      (r) => r['status'] == 'resubmission_required' && r['document_type'] != 'inspection_photo_url',
    );
    if (hasDocAction) {
      cards.add(
        DriverStatusCard(
          state: DriverStatus.documentActionRequired,
          documentType: null,  // generic card for all docs
          onAction: () => Navigator.pushNamed(context, '/documents'),
        ),
      );
    }

    // 4. When no blocker and verified, show ready-to-drive
    if (cards.isEmpty) {
      if (provider.isVerified) {
        cards.add(DriverStatusCard(state: DriverStatus.readyToDrive));
      }
    }

    if (cards.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: cards
          .map((card) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: card,
              ))
          .toList(),
    );
  }

  /// Show the selfie requirement modal instead of immediately opening the camera.
  Future<void> _showHeadshotModal({required String reason}) async {
    final provider = Provider.of<DriverProvider>(context, listen: false);
    final choice = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        title: const Text(
          'Selfie Required',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 20),
        ),
        content: const Text(
          'A quick selfie verification is required before you can go online.\n\n'
          'You\'ll only need to take one front-facing photo.',
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
                'Take Selfie',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
            ),
          ),
        ],
      ),
    );

    if (choice == 'take_photo') {
      provider.setHeadshotActionRequired(false);
    } else if (choice == 'stay_offline') {
      provider.setHeadshotActionRequired(true);
    }
  }

  // ── Demand heatmap ────────────────────────────────────────────────

  /// Pulls the demand zones for the driver's current area. Only meaningful
  /// while online, idle (no incoming request), and a position is known.
  Future<void> _refreshDemand() async {
    final pos = _lastPosition;
    if (pos == null || !mounted) return;
    try {
      final query = await HeatmapService.fetchZones(
        lat: pos.latitude,
        lng: pos.longitude,
      );
      if (!mounted) return;
      setState(() {
        _demandZones = query.zones;
        _demandLastFailed = false;
      });
    } on DioException catch (e) {
      debugPrint('[HEATMAP] fetch failed (kept last zones): ${HeatmapService.friendlyError(e)}');
      if (mounted && _demandZones.isEmpty) {
        // First fetch failed — nothing to show yet; surface that quietly.
        setState(() => _demandLastFailed = true);
      }
    }
  }

  /// Poll while online + idle. The backend caches for 45 s, so 60 s keeps
  /// us comfortably behind the cache boundary without hammering the API.
  void _startDemandTimer() {
    _demandTimer?.cancel();
    _refreshDemand();
    _demandTimer = Timer.periodic(const Duration(seconds: 60), (_) {
      final provider = Provider.of<DriverProvider>(context, listen: false);
      if (provider.status != models.DriverStatus.offline &&
          provider.incomingRequest == null) {
        _refreshDemand();
      }
    });
  }

  void _stopDemandTimer() {
    _demandTimer?.cancel();
    _demandTimer = null;
    _demandZones = [];
    _demandLastFailed = false;
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _heartbeatTimer?.cancel();
    _demandTimer?.cancel();
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
        try {
          _mapController.move(LatLng(position.latitude, position.longitude), 15.0);
        } catch (_) {
          // flutter_map internal state not ready yet — safe to ignore
        }
      }
    });

    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 10), (timer) {
      if (_lastPosition != null && provider.status != models.DriverStatus.offline) {
        provider.updateLocation(_lastPosition!.latitude, _lastPosition!.longitude);
      }
    });
  }

  // ── Online / offline transitions ──────────────────────────────────

  Future<void> _goOnline(DriverProvider provider) async {
    if (_isTogglingOnline) return;
    setState(() => _isTogglingOnline = true);
    try {
      if (!provider.canGoOnline) {
        final cs = provider.buildDriverComplianceStatus();
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
        // Headshot or document requirements — route
        // the user into the capture screen or documents.
        if (cs == DriverComplianceStatus.headshotActionRequired) {
          _showHeadshotModal(reason: 'headshot');
          return;
        }
        if (cs == DriverComplianceStatus.documentActionRequired) {
          Navigator.pushNamed(context, '/documents');
          return;
        }
        _showError('You\'re not eligible to go online at this time.');
        return;
      }
      final ok = await provider.setOnline(
        lat: _lastPosition?.latitude,
        lng: _lastPosition?.longitude,
      );
      if (ok) {
        // Play the confirmation cue only after the backend accepted; the
        // screen never claims to be online before that.
        SoundService.instance.playOnline();
        // Start cooling the demand heatmap for this area.
        _startDemandTimer();
      } else if (mounted) {
        _showHeadshotModal(reason: 'headshot');
      }
    } finally {
      if (mounted) setState(() => _isTogglingOnline = false);
    }
  }

  void _goOffline(DriverProvider provider) {
    if (_isTogglingOnline) return;
    setState(() => _isTogglingOnline = true);
    SoundService.instance.playOffline();
    provider.setOffline();
    // Heatmap is an online-mode surface — stop polling and clear zones.
    _stopDemandTimer();
    // Re-center on the driver and refresh earnings while the map
    // contracts back into its card.
    _shouldFollowUser = true;
    if (_lastPosition != null && _isMapReady) {
      try {
        _mapController.move(LatLng(_lastPosition!.latitude, _lastPosition!.longitude), 15.0);
      } catch (_) {}
    }
    _loadWeeklyEarnings();
    setState(() => _isTogglingOnline = false);
  }

  // ── Map helpers ───────────────────────────────────────────────────

  List<LatLng> _routePointsFromGeometry(Map<String, dynamic>? geometry) {
    final points = <LatLng>[];
    if (geometry == null) return points;
    final coords = geometry['coordinates'];
    if (coords is! List) return points;
    for (final c in coords) {
      if (c is List && c.length >= 2) {
        points.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
      }
    }
    return points;
  }

  Widget _buildTiles() {
    return TileLayer(
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

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: const Color(0xFFC65A5A), behavior: SnackBarBehavior.floating),
    );
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

      final routePoints = _routePointsFromGeometry(incomingRequest.routeGeometry);
      final fitPoints = routePoints.isNotEmpty
          ? routePoints
          : [
              LatLng(incomingRequest.pickup.lat, incomingRequest.pickup.lng),
              LatLng(incomingRequest.destination.lat, incomingRequest.destination.lng),
            ];

      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_isMapReady && fitPoints.isNotEmpty) {
          try {
            _mapController.fitCamera(
              CameraFit.bounds(
                bounds: LatLngBounds.fromPoints(fitPoints),
                padding: const EdgeInsets.only(top: 160, bottom: 420, left: 50, right: 50),
              ),
            );
          } catch (_) {
            try {
              _mapController.move(fitPoints.first, 13.0);
            } catch (_) {}
          }
        }
      });
    } else if (incomingRequest == null && _lastIncomingRequestId != null) {
      _lastIncomingRequestId = null;
      _shouldFollowUser = true;
    }

    final mapRoutePoints = _routePointsFromGeometry(incomingRequest?.routeGeometry);

    LatLng initialCenter = _lastPosition != null 
        ? LatLng(_lastPosition!.latitude, _lastPosition!.longitude)
        : const LatLng(34.0522, -118.2437);

    final bool isOnline = driverProvider.status != models.DriverStatus.offline;
    final bool hasRequest = incomingRequest != null;

    return Scaffold(
      body: StateContainer(
        state: _state,
        errorMessage: _errorMessage,
        onRetry: _checkPermissions,
        successWidget: LayoutBuilder(
          builder: (context, constraints) {
            final screenH = constraints.maxHeight;
            final mapCardH = (screenH * 0.44).clamp(280.0, 440.0);

            return Stack(
              children: [
                // ── Contained map card ⇄ full-screen map ────────────────
                AnimatedPositioned(
                  duration: const Duration(milliseconds: 500),
                  curve: Curves.easeInOutCubic,
                  left: isOnline ? 0 : 20,
                  right: isOnline ? 0 : 20,
                  top: isOnline ? 0 : screenH - mapCardH - 20,
                  bottom: isOnline ? 0 : 20,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 500),
                    curve: Curves.easeInOutCubic,
                    clipBehavior: Clip.antiAlias,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(isOnline ? 0 : 28),
                      boxShadow: isOnline
                          ? const []
                          : [
                              BoxShadow(
                                color: Colors.black.withOpacity(0.10),
                                blurRadius: 24,
                                offset: const Offset(0, 10),
                              ),
                            ],
                    ),
                    child: FlutterMap(
                      mapController: _mapController,
                      options: MapOptions(
                        initialCenter: initialCenter,
                        initialZoom: 15.0,
                        minZoom: 12,
                        maxZoom: 18,
                        onMapReady: () => setState(() => _isMapReady = true),
                        onPositionChanged: (pos, hasGesture) {
                          if (hasGesture) setState(() => _shouldFollowUser = false);
                        },
                      ),
                      children: [
                        _buildTiles(),
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
                        // Demand heatmap (only while idle — never during an
                        // active request, keep the driver's focus on it).
                        if (isOnline && !hasRequest && _demandZones.isNotEmpty)
                          CircleLayer(
                            circles: _demandZones.map((z) {
                              final alpha = 0.06 + z.score * 0.30;
                              return CircleMarker(
                                point: LatLng(z.lat, z.lng),
                                radius: z.radiusM,
                                useRadiusInMeter: true,
                                color: const Color(0xFF5B7760)
                                    .withOpacity(alpha),
                                borderStrokeWidth: 0,
                              );
                            }).toList(),
                          ),
                        if (isOnline && _demandLastFailed)
                          CircleLayer(
                            circles: [
                              CircleMarker(
                                point: initialCenter,
                                radius: 12,
                                useRadiusInMeter: false,
                                color: const Color(0xFF5B7760)
                                    .withOpacity(0.12),
                                borderStrokeWidth: 0,
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
                  ),
                ),

                // ── Offline dashboard (fades out when online) ───────────
                // Positioned.fill ensures this never affects the Stack's
                // size (non-positioned children otherwise participate in
                // Stack sizing under loose fit). The map child below with
                // isOnline → bottom:0 then reliably fills the full body.
                Positioned.fill(
                  child: IgnorePointer(
                    ignoring: isOnline,
                    child: AnimatedOpacity(
                      opacity: isOnline ? 0 : 1,
                      duration: const Duration(milliseconds: 320),
                      child: SafeArea(
                        child: Padding(
                          padding: EdgeInsets.fromLTRB(20, 12, 20, mapCardH + 28),
                          child: RefreshIndicator(
                            color: const Color(0xFF5B7760),
                            onRefresh: _handleRefresh,
                            child: SingleChildScrollView(
                              physics: const AlwaysScrollableScrollPhysics(
                                parent: ClampingScrollPhysics(),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  _buildOfflineHeader(driverProvider, isOnline),
                                  const SizedBox(height: 10),
                                  _buildStatusCards(driverProvider),
                                  const SizedBox(height: 10),
                                  _buildWeeklyEarningsCard(),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),

                // ── Online top status ───────────────────────────────────
                Positioned(
                  top: 0, left: 0, right: 0,
                  child: SafeArea(
                    child: AnimatedOpacity(
                      opacity: isOnline ? 1 : 0,
                      duration: const Duration(milliseconds: 320),
                      child: IgnorePointer(
                        ignoring: !isOnline,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
                          child: Column(
                            children: [
                              _buildOnlineStatusBar(),
                              if (isOnline && !hasRequest) ...[
                                const SizedBox(height: 10),
                                _buildSearchingPill(),
                                if (_demandZones.isNotEmpty) ...[
                                  const SizedBox(height: 10),
                                  _buildDemandLegend(),
                                ],
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),

                // ── GO ONLINE / GO OFFLINE circular control ────────────
                // Sits at the bottom of the map (offline: on the map card's
                // bottom area, 28px above the card's bottom edge).
                if (!hasRequest)
                  AnimatedPositioned(
                    duration: const Duration(milliseconds: 500),
                    curve: Curves.easeInOutCubic,
                    left: 0, right: 0,
                    bottom: isOnline ? 32 : 48,
                    child: Center(
                      child: isOnline
                          ? _buildGoOfflineButton()
                          : _buildGoOnlineButton(),
                    ),
                  ),

                // ── Locate-me FAB (only when user pans away) ───────────
                if (!_shouldFollowUser && !hasRequest)
                  AnimatedPositioned(
                    duration: const Duration(milliseconds: 500),
                    curve: Curves.easeInOutCubic,
                    right: isOnline ? 20 : 32,
                    bottom: isOnline ? 128 : 140,
                    child: FloatingActionButton(
                      heroTag: null,
                      mini: true,
                      backgroundColor: Colors.white,
                      foregroundColor: const Color(0xFF2F3A32),
                      elevation: 4,
                      shape: const CircleBorder(),
                      onPressed: () {
                        setState(() => _shouldFollowUser = true);
                        if (_lastPosition != null) {
                          try {
                            _mapController.move(LatLng(_lastPosition!.latitude, _lastPosition!.longitude), 15.0);
                          } catch (_) {}
                        }
                      },
                      child: const Icon(Icons.my_location),
                    ),
                  ),

                // ── Incoming ride request card ─────────────────────────
                if (incomingRequest != null)
                  Positioned(
                    bottom: 24,
                    left: 20,
                    right: 20,
                    child: _IncomingRequestCard(
                      key: ValueKey('request_${incomingRequest.id}'),
                      request: incomingRequest,
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  // ── Offline dashboard widgets ─────────────────────────────────────

  Widget _buildOfflineHeader(DriverProvider provider, bool isOnline) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 16, offset: const Offset(0, 6)),
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
                  _firstName.isNotEmpty ? 'Hello, $_firstName' : 'Welcome back',
                  style: const TextStyle(color: Color(0xFF2F3A32), fontSize: 16, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  isOnline ? 'You\'re online' : 'You\'re offline',
                  style: TextStyle(
                    color: isOnline ? const Color(0xFF5B7760) : const Color(0xFF2F3A32).withOpacity(0.45),
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: isOnline ? const Color(0xFF5B7760) : const Color(0xFFF7F4EF),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Text(
              isOnline ? 'ONLINE' : 'OFFLINE',
              style: TextStyle(
                color: isOnline ? Colors.white : const Color(0xFF2F3A32).withOpacity(0.5),
                fontSize: 10,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.2,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildWeeklyEarningsCard() {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 16, offset: const Offset(0, 6)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'THIS WEEK',
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: Color(0xFF5B7760),
            ),
          ),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                _earningsLoading
                    ? '—'
                    : '\$${_weeklyFare.toStringAsFixed(2)}',
                style: const TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF2F3A32),
                  height: 1.1,
                ),
              ),
              const Spacer(),
              if (_weeklyRides > 0)
                Text(
                  '$_weeklyRides ride${_weeklyRides == 1 ? '' : 's'}',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: const Color(0xFF2F3A32).withOpacity(0.55)),
                ),
            ],
          ),
          const SizedBox(height: 10),
          Container(height: 1, color: const Color(0xFFD8D2CA).withOpacity(0.6)),
          const SizedBox(height: 10),
          Row(
            children: [
              const Icon(Icons.card_giftcard_rounded, size: 16, color: Color(0xFFC79A4A)),
              const SizedBox(width: 8),
              Text(
                'Tips',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: const Color(0xFF2F3A32).withOpacity(0.6)),
              ),
              const Spacer(),
              Text(
                _earningsLoading ? '—' : '\$${_weeklyTips.toStringAsFixed(2)}',
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ── Online mode widgets ───────────────────────────────────────────

  Widget _buildOnlineStatusBar() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 20, offset: const Offset(0, 8)),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _PulsingDot(color: const Color(0xFF5B7760)),
          const SizedBox(width: 10),
          const Text(
            'You\'re Online',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
          ),
          const SizedBox(width: 10),
          Text(
            _firstName.isNotEmpty ? '$_firstName is available' : 'Available',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: const Color(0xFF2F3A32).withOpacity(0.45)),
          ),
        ],
      ),
    );
  }

  Widget _buildSearchingPill() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(color: const Color(0xFF5B7760).withOpacity(0.35), blurRadius: 15, offset: const Offset(0, 8)),
        ],
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)),
          SizedBox(width: 12),
          Text('SEARCHING FOR RIDES', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 1)),
        ],
      ),
    );
  }

  /// Small translucent chip explaining the green circles on the map. Only
  /// shown while the heatmap is actually rendered.
  Widget _buildDemandLegend() {
    final hot = _demandZones.where((z) => z.score >= 0.5).length;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: Colors.white.withOpacity(0.92),
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 12, offset: const Offset(0, 6)),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 12,
            height: 12,
            decoration: const BoxDecoration(
              color: Color(0xFF5B7760),
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 8),
          Text(
            'Demand map · $hot hot area${hot == 1 ? '' : 's'}',
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
            ),
          ),
        ],
      ),
    );
  }

  /// Circular sage control that puts the driver online. Sits floating
  /// just above the map card's bottom edge.
  Widget _buildGoOnlineButton() {
    final enabled = !_isTogglingOnline;
    return Semantics(
      button: true,
      label: 'Go online',
      child: GestureDetector(
        onTap: enabled ? () => _goOnline(Provider.of<DriverProvider>(context, listen: false)) : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            color: const Color(0xFF5B7760),
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: const Color(0xFF5B7760).withOpacity(0.4),
                blurRadius: 18,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: _isTogglingOnline
              ? const Padding(
                  padding: EdgeInsets.all(24),
                  child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white),
                )
              : const Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(Icons.power_settings_new_rounded, size: 20, color: Colors.white),
                    SizedBox(height: 2),
                    Text(
                      'GO\nONLINE',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8,
                        height: 1.15,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }

  /// Neutral, clearly distinct control for coming back offline.
  Widget _buildGoOfflineButton() {
    final enabled = !_isTogglingOnline;
    return Semantics(
      button: true,
      label: 'Go offline',
      child: GestureDetector(
        onTap: enabled ? () => _goOffline(Provider.of<DriverProvider>(context, listen: false)) : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          width: 76,
          height: 76,
          decoration: BoxDecoration(
            color: Colors.white,
            shape: BoxShape.circle,
            border: Border.all(color: const Color(0xFFD8D2CA), width: 1.5),
            boxShadow: [
              BoxShadow(color: Colors.black.withOpacity(0.12), blurRadius: 16, offset: const Offset(0, 8)),
            ],
          ),
          child: const Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.pause_rounded, size: 20, color: Color(0xFF2F3A32)),
              SizedBox(height: 2),
              Text(
                'GO\nOFFLINE',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Color(0xFF2F3A32),
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.8,
                  height: 1.15,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Small pulsing dot used in the online status bar.
class _PulsingDot extends StatefulWidget {
  final Color color;
  const _PulsingDot({required this.color});

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: Tween<double>(begin: 0.35, end: 1).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
      ),
    );
  }
}

class _IncomingRequestCard extends StatefulWidget {
  final models.Trip request;
  const _IncomingRequestCard({super.key, required this.request});

  @override
  State<_IncomingRequestCard> createState() => _IncomingRequestCardState();
}

class _IncomingRequestCardState extends State<_IncomingRequestCard>
    with SingleTickerProviderStateMixin {
  static const Duration kFallbackWindow = Duration(seconds: 15);
  // Sage-family colors matching the rest of the app's palette.
  static const Color kAcceptFill = Color(0xFF5B7760); // primary sage
  static const Color kAcceptTrack = Color(0xFFC9D6CC); // desaturated light sage

  /// Backend-authoritative deadline. The backend emits `expires_at` with
  /// the offer; the client only renders the remaining time. A fallback
  /// window keeps things safe if the field is missing.
  late final DateTime _deadline;
  late final AnimationController _controller;
  bool _accepted = false;
  bool _declined = false;
  bool _expired = false;
  bool _entered = false;

  Timer? _countdownTimer;
  Timer? _expiryDismissTimer;

  @override
  void initState() {
    super.initState();
    _deadline = widget.request.expiresAt ?? DateTime.now().add(kFallbackWindow);
    var windowMs = _deadline.difference(DateTime.now()).inMilliseconds;
    if (windowMs < 1000) windowMs = 1000;
    if (windowMs > 30000) windowMs = 30000;

    SoundService.instance.play(SoundEffect.incomingRequest);

    // Tick once per second while the window is open (and only while it is).
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted || _accepted || _declined || _expired) {
        timer.cancel();
        return;
      }
      if (_deadline.difference(DateTime.now()).inSeconds <= 1) {
        timer.cancel();
        return;
      }
      SoundService.instance.play(SoundEffect.countdownTick);
    });

    _controller = AnimationController(vsync: this, duration: Duration(milliseconds: windowMs))
      ..addStatusListener(_onStatus)
      ..forward();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _entered = true);
    });
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed && mounted && !_accepted && !_declined) {
      _onTimeout();
    }
  }

  void _onTimeout() {
    if (_accepted || _declined || _expired) return;
    _countdownTimer?.cancel();
    _controller.stop();
    setState(() => _expired = true);
    // Stop any in-flight request cueing, show the expired state briefly,
    // then close the card and report the decline to the backend.
    SoundService.instance.stopAll();
    _expiryDismissTimer = Timer(const Duration(milliseconds: 1600), () {
      if (!mounted) return;
      final driverProvider = Provider.of<DriverProvider>(context, listen: false);
      driverProvider.declineTrip(widget.request.id);
    });
  }

  void _onAcceptTap() {
    if (_accepted || _declined || _expired) return;
    _accepted = true;
    _countdownTimer?.cancel();
    _expiryDismissTimer?.cancel();
    _controller.stop();
    SoundService.instance.play(SoundEffect.orderAccepted);
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    driverProvider.acceptTrip(widget.request.id);
    Navigator.pushNamed(context, '/trip');
  }

  void _onDeclineTap() {
    if (_accepted || _declined || _expired) return;
    _declined = true;
    _countdownTimer?.cancel();
    _expiryDismissTimer?.cancel();
    _controller.stop();
    SoundService.instance.play(SoundEffect.orderCancelled);
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);
    driverProvider.declineTrip(widget.request.id);
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _expiryDismissTimer?.cancel();
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

    // Smooth entrance: rise + fade in from below the screen edge.
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: _entered ? 1 : 0),
      duration: const Duration(milliseconds: 380),
      curve: Curves.easeOutCubic,
      builder: (context, value, child) {
        return Opacity(
          opacity: value,
          child: Transform.translate(
            offset: Offset(0, 36 * (1 - value)),
            child: child,
          ),
        );
      },
      child: _buildCard(req),
    );
  }

  Widget _buildCard(models.Trip req) {
    final price = req.calculatedPrice ?? req.fareAmount ?? 0.0;
    // Server-computed 60% driver share (cents). The line is hidden when the
    // field is absent — earnings are never derived client-side.
    final earnings = req.driverEarningsCents != null
        ? req.driverEarningsCents! / 100.0
        : null;
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
              Text(
                _expired ? 'REQUEST EXPIRED' : 'NEW RIDE REQUEST',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: _expired ? const Color(0xFFC65A5A) : const Color(0xFF5B7760),
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
          if (earnings != null) ...[
            const SizedBox(height: 2),
            Align(
              alignment: Alignment.centerRight,
              child: Text(
                'You earn \$${earnings.toStringAsFixed(2)}',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF5B7760),
                  letterSpacing: 0.3,
                ),
              ),
            ),
          ],
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

          // ---- Bottom action row -------------------------------------------
          if (_expired)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 16),
              decoration: BoxDecoration(
                color: const Color(0xFFC65A5A).withOpacity(0.08),
                borderRadius: BorderRadius.circular(16),
              ),
              child: const Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.hourglass_disabled_rounded, size: 18, color: Color(0xFFC65A5A)),
                  SizedBox(width: 10),
                  Text(
                    'Request Expired',
                    style: TextStyle(
                      color: Color(0xFFC65A5A),
                      fontWeight: FontWeight.w800,
                      fontSize: 15,
                      letterSpacing: 0.5,
                    ),
                  ),
                ],
              ),
            )
          else
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

/// Shrinking green Accept bar with right→left countdown wipe
/// and centered remaining-seconds label. The duration is derived from the
/// backend-authoritative deadline, so the wipe tracks server time.
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
    return GestureDetector(
      onTap: disabled ? null : onTap,
      child: SizedBox(
        height: 56,
        child: AnimatedBuilder(
          animation: controller,
          builder: (context, _) {
            final progress = controller.value; // 0 → 1
            final remaining = (controller.duration!.inMilliseconds *
                    (1 - progress))
                .ceil();
            final seconds = (remaining / 1000).ceil();
            // When the fill has mostly drained, switch to dark text on the light
            // track so the label stays readable.
            final filled = progress < 0.55;
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
