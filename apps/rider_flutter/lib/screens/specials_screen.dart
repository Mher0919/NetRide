// lib/screens/specials_screen.dart
//
// SPECIALS — the dedicated discovery page (bottom-nav destination between
// Explore and Activity).
//
//   • Uber-Eats-style vertical feed: photo · discount · name · category ·
//     distance · rating · price level.
//   • Filters on top: type (category), distance, rating and price.
//   • Paginated: the next page loads as the rider scrolls (never all at
//     once), with skeleton placeholders while loading.
//   • Zero eligible specials from the backend → the whole screen says
//     "Coming Soon!".
//
// Tapping a card opens the SAME SpecialBusinessSheet as everywhere else.

import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/special_models.dart';
import '../providers/specials_provider.dart';
import '../services/specials_service.dart';
import '../widgets/special_business_sheet.dart';
import '../widgets/special_card.dart';

class SpecialsScreen extends StatefulWidget {
  const SpecialsScreen({super.key});

  @override
  State<SpecialsScreen> createState() => _SpecialsScreenState();
}

class _SpecialsScreenState extends State<SpecialsScreen> {
  static const int _pageSize = 6;

  final ScrollController _scrollController = ScrollController();

  List<SponsorSpecial> _items = [];
  int _offset = 0;
  bool _hasMore = true;
  bool _loadingInitial = true;
  bool _loadingMore = false;
  String? _error;

  // Filters (client-side over the loaded pages).
  String? _category;
  int? _distanceMiles;
  double? _minRating;
  String? _priceLevel;

  bool get _hasActiveFilters =>
      _category != null ||
      _distanceMiles != null ||
      _minRating != null ||
      _priceLevel != null;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    context.read<SpecialsProvider>().addListener(_onProviderChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final specials = context.read<SpecialsProvider>();
      if (!specials.loaded) specials.refresh();
      _loadFirstPage();
    });
  }

  @override
  void dispose() {
    context.read<SpecialsProvider>().removeListener(_onProviderChanged);
    _scrollController.dispose();
    super.dispose();
  }

  /// Fallback for a cold/failed page load: the provider's authoritative
  /// active-special list (already used by Explore) seeds this page instead
  /// of leaving it stuck on "Coming Soon".
  void _onProviderChanged() {
    if (!mounted || _items.isNotEmpty) return;
    if (_loadingInitial || _loadingMore) return;
    final specials = context.read<SpecialsProvider>();
    if (!specials.loaded || specials.sponsors.isEmpty) return;
    setState(() {
      _items = List<SponsorSpecial>.of(specials.sponsors);
      _offset = _items.length;
      _hasMore = false;
      _error = null;
    });
    _warmPhotos();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    if (position.pixels >= position.maxScrollExtent - 360) {
      _loadNextPage();
    }
  }

  Future<void> _loadFirstPage() async {
    setState(() {
      _loadingInitial = true;
      _loadingMore = false;
      _error = null;
      _items = [];
      _offset = 0;
      _hasMore = true;
    });
    await _fetchPage();
    if (!mounted) return;
    setState(() => _loadingInitial = false);
    _onProviderChanged();
  }

  Future<void> _loadNextPage() async {
    if (_loadingInitial || _loadingMore || !_hasMore) return;
    await _fetchPage();
  }

  Future<void> _fetchPage() async {
    setState(() => _loadingMore = true);
    final specials = context.read<SpecialsProvider>();
    try {
      final page = await SpecialsService.list(
        limit: _pageSize,
        offset: _offset,
        lat: specials.geoLat,
        lng: specials.geoLng,
      );
      if (!mounted) return;
      setState(() {
        _items = [..._items, ...page];
        _offset += page.length;
        _hasMore = page.length >= _pageSize;
        _loadingMore = false;
      });
      _warmPhotos();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingMore = false;
        _hasMore = false;
        if (_items.isEmpty) _error = 'Could not load specials. Pull to retry.';
      });
    }
  }

  /// Best-effort: warms Google photos for the cards so real imagery (not the
  /// gradient fallback) renders as the rider scrolls.
  void _warmPhotos() {
    final specials = context.read<SpecialsProvider>();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) specials.hydrateCardPhotos(_items);
    });
  }

  double? _ratingFor(SponsorSpecial s) {
    final business = context
        .read<SpecialsProvider>()
        .businessFor(s.id)
        ?.business;
    return business?.rating ?? s.adminRating;
  }

  List<SponsorSpecial> get _visibleItems {
    Iterable<SponsorSpecial> items = _items;
    if (_category != null) {
      items = items.where(
        (s) => specialCategoryLabel(s.businessType) == _category,
      );
    }
    if (_distanceMiles != null) {
      items = items.where((s) {
        final km = s.kmAway;
        if (km == null) return false;
        return km * 0.621371 <= _distanceMiles!;
      });
    }
    if (_minRating != null) {
      items = items.where((s) {
        final rating = _ratingFor(s);
        return rating != null && rating >= _minRating!;
      });
    }
    if (_priceLevel != null) {
      items = items.where((s) => (s.priceLevel ?? '') == _priceLevel);
    }
    return items.toList();
  }

  List<String> get _categories {
    final set = <String>{};
    for (final s in _items) {
      set.add(specialCategoryLabel(s.businessType));
    }
    final list = set.toList()..sort();
    return list;
  }

  void _clearFilters() {
    setState(() {
      _category = null;
      _distanceMiles = null;
      _minRating = null;
      _priceLevel = null;
    });
  }

  Future<void> _pickDistance() async {
    final value = await _pickOption<int?>(
      title: 'Distance',
      options: const [
        (null, 'Any distance'),
        (1, 'Under 1 mi'),
        (3, 'Under 3 mi'),
        (5, 'Under 5 mi'),
        (10, 'Under 10 mi'),
        (25, 'Under 25 mi'),
      ],
      selected: _distanceMiles,
    );
    if (!mounted) return;
    setState(() => _distanceMiles = value);
  }

  Future<void> _pickRating() async {
    final value = await _pickOption<double?>(
      title: 'Rating',
      options: const [
        (null, 'Any rating'),
        (3.0, '3.0+'),
        (4.0, '4.0+'),
        (4.5, '4.5+'),
      ],
      selected: _minRating,
    );
    if (!mounted) return;
    setState(() => _minRating = value);
  }

  Future<void> _pickPrice() async {
    final value = await _pickOption<String?>(
      title: 'Price',
      options: const [
        (null, 'Any price'),
        (r'$', r'$  Inexpensive'),
        (r'$$', r'$$ Moderate'),
        (r'$$$', r'$$$  Pricey'),
        (r'$$$$', r'$$$$  Very pricey'),
      ],
      selected: _priceLevel,
    );
    if (!mounted) return;
    setState(() => _priceLevel = value);
  }

  Future<T?> _pickOption<T>({
    required String title,
    required List<(T, String)> options,
    required T selected,
  }) {
    return showModalBottomSheet<T>(
      context: context,
      backgroundColor: const Color(0xFFF7F4EF),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
                child: Text(
                  title,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF2F3A32),
                  ),
                ),
              ),
              for (final (value, label) in options)
                ListTile(
                  onTap: () => Navigator.pop(ctx, value),
                  leading: Icon(
                    value == selected
                        ? Icons.radio_button_checked
                        : Icons.radio_button_off,
                    color: value == selected
                        ? const Color(0xFF5B7760)
                        : const Color(0xFF2F3A32).withValues(alpha: 0.3),
                    size: 22,
                  ),
                  title: Text(
                    label,
                    style: TextStyle(
                      fontSize: 14.5,
                      fontWeight: value == selected
                          ? FontWeight.w700
                          : FontWeight.w500,
                      color: const Color(0xFF2F3A32),
                    ),
                  ),
                ),
              const SizedBox(height: 8),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    // Re-render rating filters when Google info for a card lands.
    context.watch<SpecialsProvider>();

    return Scaffold(
      backgroundColor: const Color(0xFFF7F4EF),
      body: SafeArea(
        child: RefreshIndicator(
          color: const Color(0xFF5B7760),
          onRefresh: _loadFirstPage,
          child: _buildBody(),
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loadingInitial) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 32),
        children: const [
          _HeaderSkeleton(),
          SizedBox(height: 16),
          _SpecialSkeletonTile(),
          _SpecialSkeletonTile(),
          _SpecialSkeletonTile(),
          _SpecialSkeletonTile(),
        ],
      );
    }

    // Backend-authoritative: zero eligible specials → Coming Soon.
    if (_items.isEmpty && !_hasActiveFilters && _error == null) {
      return const _ComingSoonView();
    }

    final visible = _visibleItems;
    final categories = _categories;

    return ListView(
      controller: _scrollController,
      physics: const AlwaysScrollableScrollPhysics(
        parent: BouncingScrollPhysics(),
      ),
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 32),
      children: [
        const _Header(),
        const SizedBox(height: 14),
        _FilterBar(
          categories: categories,
          selectedCategory: _category,
          distanceMiles: _distanceMiles,
          minRating: _minRating,
          priceLevel: _priceLevel,
          hasActiveFilters: _hasActiveFilters,
          onCategory: (c) => setState(() {
            final value = c.isEmpty ? null : c;
            _category = _category == value ? null : value;
          }),
          onDistance: _pickDistance,
          onRating: _pickRating,
          onPrice: _pickPrice,
          onClear: _clearFilters,
        ),
        const SizedBox(height: 14),
        if (visible.isEmpty)
          _NoMatches(onClear: _clearFilters)
        else
          for (final s in visible) _SpecialListTile(sponsor: s),
        if (_error != null) ...[
          const SizedBox(height: 12),
          _ErrorNote(message: _error!, onRetry: _loadFirstPage),
        ] else if (_loadingMore) ...[
          const _SpecialSkeletonTile(),
          const _SpecialSkeletonTile(),
        ] else if (_hasMore) ...[
          const SizedBox(height: 12),
          const Center(
            child: SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Color(0xFF5B7760),
              ),
            ),
          ),
        ] else if (_items.isNotEmpty) ...[
          const SizedBox(height: 14),
          Center(
            child: Text(
              'That\'s every special nearby.',
              style: TextStyle(
                fontSize: 12,
                color: const Color(0xFF2F3A32).withValues(alpha: 0.45),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Header + filters
// ---------------------------------------------------------------------------

class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Specials',
          style: TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.6,
            color: Color(0xFF2F3A32),
          ),
        ),
        const SizedBox(height: 3),
        Text(
          'Ride to a deal place — the discount comes off automatically.',
          style: TextStyle(
            fontSize: 13,
            color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
          ),
        ),
      ],
    );
  }
}

class _HeaderSkeleton extends StatelessWidget {
  const _HeaderSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SkeletonBox(width: 150, height: 30, radius: 10),
        SizedBox(height: 8),
        _SkeletonBox(width: 260, height: 14, radius: 7),
        SizedBox(height: 16),
        _SkeletonBox(height: 36, radius: 30),
      ],
    );
  }
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.categories,
    required this.selectedCategory,
    required this.distanceMiles,
    required this.minRating,
    required this.priceLevel,
    required this.hasActiveFilters,
    required this.onCategory,
    required this.onDistance,
    required this.onRating,
    required this.onPrice,
    required this.onClear,
  });

  final List<String> categories;
  final String? selectedCategory;
  final int? distanceMiles;
  final double? minRating;
  final String? priceLevel;
  final bool hasActiveFilters;
  final ValueChanged<String> onCategory;
  final VoidCallback onDistance;
  final VoidCallback onRating;
  final VoidCallback onPrice;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              _FilterPill(
                icon: Icons.near_me_rounded,
                label: distanceMiles == null
                    ? 'Distance'
                    : 'Under $distanceMiles mi',
                active: distanceMiles != null,
                onTap: onDistance,
              ),
              const SizedBox(width: 8),
              _FilterPill(
                icon: Icons.star_rounded,
                label: minRating == null
                    ? 'Rating'
                    : '${minRating!.toStringAsFixed(1)}+',
                active: minRating != null,
                onTap: onRating,
              ),
              const SizedBox(width: 8),
              _FilterPill(
                icon: Icons.payments_rounded,
                label: priceLevel ?? 'Price',
                active: priceLevel != null,
                onTap: onPrice,
              ),
              if (hasActiveFilters) ...[
                const SizedBox(width: 8),
                _FilterPill(
                  icon: Icons.close_rounded,
                  label: 'Clear',
                  active: false,
                  onTap: onClear,
                ),
              ],
            ],
          ),
        ),
        if (categories.isNotEmpty) ...[
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _CategoryChip(
                  label: 'All',
                  selected: selectedCategory == null,
                  onTap: () => onCategory(''),
                ),
                for (final c in categories) ...[
                  const SizedBox(width: 8),
                  _CategoryChip(
                    label: c,
                    selected: selectedCategory == c,
                    onTap: () => onCategory(c),
                  ),
                ],
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _FilterPill extends StatelessWidget {
  const _FilterPill({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? const Color(0xFF5B7760) : Colors.white,
      borderRadius: BorderRadius.circular(30),
      child: InkWell(
        borderRadius: BorderRadius.circular(30),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(30),
            border: Border.all(
              color: active ? const Color(0xFF5B7760) : const Color(0xFFD8D2CA),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 14,
                color: active ? Colors.white : const Color(0xFF5B7760),
              ),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: active ? Colors.white : const Color(0xFF2F3A32),
                ),
              ),
              const SizedBox(width: 2),
              Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 16,
                color: active
                    ? Colors.white
                    : const Color(0xFF2F3A32).withValues(alpha: 0.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? const Color(0xFF2F3A32) : Colors.white,
      borderRadius: BorderRadius.circular(30),
      child: InkWell(
        borderRadius: BorderRadius.circular(30),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(30),
            border: Border.all(
              color: selected
                  ? const Color(0xFF2F3A32)
                  : const Color(0xFFD8D2CA),
            ),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: selected ? Colors.white : const Color(0xFF2F3A32),
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// List tile
// ---------------------------------------------------------------------------

class _SpecialListTile extends StatelessWidget {
  const _SpecialListTile({required this.sponsor});

  final SponsorSpecial sponsor;

  String? _imageUrl(SpecialsProvider specials) => specialPrimaryImageUrl(
    sponsor,
    specials.businessFor(sponsor.id)?.business,
  );

  @override
  Widget build(BuildContext context) {
    final specials = context.watch<SpecialsProvider>();
    final business = specials.businessFor(sponsor.id)?.business;
    final rating = business?.rating ?? sponsor.adminRating;
    final imageUrl = _imageUrl(specials);
    final meta =
        '${specialCategoryLabel(sponsor.businessType)} · ${specialDistanceLabel(sponsor)}'
        '${sponsor.priceLevel != null ? ' · ${sponsor.priceLevel}' : ''}';

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE3DDD4)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.05),
            blurRadius: 12,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(20),
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: () => SpecialBusinessSheet.show(context, sponsor: sponsor),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: SizedBox(
                    width: 96,
                    height: 96,
                    child: imageUrl != null
                        ? CachedNetworkImage(
                            imageUrl: imageUrl,
                            fit: BoxFit.cover,
                            fadeInDuration: const Duration(milliseconds: 240),
                            placeholder: (_, _) => _fallback(),
                            errorWidget: (_, _, _) => _fallback(),
                          )
                        : _fallback(),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        sponsor.businessName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -0.2,
                          color: Color(0xFF2F3A32),
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        meta,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 9,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xFF5B7760),
                              borderRadius: BorderRadius.circular(30),
                            ),
                            child: Text(
                              specialDiscountLabel(sponsor).toUpperCase(),
                              style: const TextStyle(
                                fontSize: 10.5,
                                fontWeight: FontWeight.w900,
                                letterSpacing: 0.3,
                                color: Colors.white,
                              ),
                            ),
                          ),
                          if (rating != null && rating > 0) ...[
                            const SizedBox(width: 8),
                            const Icon(
                              Icons.star_rounded,
                              size: 14,
                              color: Color(0xFFE8A33D),
                            ),
                            const SizedBox(width: 2),
                            Text(
                              rating.toStringAsFixed(1),
                              style: const TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF2F3A32),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
                const Icon(
                  Icons.chevron_right_rounded,
                  color: Color(0xFF9AA79E),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _fallback() {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF6E8B74), Color(0xFF2F3A32)],
        ),
      ),
      child: Center(
        child: Icon(
          specialTypeIcon(sponsor.businessType),
          size: 30,
          color: Colors.white.withValues(alpha: 0.35),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

class _NoMatches extends StatelessWidget {
  const _NoMatches({required this.onClear});

  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Column(
        children: [
          Icon(
            Icons.filter_alt_off_rounded,
            size: 36,
            color: const Color(0xFF2F3A32).withValues(alpha: 0.3),
          ),
          const SizedBox(height: 10),
          const Text(
            'No specials match your filters',
            style: TextStyle(
              fontSize: 14.5,
              fontWeight: FontWeight.w700,
              color: Color(0xFF2F3A32),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Try widening the distance or clearing a filter.',
            style: TextStyle(
              fontSize: 12.5,
              color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: onClear,
            style: OutlinedButton.styleFrom(
              foregroundColor: const Color(0xFF5B7760),
              side: const BorderSide(color: Color(0xFF5B7760)),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(30),
              ),
            ),
            child: const Text('Clear filters'),
          ),
        ],
      ),
    );
  }
}

class _ErrorNote extends StatelessWidget {
  const _ErrorNote({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Row(
        children: [
          const Icon(Icons.cloud_off_rounded, color: Color(0xFFB26A00)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(fontSize: 12.5, color: Color(0xFF2F3A32)),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _ComingSoonView extends StatelessWidget {
  const _ComingSoonView();

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Container(
                      width: 96,
                      height: 96,
                      decoration: BoxDecoration(
                        color: const Color(0xFF5B7760).withValues(alpha: 0.12),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.local_offer_rounded,
                        size: 44,
                        color: Color(0xFF5B7760),
                      ),
                    ),
                    const SizedBox(height: 22),
                    const Text(
                      'Coming Soon!',
                      style: TextStyle(
                        fontSize: 26,
                        fontWeight: FontWeight.w800,
                        letterSpacing: -0.5,
                        color: Color(0xFF2F3A32),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'There are no specials near you right now.\nGreat deals are on the way — check back soon.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.45,
                        color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

class _SpecialSkeletonTile extends StatelessWidget {
  const _SpecialSkeletonTile();

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: const Row(
        children: [
          _SkeletonBox(width: 96, height: 96, radius: 14),
          SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SkeletonBox(width: 150, height: 16, radius: 8),
                SizedBox(height: 8),
                _SkeletonBox(width: 110, height: 12, radius: 6),
                SizedBox(height: 10),
                _SkeletonBox(width: 80, height: 18, radius: 20),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SkeletonBox extends StatefulWidget {
  const _SkeletonBox({this.width, required this.height, this.radius = 12});

  final double? width;
  final double height;
  final double radius;

  @override
  State<_SkeletonBox> createState() => _SkeletonBoxState();
}

class _SkeletonBoxState extends State<_SkeletonBox>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
      lowerBound: 0.45,
      upperBound: 1.0,
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _pulse,
      child: Container(
        width: widget.width,
        height: widget.height,
        decoration: BoxDecoration(
          color: const Color(0xFFE3DDD4),
          borderRadius: BorderRadius.circular(widget.radius),
        ),
      ),
    );
  }
}
