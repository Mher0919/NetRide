import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/ride_provider.dart';
import '../models/trip_models.dart' as models;
import '../components/state_container.dart';
import '../services/api_service.dart';
import 'package:intl/intl.dart';

class RideRequestScreen extends StatefulWidget {
  const RideRequestScreen({super.key});

  @override
  State<RideRequestScreen> createState() => _RideRequestScreenState();
}

class _RideRequestScreenState extends State<RideRequestScreen> {
  double _baseFare = 0.0;
  models.VehicleClass _selectedClass = models.VehicleClass.CORE;
  bool _favoritePriority = false;
  DateTime? _scheduledTime;

  double? _maxFare;
  int? _savingLikelihood;
  bool _loadingEstimate = false;
  bool _initialized = false;
  late models.Location _pickup;
  late models.Location _destination;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_initialized) {
      final args = ModalRoute.of(context)!.settings.arguments as Map<String, dynamic>;
      _pickup = args['pickup'];
      _destination = args['destination'];
      _initialized = true;
      _fetchEstimate(_pickup, _destination);
    }
  }

  Future<void> _fetchEstimate(models.Location pickup, models.Location destination) async {
    setState(() {
      _loadingEstimate = true;
    });
    try {
      final response = await ApiService.dio.post('/routing/plan', data: {
        'origin': [pickup.lat, pickup.lng],
        'destination': [destination.lat, destination.lng],
        'vehicleClass': _selectedClass.toString().split('.').last,
      });
      final data = response.data;
      setState(() {
        _maxFare = (data['fare']['totalFare'] as num).toDouble();
        _loadingEstimate = false;
      });
    } catch (e) {
      debugPrint('Error fetching estimate: $e');
      setState(() {
        _loadingEstimate = false;
      });
    }
  }

  @override
  void initState() {
    super.initState();
    // Rough mock distance 10km
    _baseFare = 10.0 + (10 * 1.5); 
  }

  double _getFare() {
    double multiplier = 1.0;
    if (_selectedClass == models.VehicleClass.ELITE) multiplier = 1.6;
    if (_selectedClass == models.VehicleClass.PRESTIGE) multiplier = 2.4;
    return _baseFare * multiplier;
  }

  Future<void> _pickDateTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: DateTime.now().add(const Duration(hours: 2)),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 7)),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(colorScheme: const ColorScheme.light(primary: Colors.black)),
        child: child!,
      ),
    );

    if (date == null) return;

    if (!mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(DateTime.now().add(const Duration(hours: 2))),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(colorScheme: const ColorScheme.light(primary: Colors.black)),
        child: child!,
      ),
    );

    if (time == null) return;

    setState(() {
      _scheduledTime = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
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
      body: StateContainer(
        state: rideProvider.status == models.TripStatus.REQUESTED ? ViewState.loading : ViewState.success,
        loadingWidget: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const CircularProgressIndicator(color: Color(0xFF5B7760)),
              const SizedBox(height: 32),
              const Text(
                'Securing the best driver...',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 20, color: Color(0xFF2F3A32)),
              ),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 40),
                child: Text(
                  'Matching based on distance, rating and reliability.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.5), fontWeight: FontWeight.w500),
                ),
              ),
              const SizedBox(height: 48),
              SizedBox(
                width: 200,
                child: OutlinedButton(
                  onPressed: () => rideProvider.reset(),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: const Color(0xFFC65A5A),
                    side: const BorderSide(color: Color(0xFFC65A5A)),
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('CANCEL REQUEST', style: TextStyle(fontWeight: FontWeight.w700, letterSpacing: 1)),
                ),
              ),
            ],
          ),
        ),
        successWidget: SingleChildScrollView(
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
              const SizedBox(height: 32),
              
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('SERVICE CLASS', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: Color(0xFF5B7760), letterSpacing: 1.2)),
                  GestureDetector(
                    onTap: _pickDateTime,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                      decoration: BoxDecoration(
                        color: _scheduledTime != null ? const Color(0xFF5B7760).withOpacity(0.1) : Colors.transparent,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: _scheduledTime != null ? const Color(0xFF5B7760) : Colors.grey.shade300),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.calendar_today_rounded, size: 14, color: _scheduledTime != null ? const Color(0xFF5B7760) : Colors.grey),
                          const SizedBox(width: 8),
                          Text(
                            _scheduledTime != null ? DateFormat('MMM d, h:mm a').format(_scheduledTime!) : 'SCHEDULE',
                            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: _scheduledTime != null ? const Color(0xFF5B7760) : Colors.grey),
                          ),
                          if (_scheduledTime != null) ...[
                            const SizedBox(width: 4),
                            GestureDetector(
                              onTap: () => setState(() => _scheduledTime = null),
                              child: const Icon(Icons.close, size: 14, color: Color(0xFF5B7760)),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 110,
                child: ListView(
                  scrollDirection: Axis.horizontal,
                  children: [
                    _buildClassOption(title: 'CORE', icon: Icons.directions_car_filled_outlined, vClass: models.VehicleClass.CORE),
                    const SizedBox(width: 12),
                    _buildClassOption(title: 'ELITE', icon: Icons.stars_rounded, vClass: models.VehicleClass.ELITE),
                    const SizedBox(width: 12),
                    _buildClassOption(title: 'PRESTIGE', icon: Icons.workspace_premium_rounded, vClass: models.VehicleClass.PRESTIGE),
                  ],
                ),
              ),

              const SizedBox(height: 24),
              _buildToggleOption(
                title: 'Favorite Driver Priority',
                subtitle: 'Prioritize drivers you have previously bookmarked.',
                value: _favoritePriority,
                onChanged: (val) => setState(() => _favoritePriority = val),
              ),

              const SizedBox(height: 32),
              Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: const Color(0xFFD8D2CA)),
                  boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.03), blurRadius: 20, offset: const Offset(0, 10))],
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Maximum Fare', style: TextStyle(color: const Color(0xFF2F3A32).withOpacity(0.5), fontSize: 13, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 2),
                          Text('NetRide ${_selectedClass.toString().split('.').last}', style: const TextStyle(color: Color(0xFF2F3A32), fontSize: 16, fontWeight: FontWeight.w700)),
                          if (!_loadingEstimate && _savingLikelihood != null && _savingLikelihood! > 0) ...[
                            const SizedBox(height: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                              decoration: BoxDecoration(
                                color: const Color(0xFF5B7760).withOpacity(0.08),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.check_circle_outline, size: 12, color: Color(0xFF5B7760)),
                                  const SizedBox(width: 4),
                                  Text(
                                    'You are $_savingLikelihood% likely to pay less',
                                    style: const TextStyle(
                                      fontSize: 9,
                                      fontWeight: FontWeight.w800,
                                      color: Color(0xFF5B7760),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    _loadingEstimate
                        ? const SizedBox(
                            width: 24,
                            height: 24,
                            child: CircularProgressIndicator(strokeWidth: 2.5, color: Color(0xFF5B7760)),
                          )
                        : Text(
                            '\$${_maxFare?.toStringAsFixed(2) ?? '0.00'}',
                            style: const TextStyle(color: Color(0xFF2F3A32), fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: -0.5),
                          ),
                  ],
                ),
              ),
              const SizedBox(height: 40),
              Hero(
                tag: 'confirm_button',
                child: SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton(
                    onPressed: () {
                      rideProvider.requestRide(
                        pickup, 
                        destination, 
                        requestedClass: _selectedClass,
                        isScheduled: _scheduledTime != null,
                        scheduledAt: _scheduledTime,
                        favoritePriority: _favoritePriority,
                      );
                    },
                    child: Text(_scheduledTime != null ? 'BOOK FOR ${DateFormat('h:mm a').format(_scheduledTime!)}' : 'REQUEST ${_selectedClass.toString().split('.').last}'),
                  ),
                ),
              ),
              const SizedBox(height: 20),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLocationSection({required String title, required String address, required IconData icon, required Color iconColor}) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Icon(icon, size: 14, color: iconColor),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Colors.grey, letterSpacing: 1)),
              const SizedBox(height: 4),
              Text(address, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF2F3A32))),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildToggleOption({required String title, required String subtitle, required bool value, required Function(bool) onChanged}) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: value ? const Color(0xFF5B7760).withOpacity(0.05) : Colors.transparent,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: value ? const Color(0xFF5B7760) : Colors.grey.shade200),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
                const SizedBox(height: 2),
                Text(subtitle, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
              ],
            ),
          ),
          Switch(
            value: value, 
            onChanged: onChanged,
            activeThumbColor: const Color(0xFF5B7760),
          ),
        ],
      ),
    );
  }

  Widget _buildClassOption({required String title, required IconData icon, required models.VehicleClass vClass}) {
    final isSelected = _selectedClass == vClass;
    return GestureDetector(
      onTap: () {
        setState(() => _selectedClass = vClass);
        _fetchEstimate(_pickup, _destination);
      },
      child: Container(
        width: 100,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: isSelected ? const Color(0xFF5B7760) : Colors.white,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: isSelected ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA)),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: isSelected ? Colors.white : const Color(0xFF5B7760), size: 28),
            const SizedBox(height: 8),
            Text(
              title,
              style: TextStyle(
                color: isSelected ? Colors.white : const Color(0xFF2F3A32),
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
