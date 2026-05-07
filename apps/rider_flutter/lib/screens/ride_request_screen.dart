import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;

class RideRequestScreen extends StatefulWidget {
  const RideRequestScreen({super.key});

  @override
  State<RideRequestScreen> createState() => _RideRequestScreenState();
}

class _RideRequestScreenState extends State<RideRequestScreen> {
  double _fare = 0.0;

  @override
  void initState() {
    super.initState();
    _fare = (10 + (10 * 2.0)).toDouble();
  }

  @override
  Widget build(BuildContext context) {
    final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
    final models.Location pickup = args['pickup'];
    final models.Location destination = args['destination'];
    final rideProvider = Provider.of<RideProvider>(context);
    final theme = Theme.of(context);

    if (rideProvider.status == models.TripStatus.ACCEPTED) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Navigator.pushReplacementNamed(context, '/trip');
      });
    }

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF2F3A32)),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          'Confirm Ride',
          style: theme.textTheme.headlineMedium?.copyWith(fontSize: 24),
        ),
        centerTitle: true,
      ),
      body: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildLocationSection(
              title: 'PICKUP',
              address: pickup.address ?? 'Current Location',
              icon: Icons.circle,
              iconColor: const Color(0xFF5B7760),
            ),
            const SizedBox(height: 24),
            _buildLocationSection(
              title: 'DESTINATION',
              address: destination.address ?? 'Selected Destination',
              icon: Icons.square,
              iconColor: const Color(0xFF2F3A32),
            ),
            const SizedBox(height: 40),
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: const Color(0xFFD8D2CA)),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.03),
                    blurRadius: 20,
                    offset: const Offset(0, 10),
                  ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Estimated fare',
                        style: TextStyle(
                          color: const Color(0xFF2F3A32).withOpacity(0.5),
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'NetRide Premium',
                        style: TextStyle(
                          color: const Color(0xFF2F3A32),
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  Text(
                    '\$${_fare.toStringAsFixed(2)}',
                    style: const TextStyle(
                      color: Color(0xFF2F3A32),
                      fontSize: 32,
                      fontWeight: FontWeight.w700,
                      letterSpacing: -1,
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(),
            if (rideProvider.status == models.TripStatus.ACCEPTED && rideProvider.currentTrip?.driverInfo != null)
              Container(
                margin: const EdgeInsets.only(bottom: 32),
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF6E8B74).withOpacity(0.1),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: const Color(0xFF6E8B74).withOpacity(0.2)),
                ),
                child: Row(
                  children: [
                    const CircleAvatar(
                      backgroundColor: Colors.white,
                      child: Icon(Icons.person, color: Color(0xFF5B7760)),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            rideProvider.currentTrip!.driverInfo!.name,
                            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                          ),
                          Row(
                            children: [
                              const Icon(Icons.star_rounded, color: Color(0xFFC79A4A), size: 16),
                              const SizedBox(width: 4),
                              Text(
                                rideProvider.currentTrip!.driverInfo!.rating.toStringAsFixed(1),
                                style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                              ),
                              const SizedBox(width: 4),
                              Text(
                                '(${rideProvider.currentTrip!.driverInfo!.totalRides} rides)',
                                style: TextStyle(fontSize: 12, color: const Color(0xFF2F3A32).withOpacity(0.5)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            if (rideProvider.status == models.TripStatus.REQUESTED)
              Center(
                child: Column(
                  children: [
                    const CircularProgressIndicator(),
                    const SizedBox(height: 32),
                    Text(
                      'Finding your driver...',
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                        fontSize: 18,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Matching you with a nearby premium vehicle',
                      style: TextStyle(
                        color: const Color(0xFF2F3A32).withOpacity(0.5),
                      ),
                    ),
                    const SizedBox(height: 40),
                    TextButton(
                      onPressed: () => rideProvider.reset(),
                      child: const Text(
                        'CANCEL REQUEST',
                        style: TextStyle(
                          color: Color(0xFFC65A5A),
                          fontWeight: FontWeight.w600,
                          letterSpacing: 1.2,
                        ),
                      ),
                    ),
                  ],
                ),
              )
            else
              Hero(
                tag: 'confirm_button',
                child: SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: () => rideProvider.requestRide(pickup, destination),
                    child: const Text('REQUEST NetRide'),
                  ),
                ),
              ),
            const SizedBox(height: 20),
          ],
        ),
      ),
    );
  }

  Widget _buildLocationSection({
    required String title,
    required String address,
    required IconData icon,
    required Color iconColor,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: TextStyle(
            color: const Color(0xFF2F3A32).withOpacity(0.4),
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.5,
          ),
        ),
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFD8D2CA)),
          ),
          child: Row(
            children: [
              Icon(icon, size: 10, color: iconColor),
              const SizedBox(width: 16),
              Expanded(
                child: Text(
                  address,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w500,
                    color: Color(0xFF2F3A32),
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

