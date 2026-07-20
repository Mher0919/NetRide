import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';
import '../models/trip_models.dart' as models;
import '../providers/driver_provider.dart';

/// Ride-type preference labels (UI-facing). The backend uses the internal
/// codes CORE / ELITE / PRESTIGE; these are the premium-product names.
const Map<String, String> _rideTypeLabels = {
  'CORE': 'NetRide Core',
  'ELITE': 'NetRide Elite',
  'PRESTIGE': 'NetRide Prestige',
};

const Map<String, String> _rideTypeSubtitles = {
  'CORE': 'Standard everyday rides',
  'ELITE': 'Premium luxury sedan rides',
  'PRESTIGE': 'Large luxury SUV rides',
};

class RidePreferencesScreen extends StatefulWidget {
  const RidePreferencesScreen({super.key});

  @override
  State<RidePreferencesScreen> createState() => _RidePreferencesScreenState();
}

class _RidePreferencesScreenState extends State<RidePreferencesScreen> {
  Map<String, bool> _localPrefs = {};
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final provider = Provider.of<DriverProvider>(context, listen: false);
    // Seed local state from what the provider already holds (fetched on load).
    _localPrefs = {
      for (final t in provider.eligibleRideTypes) t: provider.ridePreferences[t] == true,
    };
    if (provider.eligibleRideTypes.isEmpty) {
      _load(provider);
    }
  }

  Future<void> _load(DriverProvider provider) async {
    try {
      await provider.fetchRidePreferences();
      if (mounted) {
        setState(() {
          _localPrefs = {
            for (final t in provider.eligibleRideTypes) t: provider.ridePreferences[t] == true,
          };
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceAll('Exception: ', ''));
    }
  }

  Future<void> _save(DriverProvider provider) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final enabled = _localPrefs.entries
          .where((e) => e.value)
          .map((e) => e.key)
          .toList();
      await provider.saveRidePreferences(enabled);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Ride preferences saved'),
            backgroundColor: Color(0xFF5B7760),
            behavior: SnackBarBehavior.floating,
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString().replaceAll('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<DriverProvider>(context);
    final eligible = provider.eligibleRideTypes;

    return Scaffold(
      backgroundColor: const Color(0xFFEEEBE6),
      appBar: AppBar(
        backgroundColor: const Color(0xFFEEEBE6),
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: Color(0xFF2F3A32)),
          onPressed: () => Navigator.pop(context),
        ),
        title: Text(
          'Ride Preferences',
          style: GoogleFonts.inter(
            color: const Color(0xFF2F3A32),
            fontWeight: FontWeight.w800,
            fontSize: 20,
          ),
        ),
      ),
      body: eligible.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: const Color(0xFFD8D2CA)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Your vehicle is classified as',
                        style: GoogleFonts.inter(
                          color: Colors.grey[600],
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        _rideTypeLabels[provider.vehicleClass] ?? provider.vehicleClass,
                        style: GoogleFonts.inter(
                          color: const Color(0xFF5B7760),
                          fontSize: 18,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'You can enable or disable any ride type your vehicle is eligible for. '
                        'Disabled types will not be offered to you.',
                        style: GoogleFonts.inter(
                          color: Colors.grey[600],
                          fontSize: 13,
                          height: 1.4,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  'OPERATING MODE',
                  style: GoogleFonts.inter(
                    color: Colors.grey[500],
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1,
                  ),
                ),
                const SizedBox(height: 12),
                _buildOperatingModeSelector(provider),
                const SizedBox(height: 20),
                Text(
                  'RIDE PREFERENCES',
                  style: GoogleFonts.inter(
                    color: Colors.grey[500],
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1,
                  ),
                ),
                const SizedBox(height: 12),
                ...eligible.map((type) => _buildToggle(type)).toList(),
                if (_error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.red.withOpacity(0.08),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(_error!, style: const TextStyle(color: Colors.red)),
                  ),
                ],
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    onPressed: _saving ? null : () => _save(provider),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF5B7760),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                      textStyle: GoogleFonts.inter(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    child: _saving
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(
                              color: Colors.white,
                              strokeWidth: 2,
                            ),
                          )
                        : const Text('Save Preferences'),
                  ),
                ),
              ],
            ),
    );
  }

  Widget _buildOperatingModeSelector(DriverProvider provider) {
    final allModes = [
      ('CORE', 'NetRide Core', 'Standard everyday rides'),
      ('ELITE', 'NetRide Elite', 'Premium luxury sedan rides'),
      ('PRESTIGE', 'NetRide Prestige', 'Large luxury SUV rides'),
    ];

    // Only show modes up to the vehicle's classification
    final classOrder = ['CORE', 'ELITE', 'PRESTIGE'];
    final maxIdx = classOrder.indexOf(provider.vehicleClass);
    final availableModes = allModes.take(maxIdx + 1).toList();

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
      ),
      child: Column(
        children: [
          for (final mode in availableModes) ...[
            if (mode != availableModes.first)
              Divider(height: 1, color: const Color(0xFFD8D2CA).withOpacity(0.5)),
            InkWell(
              onTap: () async {
                final newClass = mode.$1 == 'CORE'
                    ? models.VehicleClass.CORE
                    : mode.$1 == 'ELITE'
                        ? models.VehicleClass.ELITE
                        : models.VehicleClass.PRESTIGE;
                try {
                  await provider.updateOperatingClass(newClass);
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text('Switched to ${mode.$2}'),
                        backgroundColor: const Color(0xFF5B7760),
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  }
                } catch (e) {
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(e.toString().replaceAll('Exception: ', '')),
                        backgroundColor: Colors.red,
                        behavior: SnackBarBehavior.floating,
                      ),
                    );
                  }
                }
              },
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            mode.$2,
                            style: GoogleFonts.inter(
                              color: const Color(0xFF2F3A32),
                              fontSize: 16,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            mode.$3,
                            style: GoogleFonts.inter(color: Colors.grey[600], fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                    if (provider.activeClass.toString().split('.').last == mode.$1)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: const Color(0xFF5B7760).withOpacity(0.1),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Text(
                          'ACTIVE',
                          style: TextStyle(
                            color: Color(0xFF5B7760),
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildToggle(String type) {
    final value = _localPrefs[type] ?? false;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD8D2CA)),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 10)],
      ),
      child: SwitchListTile(
        contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 6),
        title: Text(
          _rideTypeLabels[type] ?? type,
          style: GoogleFonts.inter(
            color: const Color(0xFF2F3A32),
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
        subtitle: Text(
          _rideTypeSubtitles[type] ?? '',
          style: GoogleFonts.inter(color: Colors.grey[600], fontSize: 13),
        ),
        value: value,
        activeColor: const Color(0xFF5B7760),
        onChanged: (v) => setState(() => _localPrefs[type] = v),
      ),
    );
  }
}
