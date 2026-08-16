// lib/providers/specials_provider.dart
//
// Rider-side SPECIALS state: discovery list + count badge, the intro gate,
// and the rider's resumable redemption. Subscribes to the RideProvider's
// socket relay so live transitions (code issued → sponsor validated →
// reward processed) re-render the card without polling.

import 'dart:async';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '../models/special_models.dart';
import '../services/specials_service.dart';
import 'ride_provider.dart';

class SpecialsProvider extends ChangeNotifier {
  SpecialsProvider({RideProvider? ride}) {
    _ride = ride;
    _ride?.specialRedemptionUpdates.listen((update) {
      refresh();
    });
    _ride?.notificationPing.listen((_) => refresh());
  }

  RideProvider? _ride;

  List<SponsorSpecial> _sponsors = [];
  List<SponsorSpecial> get sponsors => _sponsors;

  int _count = 0;
  int get count => _count;

  bool _loaded = false;
  bool get loaded => _loaded;

  bool _loading = false;
  bool get loading => _loading;

  String? _error;
  String? get error => _error;

  bool _introSeen = false;
  bool get introSeen => _introSeen;

  bool _introChecked = false;

  SpecialRedemption? _current;
  SpecialRedemption? get current => _current;

  bool _busy = false;
  bool get busy => _busy;

  /// Snapshot of the code delivered by the last push (`special_reward_ready`).
  /// The raw code is never persisted anywhere client-side (spec §99).
  String? _lastCode;
  String? get lastCode => _lastCode;
  void stashCode(String? code) {
    _lastCode = code;
  }

  /// Last known rider position (km-ordered discovery). Once set, EVERY
  /// refresh keeps using it so the Explore SPECIALS section and the map
  /// sponsor markers always read the same eligible list (same query, same
  /// ordering — no drift between the two surfaces).
  double? _geoLat;
  double? _geoLng;

  /// Full refresh: count + discovery + intro state + resumable redemption.
  /// When [lat]/[lng] are provided they become the persistent geo origin.
  Future<void> refresh({double? lat, double? lng}) async {
    if (lat != null && lng != null) {
      _geoLat = lat;
      _geoLng = lng;
    }
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final results = await Future.wait([
        SpecialsService.list(lat: _geoLat, lng: _geoLng),
        SpecialsService.count(),
        _introChecked
            ? Future.value(_introSeen)
            : SpecialsService.introSeen(),
        SpecialsService.currentRedemption(),
      ]);
      _sponsors = results[0] as List<SponsorSpecial>;
      _count = results[1] as int;
      if (!_introChecked) {
        _introSeen = results[2] as bool;
        _introChecked = true;
      }
      _current = results[3] as SpecialRedemption?;
      _loaded = true;
    } catch (e) {
      _error = '$e';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// Lightweight count-only refresh (tab badge). Never shows a spinner.
  Future<void> refreshCount() async {
    try {
      _count = await SpecialsService.count();
      notifyListeners();
    } catch (_) {}
  }

  Future<void> acknowledgeIntro() async {
    try {
      await SpecialsService.markIntroSeen();
      _introSeen = true;
      notifyListeners();
    } catch (_) {}
  }

  /// Step 1 — pick a sponsor. Throws the backend's error string on failure.
  Future<SpecialRedemption> pickSponsor(String sponsorId) async {
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final redemption = await SpecialsService.createRedemption(sponsorId);
      _current = redemption;
      await refreshCount();
      return redemption;
    } catch (e) {
      _error = friendlyFrom(e);
      rethrow;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Step 4 — rider was verified at the business.
  Future<void> markVerified() async {
    final r = _current;
    if (r == null) return;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      _current = await SpecialsService.markVerified(r.id);
    } catch (e) {
      _error = friendlyFrom(e);
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Step 5 — reward choice (REFUND | CREDITS), server-confirmed.
  Future<SpecialRedemption?> chooseReward(String choice) async {
    final r = _current;
    if (r == null) return null;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      final redemption = await SpecialsService.chooseReward(
        r.id,
        choice,
        confirmed: true,
      );
      _current = redemption;
      return redemption;
    } catch (e) {
      _error = friendlyFrom(e);
      return null;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Called once on app start / login to resync the resumable redemption.
  Future<void> loadCurrent() async {
    try {
      _current = await SpecialsService.currentRedemption();
      notifyListeners();
    } catch (_) {}
  }

  /// True while the rider may attach this redemption to a new ride.
  bool get canAttachToRide {
    final r = _current;
    return r != null && r.status == 'CREATED';
  }

  String friendlyFrom(Object e) {
    if (e is DioException) return SpecialsService.friendlyError(e);
    return 'Something went wrong. Please try again.';
  }
}
