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
  bool _isLoading = true;
  bool _isMapReady = false;
  bool _isVerified = false;
  String _firstName = "";

  @override
  void initState() {
    super.initState();
    _checkPermissions();
    _checkVerificationStatus();
    _fetchProfile();
  }

  Future<void> _fetchProfile() async {
    try {
      final profile = await UserService.getProfile();
      if (mounted) {
        setState(() {
          final fullName = profile['full_name'] ?? 'Driver';
          _firstName = fullName.split(' ')[0];
        });
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

  Future<void> _checkVerificationStatus() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final token = prefs.getString('jwt_token');
      if (token == null) return;

      final profile = await UserService.getProfile();
      if (mounted) {
        setState(() {
          _isVerified = profile['is_active'] == true || profile['is_active'] == 'true';
        });
      }
    } catch (e) {
      if (e is DioException && e.response?.statusCode == 404) {
        // Already handled in _fetchProfile, but good to be safe
        return;
      }
      debugPrint('Error checking verification: $e');
    }
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _heartbeatTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkPermissions() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (mounted) setState(() => _isLoading = false);
      return;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        if (mounted) setState(() => _isLoading = false);
        return;
      }
    }

    try {
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.bestForNavigation,
      );
      if (mounted) {
        setState(() {
          _lastPosition = position;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _isLoading = false);
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

    if (_positionSubscription == null && !_isLoading) {
      _startTracking(driverProvider);
    }

    if (_isLoading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    LatLng initialCenter = _lastPosition != null 
        ? LatLng(_lastPosition!.latitude, _lastPosition!.longitude)
        : const LatLng(0, 0); 

    final bool isOnline = driverProvider.status != models.DriverStatus.offline;

    return Scaffold(
      body: Stack(
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
              if (_lastPosition != null)
                MarkerLayer(
                  markers: [
                    Marker(
                      point: LatLng(_lastPosition!.latitude, _lastPosition!.longitude),
                      width: 50,
                      height: 50,
                      child: _buildUserLocationMarker(isOnline),
                    ),
                  ],
                ),
            ],
          ),

          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              child: Container(
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
                      value: _isVerified && isOnline,
                      onChanged: (val) {
                        if (!_isVerified) {
                          _showError('Account pending admin approval.');
                          return;
                        }
                        if (val) {
                          driverProvider.setOnline(lat: _lastPosition?.latitude, lng: _lastPosition?.longitude);
                        } else {
                          driverProvider.setOffline();
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
            ),
          ),

          if (!_isVerified)
            Positioned.fill(
              child: Container(
                color: const Color(0xFFEEEBE6).withOpacity(0.9),
                padding: const EdgeInsets.symmetric(horizontal: 40),
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.all(32),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(color: const Color(0xFFD8D2CA)),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.05), blurRadius: 30)],
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.verified_user_outlined, size: 64, color: Color(0xFFC79A4A)),
                        const SizedBox(height: 24),
                        const Text(
                          'Verification Pending',
                          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32)),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          'Our team is reviewing your documents. This usually takes 1-3 business days.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.6), height: 1.5),
                        ),
                        const SizedBox(height: 32),
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: () => _checkVerificationStatus(),
                            child: const Text('CHECK STATUS'),
                          ),
                        ),
                      ],
                    ),
                  ),
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
              child: Center(
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
            ),
        ],
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

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: const Color(0xFFC65A5A), behavior: SnackBarBehavior.floating),
    );
  }
}

class _IncomingRequestCard extends StatelessWidget {
  final models.Trip request;
  const _IncomingRequestCard({required this.request});

  @override
  Widget build(BuildContext context) {
    final driverProvider = Provider.of<DriverProvider>(context, listen: false);

    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.12), blurRadius: 30, offset: const Offset(0, 10))],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('NEW RIDE REQUEST', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800, color: Color(0xFF5B7760), letterSpacing: 1.5)),
              Text('\$${(request.fareAmount ?? 0.00).toStringAsFixed(2)}', style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: Color(0xFF2F3A32))),
            ],
          ),
          const SizedBox(height: 16),
          if (request.riderInfo != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFFF7F4EF),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  const Icon(Icons.person_outline, size: 16, color: Color(0xFF5B7760)),
                  const SizedBox(width: 8),
                  Text(
                    request.riderInfo!.name,
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                  ),
                  const Spacer(),
                  const Icon(Icons.star_rounded, color: Color(0xFFC79A4A), size: 16),
                  const SizedBox(width: 4),
                  Text(
                    request.riderInfo!.rating.toStringAsFixed(1),
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '(${request.riderInfo!.totalRides})',
                    style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.5)),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 24),
          _buildRow(Icons.circle, const Color(0xFF5B7760), request.pickup.address ?? 'Pickup'),
          const SizedBox(height: 12),
          _buildRow(Icons.square, const Color(0xFF2F3A32), request.destination.address ?? 'Destination'),
          const SizedBox(height: 32),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => driverProvider.setIncomingRequest(null),
                  child: const Text('DECLINE'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ElevatedButton(
                  onPressed: () {
                    driverProvider.acceptTrip(request.id);
                    Navigator.pushNamed(context, '/trip');
                  },
                  child: const Text('ACCEPT'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildRow(IconData icon, Color color, String text) {
    return Row(
      children: [
        Icon(icon, size: 8, color: color),
        const SizedBox(width: 16),
        Expanded(child: Text(text, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: Color(0xFF2F3A32)), maxLines: 1, overflow: TextOverflow.ellipsis)),
      ],
    );
  }
}
