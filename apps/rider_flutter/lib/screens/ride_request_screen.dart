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

    if (rideProvider.status == models.TripStatus.ACCEPTED) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        Navigator.pushReplacementNamed(context, '/trip');
      });
    }

    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new, color: Colors.black, size: 20),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('Ride Details', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w900, fontSize: 22)),
      ),
      body: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('PICKUP', style: TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 1.5)),
            const SizedBox(height: 10),
            Hero(
              tag: 'pickup_search',
              child: Material(
                color: Colors.transparent,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.grey[100],
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: Colors.grey.shade200),
                  ),
                  child: Text(pickup.address ?? 'Selected Pickup', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
              ),
            ),
            const SizedBox(height: 25),
            const Text('DESTINATION', style: TextStyle(color: Colors.grey, fontSize: 12, fontWeight: FontWeight.w800, letterSpacing: 1.5)),
            const SizedBox(height: 10),
            Hero(
              tag: 'destination_search',
              child: Material(
                color: Colors.transparent,
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(20),
                  decoration: BoxDecoration(
                    color: Colors.grey[100],
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: Colors.grey.shade200),
                  ),
                  child: Text(destination.address ?? 'Selected Destination', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                ),
              ),
            ),
            const SizedBox(height: 40),
            Container(
              padding: const EdgeInsets.all(25),
              decoration: BoxDecoration(
                color: Colors.black,
                borderRadius: BorderRadius.circular(32),
                boxShadow: [
                  BoxShadow(color: Colors.black.withOpacity(0.3), blurRadius: 20, offset: const Offset(0, 10)),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('ESTIMATED FARE', style: TextStyle(color: Colors.grey, fontSize: 14, fontWeight: FontWeight.bold)),
                  Text('\$${_fare.toStringAsFixed(2)}', style: const TextStyle(color: Colors.white, fontSize: 32, fontWeight: FontWeight.w900, letterSpacing: -1)),
                ],
              ),
            ),
            const Spacer(),
            if (rideProvider.status == models.TripStatus.REQUESTED)
              Center(
                child: Column(
                  children: [
                    const SizedBox(
                      height: 60,
                      width: 60,
                      child: CircularProgressIndicator(color: Colors.black, strokeWidth: 5),
                    ),
                    const SizedBox(height: 30),
                    const Text('Connecting you to a driver...', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                    const SizedBox(height: 10),
                    const Text('Hang tight, we\'re finding the best match', style: TextStyle(color: Colors.grey, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 40),
                    TextButton(
                      onPressed: () => rideProvider.reset(),
                      style: TextButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 30, vertical: 15),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32)),
                      ),
                      child: const Text('CANCEL REQUEST', style: TextStyle(color: Colors.redAccent, fontWeight: FontWeight.w900, letterSpacing: 1.5)),
                    ),
                  ],
                ),
              )
            else
              Hero(
                tag: 'confirm_button',
                child: Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(32),
                    gradient: const LinearGradient(
                      colors: [Colors.black, Color(0xFF2C2C2C)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    boxShadow: [
                      BoxShadow(color: Colors.black.withOpacity(0.4), blurRadius: 15, offset: const Offset(0, 8)),
                    ],
                  ),
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.all(22),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(32)),
                      elevation: 0,
                    ),
                    onPressed: () => rideProvider.requestRide(pickup, destination),
                    child: const Text('REQUEST UBERISH', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, letterSpacing: 2)),
                  ),
                ),
              ),
            const SizedBox(height: 30),
          ],
        ),
      ),
    );
  }
}
