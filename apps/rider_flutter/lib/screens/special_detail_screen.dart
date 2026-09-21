// lib/screens/special_detail_screen.dart
//
// Sponsor detail + "Ride there" — the rider picks a business here, which
// creates the CREATED redemption (step 1 of the lifecycle, spec §27) and
// then drops them straight into the normal ride-booking flow on the map
// (route + ride options + confirm), with the deal attached and promo codes
// disabled. A live map shows the sponsor's registered location.

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import '../components/state_container.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';
import '../services/ride_intent.dart';
import '../services/specials_service.dart';

class SpecialDetailScreen extends StatefulWidget {
  const SpecialDetailScreen({super.key, required this.sponsorId});

  final String sponsorId;

  @override
  State<SpecialDetailScreen> createState() => _SpecialDetailScreenState();
}

class _SpecialDetailScreenState extends State<SpecialDetailScreen> {
  ViewState _state = ViewState.loading;
  SponsorSpecial? _sponsor;
  bool _picking = false;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch() async {
    setState(() {
      _state = ViewState.loading;
    });
    try {
      final sponsor = await SpecialsService.getOne(widget.sponsorId);
      if (!mounted) return;
      setState(() {
        _sponsor = sponsor;
        _state = ViewState.success;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _state = ViewState.failure;
      });
    }
  }

  /// Book a ride to this special: create the redemption (step 1), then hand
  /// the destination to the map screen which runs the normal ride flow.
  Future<void> _rideThere() async {
    final s = _sponsor;
    if (_picking || s == null || s.latitude == null || s.longitude == null) {
      return;
    }
    setState(() => _picking = true);
    final specials = context.read<SpecialsProvider>();
    try {
      await specials.pickSponsor(widget.sponsorId);
      if (!mounted) return;
      RideIntent.instance.startSpecialRide(
        SpecialRideIntent(
          lat: s.latitude!,
          lng: s.longitude!,
          address: s.address ?? s.businessName,
          sponsorName: s.businessName,
          discountLabel: s.discount.label.isEmpty
              ? 'Save on your ride'
              : s.discount.label,
        ),
      );
      // Back to MainWrapper — the map screen consumes the intent and opens
      // the ride panel with the route to the sponsor.
      Navigator.of(context).popUntil((route) => route.isFirst);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(specials.error ?? 'Please try again.')),
      );
      setState(() => _picking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F4EF),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: StateContainer(
        state: _state,
        errorMessage: 'Could not load this special.',
        onRetry: _fetch,
        successWidget: _sponsor == null ? const SizedBox.shrink() : _content(),
      ),
    );
  }

  Widget _content() {
    final s = _sponsor!;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Hero(
            tag: 'sponsor_${s.id}',
            child: Container(
              height: 140,
              width: double.infinity,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF5B7760), Color(0xFF2F3A32)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(22),
              ),
              child: Center(
                child: Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(
                    color: Colors.white.withOpacity(0.16),
                    borderRadius: BorderRadius.circular(18),
                  ),
                  child: Icon(
                    Icons.storefront_rounded,
                    color: Colors.white,
                    size: 32,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 18),
          Text(
            s.businessName,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w800,
              color: Color(0xFF2F3A32),
            ),
          ),
          if (s.businessType != null) ...[
            const SizedBox(height: 4),
            Text(
              s.businessType!.replaceAll('_', ' ').toLowerCase(),
              style: TextStyle(
                fontSize: 13,
                letterSpacing: 0.4,
                color: const Color(0xFF2F3A32).withOpacity(0.55),
              ),
            ),
          ],
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: const Color(0xFFE3DDD4)),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: const Color(0xFF5B7760).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(30),
                  ),
                  child: Text(
                    s.discount.label.isEmpty
                        ? 'Save on your ride'
                        : s.discount.label,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF5B7760),
                    ),
                  ),
                ),
                const Spacer(),
                const Icon(
                  Icons.verified_rounded,
                  color: Color(0xFF5B7760),
                  size: 20,
                ),
                const SizedBox(width: 4),
                Text(
                  'SPECIAL',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.8,
                    color: const Color(0xFF5B7760),
                  ),
                ),
              ],
            ),
          ),
          if (s.businessDescription?.isNotEmpty ?? false) ...[
            const SizedBox(height: 16),
            Text(
              'About',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: const Color(0xFF2F3A32),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              s.businessDescription!,
              style: TextStyle(
                fontSize: 14,
                height: 1.45,
                color: const Color(0xFF2F3A32).withOpacity(0.75),
              ),
            ),
          ],
          if (s.address?.isNotEmpty ?? false) ...[
            const SizedBox(height: 16),
            Row(
              children: [
                Icon(
                  Icons.location_on_rounded,
                  size: 18,
                  color: const Color(0xFF2F3A32).withOpacity(0.6),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    s.address!,
                    style: TextStyle(
                      fontSize: 13,
                      color: const Color(0xFF2F3A32).withOpacity(0.75),
                    ),
                  ),
                ),
              ],
            ),
          ],
          if (s.latitude != null && s.longitude != null) ...[
            const SizedBox(height: 16),
            // Live location map — drag and pinch to explore; the pin marks
            // the exact spot the admin registered for this special.
            ClipRRect(
              borderRadius: BorderRadius.circular(18),
              child: SizedBox(
                height: 200,
                child: FlutterMap(
                  options: MapOptions(
                    initialCenter: LatLng(s.latitude!, s.longitude!),
                    initialZoom: 15,
                    minZoom: 10,
                    maxZoom: 18,
                    interactionOptions: const InteractionOptions(
                      flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                    ),
                  ),
                  children: [
                    TileLayer(
                      urlTemplate:
                          'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                      subdomains: const ['a', 'b', 'c', 'd'],
                      userAgentPackageName: 'com.NetRide.rider',
                    ),
                    MarkerLayer(
                      markers: [
                        Marker(
                          point: LatLng(s.latitude!, s.longitude!),
                          width: 36,
                          height: 36,
                          child: Icon(
                            Icons.location_on_rounded,
                            size: 36,
                            color: const Color(0xFF5B7760),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 54,
            child: FilledButton.icon(
              onPressed: _picking ? null : _rideThere,
              style: FilledButton.styleFrom(
                backgroundColor: const Color(0xFF5B7760),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(30),
                ),
              ),
              icon: _picking
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Icon(Icons.directions_car_filled_rounded),
              label: Text(
                _picking
                    ? 'Getting your ride ready…'
                    : 'Book a ride to this place',
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'Your ${s.discount.label.isEmpty ? 'special deal' : s.discount.label} '
            'is attached to this ride — no promo code needed.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12,
              color: const Color(0xFF2F3A32).withOpacity(0.55),
            ),
          ),
        ],
      ),
    );
  }
}
