// lib/widgets/special_business_sheet.dart
//
// SpecialBusinessSheet — the ONE business detail experience shared by the
// Special card and the map marker (spec §13). It is a native draggable
// bottom sheet, never a separate page:
//
//   • the map stays visible behind it
//   • snap points: collapsed (~46%) ↔ expanded (~92%), swipe to switch
//   • swipe down from the collapsed snap dismisses it
//
// Content ordering follows spec §19 — Special first, then identity/rating,
// then address/hours/photos/reviews/actions. Google data loads in tiers:
// basic identity immediately, full details (hours/phone/website/reviews)
// when the sheet expands. Every Google field is optional; missing fields
// hide their section instead of faking data.

import 'dart:async';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/google_business.dart';
import '../models/special_models.dart';
import '../providers/specials_provider.dart';
import '../services/ride_intent.dart';
import '../utils/file_url.dart';
import 'special_card.dart';

class SpecialBusinessSheet extends StatefulWidget {
  const SpecialBusinessSheet({super.key, required this.sponsor});

  final SponsorSpecial sponsor;

  /// Opens the sheet for [sponsor] from either entry point. Selection goes
  /// into the provider (the single source of truth) so the map marker and
  /// the card highlight stay synchronized; closing clears it.
  static Future<void> show(
    BuildContext context, {
    required SponsorSpecial sponsor,
  }) async {
    final specials = context.read<SpecialsProvider>();
    specials.selectSpecial(sponsor.id);
    unawaited(specials.ensureBusiness(sponsor.id));
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black.withValues(alpha: 0.18),
      builder: (_) => SpecialBusinessSheet(sponsor: sponsor),
    );
    specials.clearSelection();
  }

  @override
  State<SpecialBusinessSheet> createState() => _SpecialBusinessSheetState();
}

class _SpecialBusinessSheetState extends State<SpecialBusinessSheet> {
  final DraggableScrollableController _sheetController =
      DraggableScrollableController();
  bool _fullRequested = false;
  bool _booking = false;

  @override
  void initState() {
    super.initState();
    _sheetController.addListener(_onSheetSizeChanged);
  }

  @override
  void dispose() {
    _sheetController.removeListener(_onSheetSizeChanged);
    _sheetController.dispose();
    super.dispose();
  }

  void _onSheetSizeChanged() {
    double size;
    try {
      size = _sheetController.size;
    } catch (_) {
      return;
    }
    if (size > 0.60) _requestFullDetails();
  }

  void _requestFullDetails() {
    if (_fullRequested) return;
    _fullRequested = true;
    final specials = context.read<SpecialsProvider>();
    if (specials.businessFor(widget.sponsor.id)?.manual == true) return;
    unawaited(specials.ensureFullBusiness(widget.sponsor.id));
  }

  Future<void> _rideThere() async {
    final s = widget.sponsor;
    if (_booking || s.latitude == null || s.longitude == null) return;
    setState(() => _booking = true);
    final specials = context.read<SpecialsProvider>();
    final messenger = ScaffoldMessenger.of(context);
    try {
      await specials.pickSponsor(s.id);
      if (!mounted) return;
      RideIntent.instance.startSpecialRide(
        SpecialRideIntent(
          lat: s.latitude!,
          lng: s.longitude!,
          address: s.address ?? s.businessName,
          sponsorName: s.businessName,
          discountLabel: specialDiscountLabel(s),
        ),
      );
      Navigator.of(context).pop();
    } catch (_) {
      if (!mounted) return;
      setState(() => _booking = false);
      messenger.showSnackBar(
        SnackBar(content: Text(specials.error ?? 'Please try again.')),
      );
    }
  }

  Future<void> _openExternal(String url) async {
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    if (!await canLaunchUrl(uri)) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final specials = context.watch<SpecialsProvider>();
    final result = specials.businessFor(widget.sponsor.id);
    final business = result?.business;
    final loading = result == null && specials.businessLoading(widget.sponsor.id);
    final manual = result?.manual == true;
    final googleDown = result != null && !result.googleAvailable && !manual;

    return DraggableScrollableSheet(
      controller: _sheetController,
      initialChildSize: 0.46,
      minChildSize: 0.30,
      maxChildSize: 0.92,
      snap: true,
      snapSizes: const [0.46, 0.92],
      builder: (context, scrollController) {
        return Container(
          decoration: const BoxDecoration(
            color: Color(0xFFF7F4EF),
            borderRadius: BorderRadius.vertical(top: Radius.circular(26)),
            boxShadow: [
              BoxShadow(
                color: Color(0x33000000),
                blurRadius: 24,
                offset: Offset(0, -6),
              ),
            ],
          ),
          clipBehavior: Clip.antiAlias,
          child: CustomScrollView(
            controller: scrollController,
            physics: const BouncingScrollPhysics(),
            slivers: [
              SliverToBoxAdapter(
                child: _buildHandle(context),
              ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildHero(context, business, loading),
                      const SizedBox(height: 14),
                      _buildIdentity(context, business, loading),
                      const SizedBox(height: 16),
                      _buildSpecialSection(context),
                      if (manual) ...[
                        const SizedBox(height: 16),
                        _buildManualNote(context),
                      ] else if (googleDown) ...[
                        const SizedBox(height: 16),
                        _buildGoogleUnavailableNote(context),
                      ],
                      if (business != null) ...[
                        const SizedBox(height: 20),
                        _buildBusinessInfo(context, business),
                        if (business.photos.length > 1) ...[
                          const SizedBox(height: 20),
                          _buildGallery(context, business),
                        ],
                        if (business.hasReviews) ...[
                          const SizedBox(height: 20),
                          _buildReviews(context, business),
                        ],
                      ] else if (loading) ...[
                        const SizedBox(height: 20),
                        _buildInfoSkeleton(context),
                      ],
                      const SizedBox(height: 28),
                      _buildFooter(context),
                      const SizedBox(height: 18),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildHandle(BuildContext context) {
    return Semantics(
      label: 'Business details. Swipe up for more information.',
      container: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onVerticalDragEnd: (details) {
          // Swiping down on the handle dismisses the sheet (the content drag
          // handles collapse/expand between the snap points).
          if ((details.primaryVelocity ?? 0) > 260) {
            Navigator.of(context).maybePop();
          }
        },
        child: Stack(
          alignment: Alignment.topCenter,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 10, bottom: 12),
              child: Container(
                width: 44,
                height: 4,
                decoration: BoxDecoration(
                  color: const Color(0xFFD8D2CA),
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
            Positioned(
              right: 12,
              top: 4,
              child: IconButton(
                icon: const Icon(Icons.close_rounded, size: 20),
                tooltip: 'Close',
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHero(
    BuildContext context,
    GoogleBusiness? business,
    bool loading,
  ) {
    final s = widget.sponsor;
    final googlePhoto =
        business != null && business.photos.isNotEmpty ? business.photos.first : null;
    final cover = s.coverImageUrl;
    final url = googlePhoto != null
        ? resolveApiUrl(googlePhoto.url.isNotEmpty ? googlePhoto.url : googlePhoto.thumbUrl)
        : (cover != null && cover.isNotEmpty ? resolveFileUrl(cover) : null);

    return ClipRRect(
      borderRadius: BorderRadius.circular(18),
      child: SizedBox(
        height: 168,
        width: double.infinity,
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (url != null)
              CachedNetworkImage(
                imageUrl: url,
                fit: BoxFit.cover,
                fadeInDuration: const Duration(milliseconds: 260),
                placeholder: (_, _) => _heroFallback(),
                errorWidget: (_, _, _) => _heroFallback(),
              )
            else if (loading)
              const _SkeletonBox(height: 168, radius: 0)
            else
              _heroFallback(),
            if (googlePhoto?.attributionName != null)
              Positioned(
                left: 8,
                bottom: 8,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    color: Colors.black.withValues(alpha: 0.55),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    googlePhoto!.attributionName!,
                    style: const TextStyle(fontSize: 10, color: Colors.white),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _heroFallback() {
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
          specialTypeIcon(widget.sponsor.businessType),
          size: 44,
          color: Colors.white.withValues(alpha: 0.35),
        ),
      ),
    );
  }

  Widget _buildIdentity(
    BuildContext context,
    GoogleBusiness? business,
    bool loading,
  ) {
    final s = widget.sponsor;
    final name = business?.name ?? s.businessName;
    final rating = business?.rating;
    final reviewCount = business?.reviewCount;
    final category = business?.category ?? specialCategoryLabel(s.businessType);
    final openNow = business?.openNow;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(
                name,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                  color: Color(0xFF2F3A32),
                  height: 1.15,
                ),
              ),
            ),
            if (openNow != null)
              Container(
                margin: const EdgeInsets.only(left: 8, top: 3),
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                decoration: BoxDecoration(
                  color: openNow ? const Color(0xFFE5F0EB) : const Color(0xFFFCE9E9),
                  borderRadius: BorderRadius.circular(30),
                ),
                child: Text(
                  openNow ? 'Open' : 'Closed',
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    color: openNow ? const Color(0xFF2E7D32) : const Color(0xFFC65A5A),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            if (rating != null && rating > 0) ...[
              const Icon(Icons.star_rounded, size: 16, color: Color(0xFFE8A33D)),
              const SizedBox(width: 3),
              Text(
                rating.toStringAsFixed(1),
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF2F3A32),
                ),
              ),
              if (reviewCount != null && reviewCount > 0) ...[
                const SizedBox(width: 5),
                Text(
                  '· ${reviewCountLabel(reviewCount)}',
                  style: TextStyle(
                    fontSize: 12.5,
                    color: const Color(0xFF2F3A32).withValues(alpha: 0.6),
                  ),
                ),
              ],
              const SizedBox(width: 8),
            ],
            if (loading && rating == null)
              const _SkeletonBox(width: 110, height: 14, radius: 6),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
              decoration: BoxDecoration(
                color: const Color(0xFF2F3A32).withValues(alpha: 0.06),
                borderRadius: BorderRadius.circular(30),
              ),
              child: Text(
                category,
                style: const TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF2F3A32),
                ),
              ),
            ),
            if (business?.priceLevel != null) ...[
              const SizedBox(width: 8),
              Text(
                business!.priceLevel!,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: const Color(0xFF2F3A32).withValues(alpha: 0.55),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _buildSpecialSection(BuildContext context) {
    final s = widget.sponsor;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF5B7760),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.local_offer_rounded, size: 15, color: Colors.white70),
              const SizedBox(width: 6),
              Text(
                'SPECIAL',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 1.1,
                  color: Colors.white.withValues(alpha: 0.85),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            specialDiscountLabel(s),
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w900,
              letterSpacing: -0.5,
              color: Colors.white,
            ),
          ),
          if (s.businessDescription?.isNotEmpty ?? false) ...[
            const SizedBox(height: 6),
            Text(
              s.businessDescription!,
              style: TextStyle(
                fontSize: 13,
                height: 1.4,
                color: Colors.white.withValues(alpha: 0.9),
              ),
            ),
          ],
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            height: 48,
            child: FilledButton.icon(
              onPressed: _booking ? null : _rideThere,
              style: FilledButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: const Color(0xFF2F3A32),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(30),
                ),
              ),
              icon: _booking
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.directions_car_filled_rounded, size: 19),
              label: Text(
                _booking ? 'Getting your ride ready…' : 'Book a ride to this place',
                style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Your discount is attached to the ride automatically — no promo code needed.',
            style: TextStyle(
              fontSize: 11,
              color: Colors.white.withValues(alpha: 0.75),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildManualNote(BuildContext context) {
    return _noteCard(
      icon: Icons.storefront_rounded,
      color: const Color(0xFF6E8B74),
      title: 'Business info from Netride',
      body: 'This Special was provided by the business. Google business information is not linked.',
    );
  }

  Widget _buildGoogleUnavailableNote(BuildContext context) {
    return _noteCard(
      icon: Icons.cloud_off_rounded,
      color: const Color(0xFFB26A00),
      title: 'Business information is currently unavailable.',
      body: 'The Special is still valid — pull the map pin for directions.',
    );
  }

  Widget _noteCard({
    required IconData icon,
    required Color color,
    required String title,
    required String body,
  }) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF2F3A32),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.35,
                    color: const Color(0xFF2F3A32).withValues(alpha: 0.62),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildBusinessInfo(BuildContext context, GoogleBusiness business) {
    final s = widget.sponsor;
    final address =
        (business.address?.isNotEmpty ?? false) ? business.address : s.address;
    final phone = business.phone;
    final website = business.website;
    final hasActions = (business.latitude != null && business.longitude != null) ||
        (s.latitude != null && s.longitude != null) ||
        phone != null ||
        website != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionTitle('Business information'),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: const Color(0xFFE3DDD4)),
          ),
          child: Column(
            children: [
              if (address != null && address.isNotEmpty)
                _InfoRow(
                  icon: Icons.location_on_rounded,
                  text: address,
                ),
              if (business.hasHours)
                _InfoRow(
                  icon: Icons.schedule_rounded,
                  text: _todayHours(business),
                  trailing: business.openNow == null
                      ? null
                      : Text(
                          business.openNow! ? 'Open now' : 'Closed now',
                          style: TextStyle(
                            fontSize: 11.5,
                            fontWeight: FontWeight.w700,
                            color: business.openNow!
                                ? const Color(0xFF2E7D32)
                                : const Color(0xFFC65A5A),
                          ),
                        ),
                ),
              if (phone != null && phone.isNotEmpty)
                _InfoRow(icon: Icons.call_rounded, text: phone),
              if (website != null && website.isNotEmpty)
                _InfoRow(icon: Icons.language_rounded, text: _prettyUrl(website)),
            ],
          ),
        ),
        if (hasActions) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              if (s.latitude != null || business.latitude != null)
                Expanded(
                  child: _ActionButton(
                    icon: Icons.directions_rounded,
                    label: 'Directions',
                    onTap: () {
                      final lat = business.latitude ?? s.latitude;
                      final lng = business.longitude ?? s.longitude;
                      if (lat == null || lng == null) return;
                      _openExternal(
                        'https://www.google.com/maps/dir/?api=1&destination=$lat,$lng',
                      );
                    },
                  ),
                ),
              if (phone != null && phone.isNotEmpty) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: _ActionButton(
                    icon: Icons.call_rounded,
                    label: 'Call',
                    onTap: () => _openExternal('tel:${phone.replaceAll(' ', '')}'),
                  ),
                ),
              ],
              if (website != null && website.isNotEmpty) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: _ActionButton(
                    icon: Icons.language_rounded,
                    label: 'Website',
                    onTap: () => _openExternal(website),
                  ),
                ),
              ],
            ],
          ),
        ],
        if (business.googleMapsUri != null) ...[
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () => _openExternal(business.googleMapsUri!),
              icon: const Icon(Icons.map_rounded, size: 16),
              label: const Text('View on Google Maps'),
              style: TextButton.styleFrom(
                foregroundColor: const Color(0xFF5B7760),
                textStyle: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildGallery(BuildContext context, GoogleBusiness business) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionTitle('Photos'),
        const SizedBox(height: 10),
        SizedBox(
          height: 104,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: business.photos.length - 1,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (context, i) {
              final photo = business.photos[i + 1];
              final url = resolveApiUrl(
                photo.thumbUrl.isNotEmpty ? photo.thumbUrl : photo.url,
              );
              return Semantics(
                image: true,
                label: photo.attributionName != null
                    ? 'Photo by ${photo.attributionName}'
                    : 'Business photo',
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: CachedNetworkImage(
                    imageUrl: url,
                    width: 140,
                    height: 104,
                    fit: BoxFit.cover,
                    placeholder: (_, _) => const _SkeletonBox(width: 140, height: 104, radius: 0),
                    errorWidget: (_, _, _) => const SizedBox(
                      width: 140,
                      height: 104,
                      child: _SkeletonBox(width: 140, height: 104, radius: 0),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 6),
        const _GoogleAttribution(),
      ],
    );
  }

  Widget _buildReviews(BuildContext context, GoogleBusiness business) {
    final rating = business.rating;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const _SectionTitle('Reviews'),
            const Spacer(),
            if (rating != null && rating > 0) ...[
              const Icon(Icons.star_rounded, size: 16, color: Color(0xFFE8A33D)),
              const SizedBox(width: 2),
              Text(
                rating.toStringAsFixed(1),
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w800,
                  color: Color(0xFF2F3A32),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 10),
        for (final review in business.reviews.take(3)) ...[
          _ReviewTile(review: review),
          const SizedBox(height: 8),
        ],
        const SizedBox(height: 2),
        const _GoogleAttribution(),
      ],
    );
  }

  Widget _buildInfoSkeleton(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SkeletonBox(width: 140, height: 14, radius: 6),
        const SizedBox(height: 12),
        const _SkeletonBox(height: 54, radius: 12),
        const SizedBox(height: 8),
        const _SkeletonBox(height: 54, radius: 12),
      ],
    );
  }

  Widget _buildFooter(BuildContext context) {
    return Center(
      child: Text(
        'Special provided by the business. Google business data © Google.',
        textAlign: TextAlign.center,
        style: TextStyle(
          fontSize: 10.5,
          color: const Color(0xFF2F3A32).withValues(alpha: 0.45),
        ),
      ),
    );
  }

  String _todayHours(GoogleBusiness business) {
    final now = DateTime.now();
    final index = now.weekday - 1; // Monday = 0 in Google's list
    if (index >= 0 && index < business.weekdayDescriptions.length) {
      final line = business.weekdayDescriptions[index];
      final colon = line.indexOf(':');
      return colon >= 0 ? line.substring(colon + 1).trim() : line;
    }
    return 'See Google Maps for hours';
  }

  String _prettyUrl(String url) {
    final cleaned = url.replaceFirst(RegExp(r'^https?://'), '');
    return cleaned.endsWith('/')
        ? cleaned.substring(0, cleaned.length - 1)
        : cleaned;
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        fontSize: 14.5,
        fontWeight: FontWeight.w800,
        color: Color(0xFF2F3A32),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.text, this.trailing});
  final IconData icon;
  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(
        children: [
          Icon(icon, size: 17, color: const Color(0xFF5B7760)),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 13, color: Color(0xFF2F3A32)),
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

class _ActionButton extends StatelessWidget {
  const _ActionButton({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          height: 44,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: const Color(0xFFD8D2CA)),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 16, color: const Color(0xFF5B7760)),
              const SizedBox(width: 6),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF2F3A32),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReviewTile extends StatelessWidget {
  const _ReviewTile({required this.review});
  final GoogleBusinessReview review;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFE3DDD4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 13,
                backgroundColor: const Color(0xFFE5F0EB),
                backgroundImage: review.authorPhotoUrl != null
                    ? NetworkImage(review.authorPhotoUrl!)
                    : null,
                child: review.authorPhotoUrl == null
                    ? Text(
                        review.authorName.isNotEmpty
                            ? review.authorName[0].toUpperCase()
                            : 'G',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          color: Color(0xFF5B7760),
                        ),
                      )
                    : null,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  review.authorName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF2F3A32),
                  ),
                ),
              ),
              Text(
                review.relativeTime,
                style: TextStyle(
                  fontSize: 11,
                  color: const Color(0xFF2F3A32).withValues(alpha: 0.5),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              for (var i = 0; i < 5; i++)
                Icon(
                  i < review.rating.round()
                      ? Icons.star_rounded
                      : Icons.star_outline_rounded,
                  size: 14,
                  color: const Color(0xFFE8A33D),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            review.text,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              height: 1.4,
              color: const Color(0xFF2F3A32).withValues(alpha: 0.78),
            ),
          ),
        ],
      ),
    );
  }
}

class _GoogleAttribution extends StatelessWidget {
  const _GoogleAttribution();

  @override
  Widget build(BuildContext context) {
    return Text(
      'Powered by Google',
      style: TextStyle(
        fontSize: 10.5,
        fontWeight: FontWeight.w700,
        color: const Color(0xFF2F3A32).withValues(alpha: 0.45),
      ),
    );
  }
}

/// Soft pulsing placeholder used while Google content loads (spec §20).
class _SkeletonBox extends StatefulWidget {
  const _SkeletonBox({
    this.width,
    required this.height,
    this.radius = 12,
  });

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
