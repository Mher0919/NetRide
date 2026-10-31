import 'dart:async';
import 'dart:math' as math;
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:provider/provider.dart';
import '../models/group_models.dart';
import '../models/search_result.dart';
import '../providers/group_provider.dart';
import '../services/group_service.dart';
import '../services/payments_service.dart';
import '../services/rewards_service.dart';
import '../theme/app_theme.dart';
import '../widgets/branded_map_tile.dart';
import '../widgets/vehicle_selection_card.dart';
import 'address_search_delegate.dart';
import 'wallet_screen.dart';

class GroupRideScreen extends StatefulWidget {
  const GroupRideScreen({super.key});

  @override
  State<GroupRideScreen> createState() => _GroupRideScreenState();
}

class _GroupRideScreenState extends State<GroupRideScreen> {
  final MapController _map = MapController();
  final TextEditingController _promo = TextEditingController();
  final Map<String, TextEditingController> _customControllers = {};
  final ScrollController _scroll = ScrollController();
  Timer? _fitTimer;

  String _selectedSplit = 'HOST_PAYS';
  Map<String, int>? _customShares;
  bool _loadingPreview = false;
  bool _previewTried = false;
  bool _useCredits = false;
  int? _creditBalanceCents;
  String? _paymentMethodLabel;
  bool _busy = false;
  String? _notice;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  @override
  void dispose() {
    _fitTimer?.cancel();
    _promo.dispose();
    _scroll.dispose();
    for (final c in _customControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final provider = context.read<GroupProvider>();
    await provider.refreshCurrent(silent: false);
    final group = provider.current;
    if (group == null || !mounted) return;
    _selectedSplit = group.splitMethod;
    _promo.text = group.quote?.promoCode ?? '';
    await _loadWallet();
    if (!mounted) return;
    final hostCanEstimate = group.isHost &&
        group.canConfigure &&
        !group.hasActiveRide &&
        group.hasDestination &&
        group.allPickupsSet &&
        group.quote == null;
    if (hostCanEstimate && !_previewTried) {
      _previewTried = true;
      await _loadPreview();
    }
  }

  Future<void> _loadWallet() async {
    try {
      final credits = await RewardsService.getCredits();
      if (mounted) setState(() => _creditBalanceCents = credits.balanceCents);
    } catch (_) {
      if (mounted) setState(() => _creditBalanceCents = 0);
    }
    try {
      final methods = await PaymentsService.listMethods();
      SavedPaymentMethod? def;
      for (final m in methods) {
        if (m.isDefault) {
          def = m;
          break;
        }
      }
      if (mounted) setState(() => _paymentMethodLabel = def?.label);
    } catch (_) {
      if (mounted) setState(() => _paymentMethodLabel = null);
    }
  }

  Future<void> _loadPreview() async {
    if (_loadingPreview) return;
    setState(() {
      _loadingPreview = true;
      _notice = null;
    });
    final provider = context.read<GroupProvider>();
    final preview = await provider.loadQuotePreview(
      promoCode: _promo.text.trim().isEmpty ? null : _promo.text.trim(),
    );
    if (!mounted) return;
    setState(() {
      _loadingPreview = false;
      if (preview == null) {
        _notice = 'We could not calculate the route. Check the pickups and destination.';
      } else if (preview['promoReason'] != null) {
        _notice = preview['promoReason'].toString();
      }
    });
    _scheduleFit();
  }

  Future<void> _pickDestination(GroupDetail group) async {
    if (!group.isHost || !group.canConfigure || group.hasActiveRide) return;
    final result = await showSearch<SearchResult?>(
      context: context,
      delegate: AddressSearchDelegate(searchFieldLabel: 'Shared destination'),
    );
    if (result == null || !mounted) return;
    await _mutate(() async {
      await context.read<GroupProvider>().setDestination(
            lat: result.lat,
            lng: result.lon,
            address: result.formattedAddress ?? result.displayName,
          );
    });
    if (!mounted) return;
    await _loadPreview();
  }

  Future<void> _pickMyPickup(GroupDetail group) async {
    if (!group.canConfigure || group.hasActiveRide) return;
    final host = group.host;
    final choice = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: Colors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 10),
            ListTile(
              leading: const Icon(Icons.home_outlined, color: AppTheme.primaryBrandGreen),
              title: Text(
                host != null ? 'Same pickup as ${host.fullName.split(' ').first}' : 'Same as host',
              ),
              enabled: host?.pickup != null,
              onTap: host?.pickup != null ? () => Navigator.pop(ctx, 'host') : null,
            ),
            ListTile(
              leading: const Icon(Icons.place_outlined, color: AppTheme.primaryBrandGreen),
              title: const Text('Choose a different pickup'),
              onTap: () => Navigator.pop(ctx, 'different'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (choice == null || !mounted) return;
    if (choice == 'host') {
      await _mutate(() => context.read<GroupProvider>().setPickup(sameAsHost: true));
      if (mounted) await _loadPreview();
      return;
    }
    final result = await showSearch<SearchResult?>(
      context: context,
      delegate: AddressSearchDelegate(searchFieldLabel: 'Your pickup'),
    );
    if (result == null || !mounted) return;
    await _mutate(() => context.read<GroupProvider>().setPickup(
          lat: result.lat,
          lng: result.lon,
          address: result.formattedAddress ?? result.displayName,
        ));
    if (mounted) await _loadPreview();
  }

  Future<void> _mutate(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await action();
    } on DioException catch (e) {
      if (mounted) setState(() => _notice = GroupService.friendly(e));
    } catch (e) {
      if (mounted) setState(() => _notice = 'Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (mounted) {
      final group = context.read<GroupProvider>().current;
      if (group != null) {
        _selectedSplit = group.splitMethod;
      }
    }
  }

  Future<bool> _confirmRequote(GroupDetail group) async {
    final hasPaid = group.payments.any((p) => p.isPaid && p.amountCents > 0);
    if (!hasPaid) return true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Update the group fare?'),
        content: const Text(
          'This creates a new fare version. Participants whose share changes '
          'will be refunded and must confirm the new amount before the ride can be requested.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Update fare'),
          ),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _applyQuote(GroupDetail group) async {
    if (!group.isHost || !group.canConfigure || group.hasActiveRide) return;
    if (_loadingPreview) return;
    if (!await _confirmRequote(group) || !mounted) return;

    final provider = context.read<GroupProvider>();
    final preview = provider.quotePreview;
    final total = (provider.current?.quote?.discountedTotalCents ??
            (preview?['discountedTotalCents'] as num?)?.toInt() ??
            0)
        .toInt();
    if (_selectedSplit == 'CUSTOM') {
      final values = await _askCustomShares(provider.current ?? group, total);
      if (values == null || !mounted) return;
      _customShares = values;
    } else {
      _customShares = null;
    }
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await provider.createQuote(
        splitMethod: _selectedSplit,
        promoCode: _promo.text.trim().isEmpty ? null : _promo.text.trim(),
        customShares: _customShares,
      );
      if (mounted) {
        setState(() {
          _notice = 'Fare updated. Every participant must confirm their new share.';
          _useCredits = false;
        });
      }
    } on DioException catch (e) {
      if (mounted) setState(() => _notice = GroupService.friendly(e));
    } catch (e) {
      if (mounted) setState(() => _notice = 'We could not update the fare. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    if (mounted) _scheduleFit();
  }

  Future<Map<String, int>?> _askCustomShares(
    GroupDetail group,
    int totalCents,
  ) async {
    if (totalCents <= 0) {
      setState(() => _notice = 'Calculate the fare first, then choose a custom split.');
      return null;
    }
    final participants = group.participants;
    final existing = <String, int>{};
    final quote = group.quote;
    if (quote != null) {
      for (final s in quote.shares) {
        existing[s.userId] = s.amountCents;
      }
    }
    if (_customShares != null) {
      existing
        ..clear()
        ..addAll(_customShares!);
    }
    final base = totalCents ~/ participants.length;
    var remainder = totalCents - base * participants.length;
    final controllers = <String, TextEditingController>{};
    for (final p in participants) {
      final amount = existing[p.userId] ??
          (base + (remainder-- > 0 ? 1 : 0));
      controllers[p.userId] = TextEditingController(
        text: (amount / 100).toStringAsFixed(2),
      );
    }
    final result = await showDialog<Map<String, int>>(
      context: context,
      builder: (ctx) {
        String? error;
        return StatefulBuilder(
          builder: (ctx, setDialogState) => AlertDialog(
            title: const Text('Custom split'),
            content: SizedBox(
              width: 340,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Allocate exactly \$${(totalCents / 100).toStringAsFixed(2)} in total.',
                      style: const TextStyle(fontSize: 12.5),
                    ),
                    const SizedBox(height: 10),
                    ...participants.map(
                      (p) => Padding(
                        padding: const EdgeInsets.symmetric(vertical: 5),
                        child: Row(
                          children: [
                            Expanded(child: Text(p.fullName)),
                            SizedBox(
                              width: 110,
                              child: TextField(
                                controller: controllers[p.userId],
                                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                                decoration: const InputDecoration(
                                  prefixText: '\$ ',
                                  isDense: true,
                                  contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (error != null) ...[
                      const SizedBox(height: 8),
                      Text(
                        error!,
                        style: const TextStyle(color: AppTheme.errorColor, fontSize: 12),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              ElevatedButton(
                onPressed: () {
                  var sum = 0;
                  final out = <String, int>{};
                  for (final p in participants) {
                    final raw = controllers[p.userId]?.text.trim() ?? '';
                    final dollars = double.tryParse(raw);
                    if (dollars == null || dollars < 0) {
                      setDialogState(() => error = 'Enter a valid amount for ${p.fullName}.');
                      return;
                    }
                    final cents = (dollars * 100).round();
                    out[p.userId] = cents;
                    sum += cents;
                  }
                  if (sum != totalCents) {
                    setDialogState(() => error =
                        'Shares must add up to \$${(totalCents / 100).toStringAsFixed(2)}.');
                    return;
                  }
                  Navigator.pop(ctx, out);
                },
                child: const Text('Apply'),
              ),
            ],
          ),
        );
      },
    );
    for (final c in controllers.values) {
      c.dispose();
    }
    return result;
  }

  Future<void> _addCardAndReturn() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const WalletScreen()),
    );
    if (!mounted) return;
    await _loadWallet();
    await context.read<GroupProvider>().refreshCurrent(silent: true);
    if (mounted) setState(() {});
  }

  Future<void> _confirmPayment(GroupDetail group) async {
    if (_busy) return;
    final share = group.myShare;
    final amount = (share?['amountCents'] as num?)?.toInt() ?? 0;
    if (amount <= 0) return;
    if (_paymentMethodLabel == null && !_useCredits) {
      final credits = _creditBalanceCents ?? 0;
      if (credits < amount) {
        final add = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Add a payment card'),
            content: const Text(
              'Your share still has a balance after ride credits. Add a card in the secure Stripe sheet to confirm your payment.',
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
              ElevatedButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Add card'),
              ),
            ],
          ),
        );
        if (add == true) await _addCardAndReturn();
        return;
      }
    }
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      final detail = await context
          .read<GroupProvider>()
          .confirmPayment(useCredits: _useCredits);
      if (!mounted) return;
      setState(() {
        _useCredits = false;
        _notice = detail.myPayment?.isPaid == true
            ? 'Your share is confirmed.'
            : 'Your payment is still pending. Check your payment method.';
      });
      await _loadWallet();
    } on DioException catch (e) {
      if (mounted) {
        setState(() => _notice =
            GroupService.friendly(e, fallback: 'Your payment could not be completed.'));
      }
    } catch (e) {
      if (mounted) setState(() => _notice = 'Your payment could not be completed.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestRide(GroupDetail group) async {
    if (!group.canRequest || _busy) return;
    setState(() {
      _busy = true;
      _notice = null;
    });
    try {
      await context.read<GroupProvider>().requestRide();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Ride requested'),
          content: const Text('Your group ride is now looking for a driver.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Done'),
            ),
          ],
        ),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (e) {
      if (mounted) setState(() => _notice = GroupService.friendly(e));
    } catch (e) {
      if (mounted) setState(() => _notice = 'We could not request the ride. Please try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  List<LatLng> _routePoints(GroupDetail group, Map<String, dynamic>? preview) {
    final geometry = group.ride?.routePlan?.geometry ??
        group.routePlan?.geometry ??
        (preview?['route'] is Map ? preview!['route']['geometry'] : null);
    final coords = geometry is Map ? geometry['coordinates'] as List? : null;
    if (coords == null) return [];
    final out = <LatLng>[];
    for (final c in coords) {
      if (c is List && c.length >= 2 && c[0] is num && c[1] is num) {
        out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
      }
    }
    return out;
  }

  List<GroupRouteStop> _stops(GroupDetail group, Map<String, dynamic>? preview) {
    if (group.ride?.routePlan?.stops.isNotEmpty == true) {
      return group.ride!.routePlan!.stops;
    }
    if (group.routePlan?.stops.isNotEmpty == true) return group.routePlan!.stops;
    final raw = preview?['route'] is Map ? preview!['route']['stops'] : null;
    if (raw is List) {
      return raw
          .whereType<Map>()
          .map((e) => GroupRouteStop.fromJson(Map<String, dynamic>.from(e)))
          .toList();
    }
    return [];
  }

  void _scheduleFit() {
    _fitTimer?.cancel();
    _fitTimer = Timer(const Duration(milliseconds: 250), () {
      if (!mounted) return;
      final group = context.read<GroupProvider>().current;
      if (group == null) return;
      final preview = context.read<GroupProvider>().quotePreview;
      final points = <LatLng>[
        ..._routePoints(group, preview),
        ..._stops(group, preview)
            .map((s) => LatLng(s.lat, s.lng)),
        if (group.destination != null)
          LatLng(group.destination!.lat, group.destination!.lng),
      ];
      if (points.length < 2) return;
      try {
        _map.fitCamera(CameraFit.bounds(
          bounds: LatLngBounds.fromPoints(points),
          padding: const EdgeInsets.all(48),
        ));
      } catch (_) {}
    });
  }

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<GroupProvider>();
    final group = provider.current;
    if (group == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator(color: AppTheme.primaryBrandGreen)),
      );
    }
    final preview = provider.quotePreview;
    final quote = group.quote;
    final originalCents =
        quote?.originalFareCents ?? (preview?['originalFareCents'] as num?)?.toInt() ?? 0;
    final promoDiscountCents =
        quote?.promoDiscountCents ?? (preview?['promoDiscountCents'] as num?)?.toInt() ?? 0;
    final totalCents =
        quote?.discountedTotalCents ?? (preview?['discountedTotalCents'] as num?)?.toInt() ?? 0;
    final etaMinutes = ((group.routePlan?.totalDurationSeconds ??
                (preview?['route'] is Map
                    ? (preview!['route']['totalDurationSeconds'] as num?)?.toInt() ?? 0
                    : 0)) /
            60)
        .round()
        .clamp(1, 999);
    final stops = _stops(group, preview);
    final host = group.isHost;
    final editable = host && group.canConfigure && !group.hasActiveRide;
    final myShare = group.myShare;
    final myAmount = (myShare?['amountCents'] as num?)?.toInt() ?? 0;
    final myPayment = group.myPayment;
    final myPaid = myPayment?.isPaid == true;

    return Scaffold(
      backgroundColor: AppTheme.primaryBackground,
      appBar: AppBar(
        backgroundColor: AppTheme.primaryBackground,
        elevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Ride setup', style: TextStyle(fontWeight: FontWeight.w800)),
            Text(
              group.name,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _busy
                ? null
                : () async {
                    await provider.refreshCurrent();
                    await _loadWallet();
                    if (mounted) _scheduleFit();
                  },
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: RefreshIndicator(
        color: AppTheme.primaryBrandGreen,
        onRefresh: () async {
          await provider.refreshCurrent();
          await _loadWallet();
          if (mounted) _scheduleFit();
        },
        child: ListView(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            if (_notice != null)
              Container(
                margin: const EdgeInsets.only(bottom: 10),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppTheme.softBorderColor),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline_rounded,
                        size: 17, color: AppTheme.primaryBrandGreen),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_notice!, style: const TextStyle(fontSize: 12.5))),
                    IconButton(
                      onPressed: () => setState(() => _notice = null),
                      icon: const Icon(Icons.close, size: 16),
                      visualDensity: VisualDensity.compact,
                    ),
                  ],
                ),
              ),
            _buildMap(group, preview, stops),
            const SizedBox(height: 12),
            _buildRouteCard(group, stops, editable),
            const SizedBox(height: 12),
            _buildPickupCard(group, editable),
            const SizedBox(height: 12),
            if (host) _buildDestinationCard(group, editable),
            if (host) const SizedBox(height: 12),
            if (host && (quote != null || preview != null))
              VehicleSelectionCard(
                fareCents: originalCents,
                finalCents: totalCents,
                savedCents: promoDiscountCents,
                etaMinutes: etaMinutes,
                showBreakdown: true,
                promoLabel: quote?.promoCode ?? _promo.text.trim().toUpperCase(),
                promoDiscountCents: promoDiscountCents,
                footer: _buildSplitSelector(group),
              )
            else if (!host && quote != null)
              VehicleSelectionCard(
                fareCents: originalCents,
                finalCents: totalCents,
                savedCents: promoDiscountCents,
                etaMinutes: etaMinutes,
                showBreakdown: true,
                promoDiscountCents: promoDiscountCents,
                readOnly: true,
              )
            else
              _buildVehiclePlaceholder(group),
            if (host) const SizedBox(height: 12),
            if (host) _buildPromoAndQuoteActions(group, preview, quote),
            if (host) const SizedBox(height: 12),
            if (quote != null) _buildPaymentSection(group, myAmount, myPaid, myPayment),
            if (quote != null) const SizedBox(height: 12),
            if (quote != null) _buildPaymentDashboard(group),
            if (group.ride != null) ...[
              const SizedBox(height: 12),
              _buildRideStatus(group),
            ],
            if (host) ...[
              const SizedBox(height: 16),
              SizedBox(
                height: 54,
                child: ElevatedButton(
                  onPressed: group.canRequest && !_busy
                      ? () => _requestRide(group)
                      : null,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: group.canRequest
                        ? const Color(0xFF4CAF50)
                        : const Color(0xFF9AA39B),
                    foregroundColor: Colors.white,
                    disabledBackgroundColor: const Color(0xFFC9CFC9),
                    disabledForegroundColor: Colors.white70,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                  ),
                  child: Text(
                    group.canRequest
                        ? 'Request group ride'
                        : group.hasActiveRide
                            ? 'Ride requested'
                            : quote == null
                                ? 'Update fare & split first'
                                : 'Waiting for participant payments',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.3,
                    ),
                  ),
                ),
              ),
              if (!group.canRequest && quote != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'The button activates automatically after every required share is verified by the server.',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                    ),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildMap(GroupDetail group, Map<String, dynamic>? preview, List<GroupRouteStop> stops) {
    final points = _routePoints(group, preview);
    final driver = context.watch<GroupProvider>().driverLocation ?? group.ride?.driverLocation;
    final center = points.isNotEmpty
        ? points.first
        : (stops.isNotEmpty
            ? LatLng(stops.first.lat, stops.first.lng)
            : (group.destination != null
                ? LatLng(group.destination!.lat, group.destination!.lng)
                : const LatLng(34.0522, -118.2437)));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && points.length >= 2) _scheduleFit();
    });
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: Container(
        height: 220,
        decoration: BoxDecoration(
          border: Border.all(color: AppTheme.softBorderColor),
          borderRadius: BorderRadius.circular(20),
        ),
        child: Stack(
          children: [
            FlutterMap(
              mapController: _map,
              options: MapOptions(
                initialCenter: center,
                initialZoom: 12.5,
                minZoom: 6,
                maxZoom: 18,
              ),
              children: [
                TileLayer(
                  urlTemplate:
                      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                  maxNativeZoom: 16,
                  userAgentPackageName: 'com.NetRide.rider',
                  tileBuilder: brandedMapTile,
                ),
                if (points.length >= 2)
                  PolylineLayer(
                    polylines: [
                      Polyline(
                        points: points,
                        strokeWidth: 4,
                        color: AppTheme.primaryBrandGreen,
                      ),
                    ],
                  ),
                MarkerLayer(
                  markers: [
                    for (final stop in stops)
                      Marker(
                        point: LatLng(stop.lat, stop.lng),
                        width: 30,
                        height: 30,
                        child: _StopMarker(sequence: stop.sequence, completed: stop.completed),
                      ),
                    if (group.destination != null)
                      Marker(
                        point: LatLng(group.destination!.lat, group.destination!.lng),
                        width: 34,
                        height: 34,
                        child: const _DestinationMarker(),
                      ),
                    if (driver != null)
                      Marker(
                        point: LatLng(driver.lat, driver.lng),
                        width: 34,
                        height: 34,
                        child: const _DriverMarker(),
                      ),
                  ],
                ),
              ],
            ),
            if (points.isEmpty && stops.isEmpty)
              Positioned.fill(
                child: Container(
                  color: Colors.white.withValues(alpha: 0.55),
                  alignment: Alignment.center,
                  child: const Text(
                    'Set a destination and pickups to preview the optimized route',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
            Positioned(
              left: 12,
              bottom: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.94),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppTheme.softBorderColor),
                ),
                child: Text(
                  stops.isEmpty
                      ? 'Optimized multi-stop route'
                      : '${stops.length} pickup ${stops.length == 1 ? 'stop' : 'stops'} · optimized globally',
                  style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRouteCard(GroupDetail group, List<GroupRouteStop> stops, bool editable) {
    final distance = group.ride?.routePlan?.totalDistanceMeters ??
        group.ride?.distanceMeters ??
        group.routePlan?.totalDistanceMeters ??
        (context.read<GroupProvider>().quotePreview?['route'] is Map
            ? ((context.read<GroupProvider>().quotePreview!['route']['totalDistanceMeters'] as num?)?.toInt() ?? 0)
            : 0);
    final duration = group.ride?.routePlan?.totalDurationSeconds ??
        group.ride?.durationSeconds ??
        group.routePlan?.totalDurationSeconds ??
        (context.read<GroupProvider>().quotePreview?['route'] is Map
            ? ((context.read<GroupProvider>().quotePreview!['route']['totalDurationSeconds'] as num?)?.toInt() ?? 0)
            : 0);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'OPTIMIZED ROUTE',
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.9,
              color: Color(0xFF7C847D),
            ),
          ),
          const SizedBox(height: 8),
          if (stops.isEmpty)
            Text(
              'The route is built after the destination and every pickup are set.',
              style: TextStyle(
                fontSize: 12.5,
                color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
              ),
            )
          else ...[
            for (final stop in stops)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _StopMarker(sequence: stop.sequence, small: true, completed: stop.completed),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            stop.address.isEmpty ? 'Pickup ${stop.sequence}' : stop.address,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                              height: 1.3,
                            ),
                          ),
                          Text(
                            stop.passengers.map((p) => p['name']).whereType<String>().join(', '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 11,
                              color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            if (group.destination != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const _DestinationMarker(small: true),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        group.destination!.address ?? 'Shared destination',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (distance > 0 || duration > 0) ...[
            const SizedBox(height: 8),
            const Divider(height: 1),
            const SizedBox(height: 8),
            Row(
              children: [
                const Icon(Icons.straighten_rounded, size: 14, color: AppTheme.primaryBrandGreen),
                const SizedBox(width: 4),
                Text('${(distance / 1609.344).toStringAsFixed(1)} mi',
                    style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
                const SizedBox(width: 14),
                const Icon(Icons.schedule_rounded, size: 14, color: AppTheme.primaryBrandGreen),
                const SizedBox(width: 4),
                Text('${(duration / 60).round()} min',
                    style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildPickupCard(GroupDetail group, bool editable) {
    final me = group.me;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Row(
        children: [
          const Icon(Icons.my_location_rounded, color: AppTheme.primaryBrandGreen),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Your pickup',
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: Color(0xFF7C847D)),
                ),
                const SizedBox(height: 2),
                Text(
                  me?.pickup?.address ??
                      (me?.pickupSource == 'HOST' ? 'Same pickup as host' : 'Not set'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, height: 1.3),
                ),
              ],
            ),
          ),
          if (editable)
            TextButton(
              onPressed: () => _pickMyPickup(group),
              child: Text(me?.pickup == null ? 'Choose' : 'Change'),
            ),
        ],
      ),
    );
  }

  Widget _buildDestinationCard(GroupDetail group, bool editable) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Row(
        children: [
          const Icon(Icons.flag_rounded, color: AppTheme.primaryBrandGreen),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'SHARED DESTINATION',
                  style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: Color(0xFF7C847D)),
                ),
                const SizedBox(height: 2),
                Text(
                  group.destination?.address ?? 'Choose the destination',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                    color: group.destination == null
                        ? AppTheme.secondaryDarkText.withValues(alpha: 0.5)
                        : AppTheme.secondaryDarkText,
                  ),
                ),
              ],
            ),
          ),
          if (editable)
            TextButton(
              onPressed: () => _pickDestination(group),
              child: Text(group.destination == null ? 'Set' : 'Change'),
            ),
        ],
      ),
    );
  }

  Widget _buildSplitSelector(GroupDetail group) {
    final canEdit = group.isHost && group.canConfigure && !group.hasActiveRide;
    const options = [
      ('HOST_PAYS', 'Host pays', 'I cover the whole ride'),
      ('EQUAL', 'Split equally', 'Same amount for everyone'),
      ('DISTANCE', 'By distance', 'Based on each road segment'),
      ('CUSTOM', 'Custom', 'Set each amount'),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 4),
        const Text(
          'SPLIT BILL',
          style: TextStyle(
            fontSize: 10.5,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.9,
            color: Color(0xFF7C847D),
          ),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: options.map((o) {
            final selected = _selectedSplit == o.$1;
            return GestureDetector(
              onTap: canEdit ? () => setState(() => _selectedSplit = o.$1) : null,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(
                  color: selected
                      ? AppTheme.primaryBrandGreen
                      : Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: selected ? AppTheme.primaryBrandGreen : AppTheme.softBorderColor,
                  ),
                ),
                child: Text(
                  o.$2,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: selected ? Colors.white : AppTheme.secondaryDarkText,
                  ),
                ),
              ),
            );
          }).toList(),
        ),
        const SizedBox(height: 4),
        Text(
          options.firstWhere((o) => o.$1 == _selectedSplit).$3,
          style: TextStyle(
            fontSize: 11,
            color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
          ),
        ),
      ],
    );
  }

  Widget _buildPromoAndQuoteActions(
    GroupDetail group,
    Map<String, dynamic>? preview,
    GroupQuote? quote,
  ) {
    final canEdit = group.canConfigure && !group.hasActiveRide;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.local_offer_outlined, size: 18, color: AppTheme.primaryBrandGreen),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: _promo,
                  enabled: canEdit,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    hintText: 'Promo code (applied once to the group fare)',
                    isDense: true,
                    border: InputBorder.none,
                  ),
                  style: const TextStyle(fontSize: 13.5),
                ),
              ),
            ],
          ),
          if (quote?.promoDiscountCents != null && quote!.promoDiscountCents > 0)
            Text(
              '${quote.promoCode} applied: -\$${(quote.promoDiscountCents / 100).toStringAsFixed(2)}',
              style: const TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                color: AppTheme.successGreen,
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: canEdit && !_loadingPreview ? _loadPreview : null,
                  icon: _loadingPreview
                      ? const SizedBox(
                          width: 15,
                          height: 15,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.route_outlined, size: 17),
                  label: const Text('Estimate route'),
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 11),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: ElevatedButton.icon(
                  onPressed: canEdit && !_busy ? () => _applyQuote(group) : null,
                  icon: const Icon(Icons.payments_outlined, size: 17),
                  label: const Text('Update fare & split'),
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 11),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                ),
              ),
            ],
          ),
          if (group.quote != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Quote v${group.quote!.version} · expires ${group.quote!.expiresAt != null ? _formatTime(group.quote!.expiresAt!) : 'soon'}',
                style: TextStyle(
                  fontSize: 10.5,
                  color: AppTheme.secondaryDarkText.withValues(alpha: 0.5),
                ),
              ),
            ),
        ],
      ),
    );
  }

  String _formatTime(DateTime d) {
    final m = d.difference(DateTime.now()).inMinutes;
    if (m <= 0) return 'now';
    return 'in $m min';
  }

  Widget _buildVehiclePlaceholder(GroupDetail group) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760).withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppTheme.primaryBrandGreen, width: 2),
      ),
      child: Column(
        children: [
          Image.asset('assets/images/car-logo.png', width: 140, height: 80, fit: BoxFit.contain),
          const SizedBox(height: 8),
          const Text(
            'NetRide Premium',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          Text(
            group.isHost
                ? 'Set the destination and every pickup, then calculate the fare.'
                : 'The host is still configuring the ride.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12.5,
              color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPaymentSection(
    GroupDetail group,
    int myAmount,
    bool myPaid,
    GroupPayment? myPayment,
  ) {
    if (myAmount <= 0) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppTheme.softBorderColor),
        ),
        child: Row(
          children: [
            const Icon(Icons.check_circle_outline_rounded, color: AppTheme.successGreen),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                group.isHost
                    ? 'You are covering the whole ride. No participant payments are required.'
                    : 'The host is covering the ride. No payment is due from you.',
                style: const TextStyle(fontSize: 12.5, height: 1.35),
              ),
            ),
          ],
        ),
      );
    }

    final credits = _creditBalanceCents ?? 0;
    final cardAmount = _useCredits ? math.max(0, myAmount - credits) : myAmount;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: myPaid ? AppTheme.successGreen : AppTheme.softBorderColor,
          width: myPaid ? 1.4 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                'YOUR SHARE',
                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: Color(0xFF7C847D)),
              ),
              const Spacer(),
              Text(
                '\$${(myAmount / 100).toStringAsFixed(2)}',
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (myPaid)
            Row(
              children: [
                const Icon(Icons.verified_rounded, color: AppTheme.successGreen, size: 20),
                const SizedBox(width: 6),
                const Text(
                  'Payment confirmed',
                  style: TextStyle(fontWeight: FontWeight.w700, color: AppTheme.successGreen),
                ),
              ],
            )
          else ...[
            Row(
              children: [
                const Icon(Icons.credit_card_rounded, size: 17, color: AppTheme.primaryBrandGreen),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    _paymentMethodLabel ?? 'No payment method chosen',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: _paymentMethodLabel != null
                          ? AppTheme.secondaryDarkText
                          : AppTheme.errorColor,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _busy ? null : _addCardAndReturn,
                  child: const Text('Manage', style: TextStyle(fontSize: 12)),
                ),
              ],
            ),
            const Divider(height: 18),
            Row(
              children: [
                const Icon(Icons.account_balance_wallet_outlined,
                    size: 17, color: AppTheme.primaryBrandGreen),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Use Ride Credits', style: TextStyle(fontSize: 12.5)),
                      Text(
                        '\$${(credits / 100).toStringAsFixed(2)} available',
                        style: TextStyle(
                          fontSize: 11,
                          color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                        ),
                      ),
                    ],
                  ),
                ),
                Switch(
                  value: _useCredits,
                  activeTrackColor: AppTheme.primaryBrandGreen,
                  onChanged: credits > 0
                      ? (v) => setState(() => _useCredits = v)
                      : null,
                ),
              ],
            ),
            if (_useCredits)
              Text(
                cardAmount > 0
                    ? 'Card will cover \$${(cardAmount / 100).toStringAsFixed(2)}.'
                    : 'Your ride credits cover this share.',
                style: TextStyle(
                  fontSize: 11,
                  color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
                ),
              ),
            if (myPayment?.failureReason != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  myPayment!.failureReason!,
                  style: const TextStyle(fontSize: 11.5, color: AppTheme.errorColor),
                ),
              ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _busy ? null : () => _confirmPayment(group),
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppTheme.primaryBrandGreen,
                  padding: const EdgeInsets.symmetric(vertical: 13),
                ),
                child: _busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : const Text(
                        'Confirm my payment',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
              ),
            ),
            if (_paymentMethodLabel == null && cardAmount > 0)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  'Add a card in the secure Stripe sheet if your credits do not cover the share.',
                  style: TextStyle(
                    fontSize: 11,
                    color: AppTheme.secondaryDarkText.withValues(alpha: 0.55),
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _buildPaymentDashboard(GroupDetail group) {
    final byId = {for (final p in group.participants) p.userId: p};
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                'GROUP PAYMENTS',
                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: Color(0xFF7C847D)),
              ),
              const Spacer(),
              Text(
                '${group.paidCount}/${group.requiredCount} confirmed',
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w700),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ...group.payments.map((payment) {
            final participant = byId[payment.participantId];
            final name = participant?.fullName ?? 'Participant';
            final isMe = participant?.isMe == true;
            final paid = payment.isPaid;
            final color = paid
                ? AppTheme.successGreen
                : payment.status == 'FAILED'
                    ? AppTheme.errorColor
                    : AppTheme.warningColor;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 5),
              child: Row(
                children: [
                  Icon(
                    paid
                        ? Icons.check_circle_rounded
                        : payment.status == 'FAILED'
                            ? Icons.error_outline_rounded
                            : Icons.schedule_rounded,
                    size: 16,
                    color: color,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      isMe ? 'You' : name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                  ),
                  if (group.isHost)
                    Text(
                      '\$${(payment.amountCents / 100).toStringAsFixed(2)}',
                      style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                  const SizedBox(width: 8),
                  Text(
                    !payment.required
                        ? 'Not required'
                        : payment.status == 'SUCCEEDED'
                            ? 'Confirmed'
                            : payment.status == 'PROCESSING'
                                ? 'Processing'
                                : payment.status == 'FAILED'
                                    ? 'Failed'
                                    : 'Awaiting',
                    style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: color),
                  ),
                ],
              ),
            );
          }),
        ],
      ),
    );
  }

  Widget _buildRideStatus(GroupDetail group) {
    final ride = group.ride!;
    final driver = ride.driverName;
    final status = ride.status;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppTheme.softBorderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.local_taxi_rounded, color: AppTheme.primaryBrandGreen),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  status == 'COMPLETED'
                      ? 'Ride completed'
                      : status == 'CANCELLED'
                          ? 'Ride cancelled'
                          : status == 'IN_PROGRESS'
                              ? 'On the way to the destination'
                              : status == 'DRIVER_ASSIGNED' || status == 'ACCEPTED'
                                  ? 'Driver on the way'
                                  : 'Finding a driver',
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          if (driver != null && driver.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              '$driver · ${ride.driverRating?.toStringAsFixed(1) ?? '5.0'} ★',
              style: TextStyle(
                fontSize: 12,
                color: AppTheme.secondaryDarkText.withValues(alpha: 0.65),
              ),
            ),
          ],
          if (ride.routePlan?.stops.isNotEmpty == true) ...[
            const SizedBox(height: 8),
            Text(
              '${ride.routePlan!.stops.length} stops · ${((ride.distanceMeters ?? 0) / 1609.344).toStringAsFixed(1)} mi · ${((ride.durationSeconds ?? 0) / 60).round()} min',
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: FontWeight.w600,
                color: AppTheme.secondaryDarkText.withValues(alpha: 0.6),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _StopMarker extends StatelessWidget {
  const _StopMarker({
    required this.sequence,
    this.small = false,
    this.completed = false,
  });
  final int sequence;
  final bool small;
  final bool completed;

  @override
  Widget build(BuildContext context) {
    final size = small ? 20.0 : 30.0;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: completed ? AppTheme.successGreen : AppTheme.primaryBrandGreen,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 4,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: completed
          ? Icon(Icons.check, size: small ? 11 : 15, color: Colors.white)
          : Text(
              '$sequence',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w800,
                fontSize: small ? 9 : 12,
              ),
            ),
    );
  }
}

class _DestinationMarker extends StatelessWidget {
  const _DestinationMarker({this.small = false});
  final bool small;

  @override
  Widget build(BuildContext context) {
    final size = small ? 20.0 : 34.0;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: const Color(0xFF2F3A32),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
      ),
      alignment: Alignment.center,
      child: Icon(Icons.flag_rounded, size: small ? 11 : 17, color: Colors.white),
    );
  }
}

class _DriverMarker extends StatelessWidget {
  const _DriverMarker();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        color: Colors.white,
        shape: BoxShape.circle,
        border: Border.all(color: AppTheme.primaryBrandGreen, width: 2),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      alignment: Alignment.center,
      child: const Icon(Icons.local_taxi_rounded, size: 18, color: AppTheme.primaryBrandGreen),
    );
  }
}
