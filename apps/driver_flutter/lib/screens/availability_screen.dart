import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import '../providers/driver_provider.dart';
import '../models/trip_models.dart' as models;
import '../services/user_service.dart';

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

  @override
  void initState() {
    super.initState();
    _checkPermissions();
    _checkVerificationStatus();
  }

  Future<void> _checkVerificationStatus() async {
    try {
      final profile = await UserService.getProfile();
      if (mounted) {
        setState(() {
          _isVerified = profile['is_active'] == true || profile['is_active'] == 'true';
        });
      }
    } catch (e) {
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

    // Fetch initial position immediately to avoid SF fallback or stuck state
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
      print("Error getting initial location: $e");
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  void _startTracking(DriverProvider provider) {
    _positionSubscription?.cancel();
    _heartbeatTimer?.cancel();

    _positionSubscription = Geolocator.getPositionStream(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.bestForNavigation,
        distanceFilter: 0, 
      ),
    ).listen((Position position) {
      if (!mounted) return;
      setState(() {
        _lastPosition = position;
      });

      // Only update server if driver is explicitly online
      if (provider.status != models.DriverStatus.offline) {
        provider.updateLocation(position.latitude, position.longitude);
      }
      
      if (_shouldFollowUser && _isMapReady) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _isMapReady) {
            _mapController.move(LatLng(position.latitude, position.longitude), 15.0);
          }
        });
      }
    });

    _heartbeatTimer = Timer.periodic(const Duration(seconds: 10), (timer) {
      if (_lastPosition != null && provider.status != models.DriverStatus.offline) {
        provider.updateLocation(_lastPosition!.latitude, _lastPosition!.longitude);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final driverProvider = Provider.of<DriverProvider>(context);
    
    // AUTO-NAVIGATE: If a trip is active, push to trip screen automatically
    if (driverProvider.currentTrip != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          // Check if we are already on the trip screen to avoid duplicate pushes
          bool isTripScreenOpen = false;
          Navigator.popUntil(context, (route) {
            if (route.settings.name == '/trip') isTripScreenOpen = true;
            return true;
          });
          
          if (!isTripScreenOpen) {
            Navigator.pushNamed(context, '/trip');
          }
        }
      });
    }

    // Always track for the map UI so the driver can see where they are
    if (_positionSubscription == null && !_isLoading) {
      _startTracking(driverProvider);
    }

    if (_isLoading) {
      return const Scaffold(
        backgroundColor: Color(0xFF1E1E1E),
        body: Center(child: CircularProgressIndicator(color: Colors.white)),
      );
    }

    LatLng initialCenter = _lastPosition != null 
        ? LatLng(_lastPosition!.latitude, _lastPosition!.longitude)
        : const LatLng(0, 0); 

    if (_lastPosition == null) {
       return const Scaffold(
        backgroundColor: Color(0xFF1E1E1E),
        body: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              CircularProgressIndicator(color: Colors.white),
              SizedBox(height: 20),
              Text("Initializing Map...", style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFF2C2C2C),
      body: Stack(
        children: [
          FlutterMap(
            mapController: _mapController,
            options: MapOptions(
              initialCenter: initialCenter,
              initialZoom: 15.0,
              onMapReady: () {
                setState(() => _isMapReady = true);
              },
              onPositionChanged: (pos, hasGesture) {
                if (hasGesture) {
                  setState(() => _shouldFollowUser = false);
                }
              },
            ),
            children: [
              TileLayer(
                urlTemplate: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
                subdomains: const ['a', 'b', 'c', 'd'],
                userAgentPackageName: 'com.uberish.driver',
                tileBuilder: (context, tileWidget, tile) {
                  return ColorFiltered(
                    colorFilter: ColorFilter.mode(
                      Colors.black.withOpacity(0.1),
                      BlendMode.darken,
                    ),
                    child: tileWidget,
                  );
                },
              ),
              if (_lastPosition != null)
                MarkerLayer(
                  markers: [
                    Marker(
                      point: LatLng(_lastPosition!.latitude, _lastPosition!.longitude),
                      width: 60,
                      height: 60,
                      child: Container(
                        decoration: BoxDecoration(
                          color: Colors.green.withOpacity(0.15),
                          shape: BoxShape.circle,
                        ),
                        child: Center(
                          child: Container(
                            width: 14,
                            height: 14,
                            decoration: BoxDecoration(
                              color: Colors.green,
                              shape: BoxShape.circle,
                              border: Border.all(color: Colors.white, width: 2),
                              boxShadow: [BoxShadow(blurRadius: 10, color: Colors.green.withOpacity(0.5))],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
            ],
          ),

          // Top Status Bar (Rounded & Premium)
          Positioned(
            top: 50,
            left: 20,
            right: 20,
            child: Row(
              children: [
                const SizedBox(width: 12),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                    decoration: BoxDecoration(
                      color: Colors.black,
                      borderRadius: BorderRadius.circular(32),
                      boxShadow: [
                        BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 20, offset: const Offset(0, 8)),
                      ],
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              driverProvider.status == models.DriverStatus.offline ? "OFFLINE" : "ONLINE",
                              style: const TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.w900, letterSpacing: 1.5),
                            ),
                            const Text(
                              'GO START',
                              style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w900),
                            ),
                          ],
                        ),
                        Row(
                          children: [
                            Container(
                              width: 10,
                              height: 10,
                              decoration: BoxDecoration(
                                color: driverProvider.isConnected ? Colors.greenAccent : Colors.redAccent,
                                shape: BoxShape.circle,
                                boxShadow: [BoxShadow(color: driverProvider.isConnected ? Colors.greenAccent : Colors.redAccent, blurRadius: 8)],
                              ),
                            ),
                            const SizedBox(width: 15),
                            Switch(
                              value: _isVerified && driverProvider.status != models.DriverStatus.offline,
                              onChanged: (val) {
                                if (!_isVerified) {
                                  _showError('Account pending admin approval.');
                                  return;
                                }
                                if (val) {
                                  driverProvider.setOnline(
                                    lat: _lastPosition?.latitude,
                                    lng: _lastPosition?.longitude,
                                  );
                                } else {
                                  driverProvider.setOffline();
                                }
                              },
                              activeColor: Colors.white,
                              activeTrackColor: Colors.greenAccent,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),

          if (!_isVerified)
            Positioned.fill(
              child: Container(
                color: Colors.black.withOpacity(0.7),
                child: Center(
                  child: Container(
                    margin: const EdgeInsets.symmetric(horizontal: 40),
                    padding: const EdgeInsets.all(30),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(24),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.pending_actions, size: 60, color: Colors.orange),
                        const SizedBox(height: 20),
                        const Text(
                          'Pending Approval',
                          style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
                        ),
                        const SizedBox(height: 12),
                        const Text(
                          'Your documents are being reviewed by our team. You will be notified once you can start driving.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.grey),
                        ),
                        const SizedBox(height: 30),
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: () => _checkVerificationStatus(),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.black,
                              padding: const EdgeInsets.symmetric(vertical: 15),
                            ),
                            child: const Text('Check Status', style: TextStyle(color: Colors.white)),
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
                backgroundColor: Colors.white,
                elevation: 8,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                onPressed: () {
                  setState(() => _shouldFollowUser = true);
                  if (_lastPosition != null) {
                    _mapController.move(LatLng(_lastPosition!.latitude, _lastPosition!.longitude), 15.0);
                  }
                },
                child: const Icon(Icons.my_location, color: Colors.black),
              ),
            ),

          if (driverProvider.incomingRequest != null)
            Positioned(
              bottom: 40,
              left: 20,
              right: 20,
              child: _IncomingRequestCard(request: driverProvider.incomingRequest!),
            ),
          
          if (driverProvider.status == models.DriverStatus.online && driverProvider.incomingRequest == null)
            Positioned(
              top: 150,
              left: 0,
              right: 0,
              child: Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                  decoration: BoxDecoration(
                    color: Colors.greenAccent,
                    borderRadius: BorderRadius.circular(32),
                    boxShadow: [BoxShadow(color: Colors.greenAccent.withOpacity(0.4), blurRadius: 20, offset: const Offset(0, 10))],
                  ),
                  child: const Text('SEARCHING...', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, letterSpacing: 2)),
                ),
              ),
            ),
        ],
      ),
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
      padding: const EdgeInsets.all(25),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(32),
        boxShadow: [
          BoxShadow(color: Colors.black.withOpacity(0.4), blurRadius: 30, offset: const Offset(0, 15)),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('NEW REQUEST', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w900, color: Colors.green, letterSpacing: 2)),
              Text('\$${(request.fareAmount ?? 24.50).toStringAsFixed(2)}', style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, letterSpacing: -1)),
            ],
          ),
          const SizedBox(height: 25),
          Row(
            children: [
              const Icon(Icons.circle, size: 10, color: Colors.green),
              const SizedBox(width: 15),
              Expanded(
                child: Text(
                  request.pickup.address ?? 'Current Location',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 15),
          Row(
            children: [
              const Icon(Icons.square, size: 10, color: Colors.black),
              const SizedBox(width: 15),
              Expanded(
                child: Text(
                  request.destination.address ?? 'Destination',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const SizedBox(height: 35),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => driverProvider.setIncomingRequest(null),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.all(20),
                    side: const BorderSide(color: Colors.black, width: 2),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                  ),
                  child: const Text('DECLINE', style: TextStyle(fontWeight: FontWeight.w900, color: Colors.black, letterSpacing: 1.5)),
                ),
              ),
              const SizedBox(width: 15),
              Expanded(
                child: Container(
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(24),
                    boxShadow: [BoxShadow(color: Colors.greenAccent.withOpacity(0.3), blurRadius: 15, offset: const Offset(0, 8))],
                  ),
                  child: ElevatedButton(
                    onPressed: () {
                      driverProvider.acceptTrip(request.id);
                      Navigator.pushNamed(context, '/trip');
                    },
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.black,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.all(20),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
                    ),
                    child: const Text('ACCEPT', style: TextStyle(fontWeight: FontWeight.w900, letterSpacing: 1.5)),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
